/**
 * Turn the LaTeX the coach writes ($...$, $$...$$, \(...\), \[...\]) into readable plain text for emails,
 * e.g. `$p_1 x_1 + p_2 x_2 = m$` -> `p₁x₁ + p₂x₂ = m`. It covers the usual economics/maths notation and
 * degrades to something readable (never raw backslashes) for anything it doesn't know. Notes in the vault
 * keep their LaTeX; this is only applied to email bodies.
 */

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
/** Symbols that read better with spaces around them (binary operators and relations). */
const SPACED: Record<string, string> = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", equiv: "≡", sim: "∼", propto: "∝", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", leftrightarrow: "↔", implies: "⇒", iff: "⇔", mapsto: "↦", in: "∈", notin: "∉",
  subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", setminus: "∖", land: "∧", lor: "∨", ll: "≪", gg: "≫",
};
/** Symbols that attach to whatever follows them. */
const PREFIX: Record<string, string> = {
  partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", infty: "∞", forall: "∀", exists: "∃", neg: "¬",
  emptyset: "∅", ell: "ℓ", hbar: "ħ", prime: "′", ldots: "…", dots: "…", cdots: "…", vdots: "⋮", degree: "°",
};
/** Function names: written out, followed by a space (`\ln x` -> `ln x`). */
const FUNCS = new Set(["ln", "log", "exp", "sin", "cos", "tan", "max", "min", "lim", "sup", "inf", "arg", "det", "Pr", "E"]);
/** Commands that just wrap text: keep their argument. */
const WRAPPERS = new Set(["text", "mathrm", "mathbf", "mathit", "mathcal", "mathbb", "operatorname", "textbf", "textit", "boldsymbol", "bar", "hat", "tilde", "vec", "overline", "underline", "mbox"]);
const SPACE_CMDS = new Set([",", ";", ":", " ", "quad", "qquad", "!", "\\"]);

const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", i: "ᵢ", j: "ⱼ", k: "ₖ", n: "ₙ", m: "ₘ", t: "ₜ", x: "ₓ", a: "ₐ", e: "ₑ", o: "ₒ",
};
const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", T: "ᵀ", "′": "′", "*": "*",
};

const SP = "\u0001"; // a space that must survive whitespace collapsing (inside \text{...})
const DOLLAR = "\u0002"; // an escaped \$

type Cursor = { s: string; i: number };

/** Read one argument: a {group} (converted recursively) or a single character / command. */
function arg(c: Cursor): string {
  while (c.s[c.i] === " ") c.i++;
  if (c.s[c.i] === "{") { c.i++; return parse(c, true); }
  if (c.s[c.i] === "\\") return command(c);
  return c.i < c.s.length ? c.s[c.i++] : "";
}

/** `x_{12}` -> `x₁₂`; falls back to `x_max` / `x_(a+b)` / `x^2k` style text when there is no Unicode form. */
function script(body: string, map: Record<string, string>, mark: string): string {
  const t = body.replace(/\s/g, "").replace(/−/g, "-");
  if (!t) return "";
  if ([...t].every((ch) => ch in map) && (t.length <= 2 || /^[\d+\-=()]+$/.test(t))) return [...t].map((ch) => map[ch]).join("");
  const plain = mark === "_" ? /^[A-Za-z0-9.]+$/ : /^[A-Za-z0-9]$/; // x_max reads fine; x^(α) needs its brackets
  return plain.test(t) ? `${mark}${t}` : `${mark}(${body.trim()})`;
}

/** The raw text of a {group} (for \text{...}): spaces are kept, nested braces are balanced. */
function rawGroup(c: Cursor): string {
  while (c.s[c.i] === " ") c.i++;
  if (c.s[c.i] !== "{") return c.s[c.i++] ?? "";
  let depth = 0, out = "";
  for (; c.i < c.s.length; c.i++) {
    const ch = c.s[c.i];
    if (ch === "{" && depth++ === 0) continue;
    if (ch === "}" && --depth === 0) { c.i++; break; }
    out += ch;
  }
  return out;
}

