import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

/**
 * Read a .docx the way a student sees it: text in order, Word equations as LaTeX, and pasted pictures
 * (graphs!) pulled out in order. A plain text dump (what mammoth gives) silently drops both the
 * equations and the images, which is most of an economics lecture.
 */

type N = any; // xmldom nodes; the DOM typings are not worth the noise here

const kids = (n: N): N[] => Array.from(n.childNodes ?? []).filter((c: N) => c.nodeType === 1);
const name = (n: N): string => n.nodeName as string;
const child = (n: N, tag: string): N | undefined => kids(n).find((c) => name(c) === tag);
const textOf = (n: N): string => (n.textContent ?? "") as string;

const GREEK: Record<string, string> = { "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\epsilon", "θ": "\\theta", "λ": "\\lambda", "μ": "\\mu", "π": "\\pi", "σ": "\\sigma", "τ": "\\tau", "φ": "\\phi", "ω": "\\omega", "Δ": "\\Delta", "Σ": "\\Sigma", "∂": "\\partial", "∞": "\\infty", "≤": "\\le ", "≥": "\\ge ", "≠": "\\ne ", "×": "\\times ", "·": "\\cdot ", "−": "-", "→": "\\to ", "⇒": "\\Rightarrow ", "±": "\\pm ", "∑": "\\sum", "∫": "\\int", "√": "\\sqrt" };
// Commands get a trailing space so "\\beta" + "p" does not become "\\betap".
const latexText = (s: string) => [...s].map((ch) => { const g = GREEK[ch]; return g ? (g.startsWith("\\") ? `${g.trimEnd()} ` : g) : ch; }).join("");

/** Office Math (OMML) -> LaTeX. Covers fractions, scripts, roots, n-ary operators, delimiters, functions, matrices. */
function omml(n: N): string {
  const arg = (tag: string, parent = n) => { const c = child(parent, tag); return c ? kids(c).map(omml).join("") : ""; };
  switch (name(n)) {
    case "m:r": return latexText(kids(n).filter((c) => name(c) === "m:t").map(textOf).join(""));
    case "m:f": return `\\frac{${arg("m:num")}}{${arg("m:den")}}`;
    case "m:sSup": return `{${arg("m:e")}}^{${arg("m:sup")}}`;
    case "m:sSub": return `{${arg("m:e")}}_{${arg("m:sub")}}`;
    case "m:sSubSup": return `{${arg("m:e")}}_{${arg("m:sub")}}^{${arg("m:sup")}}`;
    case "m:rad": { const deg = arg("m:deg"); return deg ? `\\sqrt[${deg}]{${arg("m:e")}}` : `\\sqrt{${arg("m:e")}}`; }
    case "m:nary": {
      const chr = child(child(n, "m:naryPr") ?? n, "m:chr")?.getAttribute("m:val") ?? "∫";
      const sub = arg("m:sub"), sup = arg("m:sup");
      return `${latexText(chr)}${sub ? `_{${sub}}` : ""}${sup ? `^{${sup}}` : ""}{${arg("m:e")}}`;
    }
    case "m:d": {
      const pr = child(n, "m:dPr");
      const open = child(pr ?? n, "m:begChr")?.getAttribute("m:val") ?? "(";
      const close = child(pr ?? n, "m:endChr")?.getAttribute("m:val") ?? ")";
      const sep = child(pr ?? n, "m:sepChr")?.getAttribute("m:val") ?? "|";
      const es = kids(n).filter((c) => name(c) === "m:e").map((e) => kids(e).map(omml).join(""));
      const esc = (c: string) => (c === "{" || c === "}" ? `\\${c}` : c === "" ? "." : c);
      return `\\left${esc(open)}${es.join(sep)}\\right${esc(close)}`;
    }
    case "m:func": {
      const f = textOf(child(n, "m:fName")).trim();
      return `${["sin", "cos", "tan", "log", "ln", "exp", "min", "max", "lim"].includes(f) ? `\\${f}` : `\\operatorname{${f}}`}{${arg("m:e")}}`;
    }
    case "m:limLow": return `\\underset{${arg("m:lim")}}{${arg("m:e")}}`;
    case "m:bar": return `\\overline{${arg("m:e")}}`;
    case "m:acc": return `\\hat{${arg("m:e")}}`;
    case "m:eqArr": return `\\begin{aligned}${kids(n).filter((c) => name(c) === "m:e").map((e) => kids(e).map(omml).join("")).join(" \\\\ ")}\\end{aligned}`;
    case "m:m": return `\\begin{matrix}${kids(n).filter((c) => name(c) === "m:mr").map((r) => kids(r).filter((c) => name(c) === "m:e").map((e) => kids(e).map(omml).join("")).join(" & ")).join(" \\\\ ")}\\end{matrix}`;
    case "m:oMath": case "m:e": case "m:num": case "m:den": case "m:sub": case "m:sup": case "m:deg": case "m:lim": case "m:fName":
      return kids(n).map(omml).join("");
    default: // properties and anything unknown: keep nested math, skip *Pr nodes
      return /Pr$/.test(name(n)) ? "" : kids(n).map(omml).join("");
  }
}