function command(c: Cursor): string {
  c.i++; // the backslash
  const m = /^[A-Za-z]+/.exec(c.s.slice(c.i));
  if (!m) { const ch = c.s[c.i++] ?? ""; return SPACE_CMDS.has(ch) ? " " : ch; } // `\,` is a space; `\%`, `\{` ... are the literal character
  const name = m[0];
  c.i += name.length;
  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const [a, b] = [arg(c).trim(), arg(c).trim()];
    const simple = (x: string) => /^[\w.′∂ⁿⁱ²³¹⁰-⁹₀-₉]+$/u.test(x) || /^\(.*\)$/.test(x);
    return `${simple(a) ? a : `(${a})`}/${simple(b) ? b : `(${b})`}`;
  }
  if (name === "sqrt") {
    if (c.s[c.i] === "[") { const end = c.s.indexOf("]", c.i); c.i = end < 0 ? c.s.length : end + 1; } // \sqrt[n]{x}: drop the index
    const a = arg(c).trim();
    return /^[\w.]+$/.test(a) ? `√${a}` : `√(${a})`;
  }
  if (name === "text" || name === "mbox" || name === "textbf" || name === "textit") return rawGroup(c).replace(/ /g, SP);
  if (SPACE_CMDS.has(name)) return " ";
  if (WRAPPERS.has(name)) return arg(c);
  if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg") { // \left( ... \right) -> ( ... )
    if (c.s[c.i] === ".") c.i++;
    return "";
  }
  if (name === "begin" || name === "end") { arg(c); return ""; }
  if (name in GREEK) return GREEK[name];
  if (name in SPACED) return ` ${SPACED[name]} `;
  if (name in PREFIX) return PREFIX[name];
  if (FUNCS.has(name)) return `${SP}${name}${/^[\s]*[A-Za-z\\\d]/.test(c.s.slice(c.i, c.i + 3)) ? SP : ""}`; // `\ln x` -> `ln x`, but `\ln(x)` and `\max_{x}` stay tight
  return `${name}${SP}`; // unknown command: show its name rather than a backslash
}

function parse(c: Cursor, untilBrace: boolean): string {
  let out = "";
  const last = () => out.replace(/[\s\u0001]+$/, "").slice(-1);
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "}") { c.i++; if (untilBrace) return out; continue; }
    if (ch === "{") { c.i++; out += c.s.startsWith(",}", c.i) ? (c.i += 2, ",") : parse(c, true); continue; } // 1{,}000
    if (ch === "\\") { out += command(c); continue; }
    if (ch === "^" || ch === "_") { c.i++; out += script(arg(c), ch === "^" ? SUP : SUB, ch); continue; }
    c.i++;
    if (/\s/.test(ch)) continue; // whitespace between operands is insignificant in LaTeX math
    if (ch === "&" || ch === "~") out += " ";
    else if (ch === "=" || ch === "<" || ch === ">" || ch === "+") out += ` ${ch} `;
    else if (ch === "-") out += /[\w)\]}′ⁿⁱ⁰-⁹₀-₉]/u.test(last()) ? " − " : "−"; // binary minus gets spaces, unary hugs its operand
    else if (ch === ",") out += /\d/.test(last()) && /\d/.test(c.s[c.i] ?? "") ? "," : ", "; // keep 1,000 together
    else out += ch;
  }
  return out;
}

/** Convert the inside of one math span. */
function mathToText(src: string): string {
  return parse({ s: src, i: 0 }, false)
    .replace(/\u0001 ?\(/g, "(") // `ln (x)` -> `ln(x)`
    .replace(/\u0001/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** Replace every LaTeX math span in `text` with readable plain text. */
export function latexToText(text: string): string {
  const spans: string[] = [];
  const keep = (m: string) => { spans.push(mathToText(m)); return `\u0003${spans.length - 1}\u0003`; };
  let t = text.replace(/\\\$/g, DOLLAR);
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_m, g: string) => `\n${keep(g)}\n`);
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_m, g: string) => `\n${keep(g)}\n`);
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_m, g: string) => keep(g));
  // Inline $...$: the pandoc rule (no space inside the delimiters, no digit right after the closer) keeps "$5 and $10" as money.
  t = t.replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_m, g: string) => keep(g));
  return t.replace(/\u0003(\d+)\u0003/g, (_m, n: string) => spans[Number(n)]).replace(new RegExp(DOLLAR, "g"), "$");
}