export interface DocxContent { text: string; images: { name: string; mime: string; data: Buffer }[] }

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export async function readDocx(file: string): Promise<DocxContent> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = async (p: string) => new DOMParser().parseFromString(await zip.file(p)!.async("string"), "text/xml");
  const doc = await xml("word/document.xml");
  const rels = new Map<string, string>();
  if (zip.file("word/_rels/document.xml.rels")) {
    const r = await xml("word/_rels/document.xml.rels");
    for (const el of Array.from(r.getElementsByTagName("Relationship")) as N[]) rels.set(el.getAttribute("Id"), el.getAttribute("Target"));
  }

  const images: DocxContent["images"] = [];
  const imageIds = new Map<string, number>();
  const picture = async (embed: string): Promise<string> => {
    const target = rels.get(embed);
    const ext = target ? path.extname(target).slice(1).toLowerCase() : "";
    const entry = target && zip.file(path.posix.normalize(`word/${target}`));
    if (!entry || !MIME[ext]) return "";
    if (!imageIds.has(embed)) { imageIds.set(embed, images.length + 1); images.push({ name: `image ${images.length + 1}`, mime: MIME[ext], data: await entry.async("nodebuffer") }); }
    return `[image ${imageIds.get(embed)}]`;
  };

  /** Text of one paragraph, with inline math as $..$, display math as $$..$$ and picture markers. */
  async function inline(p: N): Promise<string> {
    let out = "";
    const walk = async (n: N): Promise<void> => {
      for (const c of kids(n)) {
        const t = name(c);
        if (t === "m:oMathPara") out += ` $$${kids(c).filter((k) => name(k) === "m:oMath").map(omml).join(" \\\\ ")}$$ `;
        else if (t === "m:oMath") out += ` $${omml(c)}$ `;
        else if (t === "w:t") out += textOf(c);
        else if (t === "w:tab") out += "\t";
        else if (t === "w:br") out += "\n";
        else if (t === "a:blip") out += ` ${await picture(c.getAttribute("r:embed"))} `;
        else if (t === "v:imagedata") out += ` ${await picture(c.getAttribute("r:id"))} `;
        else if (t === "w:pPr" || t === "w:rPr") continue;
        else if (t === "mc:AlternateContent") { // Word stores one picture twice (modern + legacy); read only one
          const branch = kids(c).find((k) => name(k) === "mc:Choice") ?? kids(c).find((k) => name(k) === "mc:Fallback");
          if (branch) await walk(branch);
        } else await walk(c);
      }
    };
    await walk(p);
    return out.replace(/ +/g, " ").trim();
  }

  const body = doc.getElementsByTagName("w:body")[0] as N;
  const lines: string[] = [];
  const blocks = async (parent: N): Promise<void> => {
    for (const c of kids(parent)) {
      if (name(c) === "w:p") { const s = await inline(c); if (s) lines.push(s); }
      else if (name(c) === "w:tbl" || name(c) === "w:tr" || name(c) === "w:tc" || name(c) === "w:sdt" || name(c) === "w:sdtContent" || name(c) === "w:customXml") await blocks(c);
    }
  };
  await blocks(body);
  return { text: lines.join("\n"), images };
}
