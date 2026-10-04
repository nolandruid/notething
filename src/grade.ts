import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { q } from "./db.js";
import { CHEAP_MODEL, CONTENT_DIR, opt } from "./env.js";
import { askJSON, fileBlock, type Block } from "./llm.js";
import { COACH, esc, noteLink, pushRetries, type Retry } from "./mail.js";

// ---------- which problem set is this? ----------

interface Problem { number: string; topic: string; question: string; solution: string | null }
export interface Target { course: string; set: string }

const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "5(c)" and "5c" and "5 (C)" are the same part. */
export const partKey = norm;
const questionOf = (n: string) => n.match(/^\d+/)?.[0] ?? n;

/** "Problem Set 3", "PS3", "ps_3" -> "PS3" (the name `ingest` gives a set). */
export function setFromText(text: string): string | undefined {
  const m = text.match(/(?<![a-z])(?:problem[\s_-]*sets?|ps)[\s_#-]*(\d+?)(?=20\d\d(?!\d)|(?!\d))/i);
  return m ? `PS${m[1]}` : undefined;
}

async function knownSets(): Promise<{ course: string; set: string; problems: number; topics: string[] }[]> {
  const rows = await q<{ course: string; set_name: string; topic: string }>(`select course, set_name, topic from problems order by course, set_name, id`);
  const by = new Map<string, { course: string; set: string; problems: number; topics: string[] }>();
  for (const r of rows) {
    const e = by.get(`${r.course}/${r.set_name}`) ?? { course: r.course, set: r.set_name, problems: 0, topics: [] };
    e.problems++;
    if (!e.topics.includes(r.topic) && e.topics.length < 6) e.topics.push(r.topic);
    by.set(`${r.course}/${r.set_name}`, e);
  }
  return [...by.values()];
}

/**
 * Match an emailed submission to a problem set we ingested. Subject / file names / body usually say it
 * ("PS1", "Problem Set 2"); when they don't, the model looks at the pages. Returns null if it can't tell.
 */
export async function identifyProblemSet(files: string[], subject = "", body = ""): Promise<Target | null> {
  const sets = await knownSets();
  if (!sets.length) return null;
  const hay = [subject, body, ...files.map((f) => path.basename(f))].join("\n");
  // The subject is the strongest signal ("Re: Practice: redo these from Problem Set 1"); the body and file names are fallbacks.
  const named = setFromText(subject) ?? setFromText(hay);
  if (named) {
    const hits = sets.filter((s) => s.set === named);
    const byCourse = hits.filter((s) => hay.toLowerCase().replace(/[\s_-]/g, "").includes(s.course.toLowerCase()));
    const pick = hits.length === 1 ? hits[0] : byCourse.length === 1 ? byCourse[0] : undefined;
    if (pick) return { course: pick.course, set: pick.set };
  }
  const r = await askJSON(z.object({
    is_problem_set_work: z.boolean().describe("true if the attachments are a student's answers to a problem set / assignment"),
    course: z.string().nullable(), set: z.string().nullable(),
    reason: z.string().describe("one short sentence"),
  }), [
    ...files.map(fileBlock),
    { type: "text", text: `Email subject: ${subject || "(none)"}\nEmail text: ${body.slice(0, 1000) || "(none)"}\n\nWhich of these problem sets are the attached pages answering? Match on the questions and topics the pages show.\n${JSON.stringify(sets)}\nUse the exact course and set strings from the list, or null if none fits or you cannot tell.` },
  ], { model: CHEAP_MODEL, maxTokens: 4000 });
  const hit = r.is_problem_set_work && sets.find((s) => s.course === r.course && s.set === r.set);
  return hit ? { course: hit.course, set: hit.set } : null;
}

// ---------- grading ----------

const Part = z.object({
  number: z.string().describe("problem/part label exactly as written in <problems>, e.g. '5(c)'"),
  status: z.enum(["correct", "partial", "incorrect", "not_attempted"]),
  points_possible: z.number().nullable().describe("points for this part if the problem set or solutions state them, else null"),
  points_earned: z.number().nullable().describe("points earned (partial credit allowed) when points_possible is given, else null"),
  what_was_right: z.string().describe("what the student got right, one sentence; empty if nothing"),
  mistake: z.string().describe("the specific error: the student's value/step versus the correct one; empty if fully correct"),
  fix: z.string().describe("how to fix it or what to do next time, concrete, one or two sentences; empty if fully correct"),
  graph_check: z.string().nullable().describe("only if this part has a hand-drawn graph: verify intercepts, slope, axis labels, and the direction of any shift or pivot; null if no graph is involved"),
  note_slug: z.string().nullable().describe("slug of the note (from <notes>) to review for this part, null if none fits"),
});

const GradeSchema = z.object({
  found_answers: z.boolean().describe("false if the attachments don't contain this problem set's answers at all"),
  parts: z.array(Part),
  summary: z.string().describe("2-3 sentence coach wrap-up: encouraging, honest about the score, names what's solid and the biggest gap"),
  top_fixes: z.array(z.object({
    title: z.string().describe("short, e.g. 'Budget line pivots when one price changes'"),
    detail: z.string().describe("what went wrong across the set and how to fix it, 1-2 sentences"),
  })).describe("the 2-3 most valuable things to fix, most important first"),
  review: z.array(z.object({
    slug: z.string().describe("a slug from <notes>"),
    section: z.string().nullable().describe("a '## ' heading of that note, if one section is the best match"),
    why: z.string().describe("a few words on why"),
  })).describe("notes sections to re-read, at most 4"),
});
type Graded = z.infer<typeof GradeSchema>;

export interface GradedPart extends z.infer<typeof Part> { topic: string; question: string; solution: string | null }
export interface Report {
  course: string; set: string; official: boolean; found: boolean;
  parts: GradedPart[]; summary: string; topFixes: Graded["top_fixes"]; review: { slug: string; title: string; section: string | null; why: string }[];
  score: { earned: number; possible: number; mode: "points" | "parts"; pct: number };
  skipped: string[];
  /** True when only the parts of a practice email were graded (a "redo what you missed" reply). */
  practice?: boolean;
}

const GRADER = `${COACH}

You are now grading a problem set the student submitted as photos/PDF, possibly with hand-drawn graphs.
Rules:
- Grade EVERY part listed in <problems>, using exactly those labels. Parts the student skipped are "not_attempted".
- If <problems> have official solutions, they are the authority; the official problem set / solutions PDFs are attached too (they hold the graphs and any point values). Accept equivalent forms (unsimplified vs simplified, different but correct reasoning).
- If there are NO official solutions, first solve each part carefully yourself, then compare. Say so in the summary: this is an unofficial grade.
- Points: use the points printed on the problem set or solutions. If no points are printed, set points_possible and points_earned to null for every part and judge by status: correct, partial (right idea, wrong execution or incomplete), incorrect.
- Read handwriting carefully; if something is illegible, say so in the mistake rather than guessing wrong.
- For graphs: check where each line crosses the axes (intercepts, with the numbers), the slope or relative steepness, axis labels and units, and whether a shift (parallel) or pivot (one intercept fixed) went the right direction. Put your findings in graph_check.
- "mistake" is specific: what the student wrote versus the right value. "fix" is concrete and short.
- Email-safe text: no LaTeX, no $ signs, no backslashes. Write math in plain Unicode, e.g. p₁x₁ + p₂x₂ = m, x₂ = m/p₂ − (p₁/p₂)x₁, ∂f/∂x, √x, ≤, ×, ½. Currency as $4.
- Tone: warm, direct coach. Praise what is real, never inflate.`;

const key = partKey;

function score(parts: GradedPart[]): Report["score"] {
  const allPoints = parts.length > 0 && parts.every((p) => p.points_possible != null);
  if (allPoints) {
    const possible = parts.reduce((a, p) => a + (p.points_possible ?? 0), 0);
    const earned = parts.reduce((a, p) => a + Math.min(Math.max(p.points_earned ?? 0, 0), p.points_possible ?? 0), 0);
    return { earned, possible, mode: "points", pct: possible ? Math.round((100 * earned) / possible) : 0 };
  }
  const earned = parts.reduce((a, p) => a + (p.status === "correct" ? 1 : p.status === "partial" ? 0.5 : 0), 0);
  return { earned, possible: parts.length, mode: "parts", pct: parts.length ? Math.round((100 * earned) / parts.length) : 0 };
}

/** The original problem set / solutions PDFs for a set, so the grader can read points and drawn solution graphs. */
export async function officialFiles(course: string, set: string): Promise<string[]> {
  const rows = await q<{ path: string }>(`select path from documents where course = $1 and kind = 'problemset'`, [course]);
  const setOf = (f: string) => {
    const n = path.parse(f).name.replace(/20\d\d$/, "");
    return `PS${n.match(/(?:problem.?set|ps)\s*_?(\d+)/i)?.[1] ?? n.match(/(\d+)/)?.[1] ?? "?"}`;
  };
  return rows.map((r) => path.join(CONTENT_DIR, course, r.path)).filter((f) => setOf(f) === set && fs.existsSync(f)).slice(0, 4);
}

/** Grade the student's files (PDFs / photos) against one problem set. */
export async function gradeProblemSet(target: Target, files: string[], note = "", skipped: string[] = [], only?: string[]): Promise<Report> {
  const all = await q<Problem>(`select number, topic, question, solution from problems where course = $1 and set_name = $2 order by id`, [target.course, target.set]);
  if (!all.length) throw new Error(`No ${target.set} problems for ${target.course}; run pnpm ingest first.`);
  // A practice redo covers only the parts that were in the practice email; everything else is out of scope, not "missing".
  const wanted = only && new Set(only.map(key));
  const problems = wanted ? all.filter((p) => wanted.has(key(p.number))) : all;
  if (!problems.length) throw new Error(`None of the practice parts match ${target.set} for ${target.course}.`);
  const notes = await q<{ slug: string; title: string; markdown: string }>(`select slug, title, markdown from notes where course = $1 order by slug`, [target.course]);
  const given = await officialFiles(target.course, target.set);
  // Official solutions exist if every part has one on record, or a solutions PDF is attached to cover parts ingestion left blank.
  // A problem-only PDF is not a solution source.
  const solutionPdf = given.some((f) => /solution|soln|answer/i.test(path.basename(f)));
  const official = problems.every((p) => !!p.solution?.trim()) || solutionPdf;

  const blocks: Block[] = [{ type: "text", text: `Course ${target.course}, ${target.set}. ${official ? "Official solutions are available." : "There are NO official solutions for some or all parts."}` }];
  for (const f of given) blocks.push({ type: "text", text: `[Official material: ${path.basename(f)}]` }, fileBlock(f));
  if (wanted) blocks.push({ type: "text", text: "This is a practice redo: the student re-did only the parts listed in <problems>. Grade only those parts; the rest of the set is out of scope. Do not mark anything else wrong." });
  blocks.push({ type: "text", text: `<problems>\n${JSON.stringify(problems)}\n</problems>` });
  blocks.push({ type: "text", text: `<notes>\n${notes.map((n) => `${n.slug} | ${n.title} | sections: ${[...n.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]).slice(0, 12).join("; ")}`).join("\n")}\n</notes>` });
  files.forEach((f, i) => blocks.push({ type: "text", text: `[Student submission, file ${i + 1} of ${files.length}: ${path.basename(f)}]` }, fileBlock(f)));
  blocks.push({ type: "text", text: `${note ? `The student's email said: "${note.slice(0, 800)}"\n\n` : ""}Grade the student's submission above, part by part.` });

  const g = await askJSON(GradeSchema, blocks, { system: GRADER, maxTokens: 24000, effort: "medium" });

  const byKey = new Map(g.parts.map((p) => [key(p.number), p]));
  const slugs = new Set(notes.map((n) => n.slug));
  const parts: GradedPart[] = problems.map((p) => {
    const r = byKey.get(key(p.number));
    return {
      ...(r ?? { number: p.number, status: "not_attempted" as const, points_possible: null, points_earned: null, what_was_right: "", mistake: "I couldn't find an answer to this part.", fix: "", graph_check: null, note_slug: null }),
      number: p.number, topic: p.topic, question: p.question, solution: p.solution,
      note_slug: r?.note_slug && slugs.has(r.note_slug) ? r.note_slug : null,
    };
  });
  const title = (slug: string) => notes.find((n) => n.slug === slug)?.title;
  return {
    ...target, official, found: g.found_answers && parts.some((p) => p.status !== "not_attempted"),
    parts, summary: unlatex(g.summary), topFixes: g.top_fixes.slice(0, 3),
    review: g.review.filter((r) => slugs.has(r.slug)).slice(0, 4).map((r) => ({ ...r, title: title(r.slug)! })),
    score: score(parts), skipped, ...(wanted ? { practice: true } : {}),
  };
}

// ---------- the email ----------

const GREEK: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", theta: "θ", Delta: "Δ", partial: "∂", infty: "∞" };
const SUB = "₀₁₂₃₄₅₆₇₈₉", SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** Safety net: models sometimes still emit LaTeX. Turn the common bits into readable Unicode for email. */
export function unlatex(s: string): string {
  let t = s.replace(/\$\$?([^$]+)\$\$?/g, (m, inner) => (/[\\^_{}]/.test(inner) ? inner : m)); // $...$ that is math; a lone "$4" stays
  for (let i = 0; i < 3; i++) t = t.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => (/^\w{1,3}$/.test(a) && /^\w{1,3}$/.test(b) ? `${a}/${b}` : `(${a})/(${b})`));
  t = t.replace(/\\(?:cdot)\b/g, "·").replace(/\\times\b/g, "×").replace(/\\(?:leq?)\b/g, "≤").replace(/\\(?:geq?)\b/g, "≥").replace(/\\neq?\b/g, "≠")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)").replace(/\\ln\b/g, "ln").replace(/\\(?:left|right)\b/g, "").replace(/\\[,;! ]/g, " ")
    .replace(/\\\$/g, "$").replace(/\\([A-Za-z]+)/g, (m, w) => GREEK[w] ?? m);
  t = t.replace(/_\{?(\d+)\}?/g, (_, d: string) => [...d].map((c) => SUB[+c]).join("")).replace(/\^\{?(\d+)\}?/g, (_, d: string) => [...d].map((c) => SUP[+c]).join(""));
  return t.replace(/[{}]/g, "").replace(/ {2,}/g, " ").trim();
}

const ICON = { correct: "✅", partial: "🟡", incorrect: "❌", not_attempted: "⬜" } as const;
const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const partLabel = (p: GradedPart) => p.number.replace(/^\d+/, "").replace(/[()]/g, "");

interface Q { n: string; parts: GradedPart[]; earned: number; possible: number }
function byQuestion(parts: GradedPart[], mode: "points" | "parts"): Q[] {
  const m = new Map<string, GradedPart[]>();
  for (const p of parts) m.set(questionOf(p.number), [...(m.get(questionOf(p.number)) ?? []), p]);
  return [...m].map(([n, ps]) => {
    const s = score(ps);
    return { n, parts: ps, earned: mode === "points" ? s.earned : ps.reduce((a, p) => a + (p.status === "correct" ? 1 : p.status === "partial" ? 0.5 : 0), 0), possible: mode === "points" ? s.possible : ps.length };
  });
}

/** Which graded parts need a closer look, worst first. */
export const missedParts = (parts: GradedPart[]) =>
  parts.filter((p) => p.status !== "correct").sort((a, b) => Number(a.status === "partial") - Number(b.status === "partial"));

/** How a part came out on a practice redo, versus last time (when it was wrong). */
const REDO = { correct: "fixed ✅", partial: "closer, still not right 🟡", incorrect: "still wrong ❌", not_attempted: "not attempted ⬜" } as const;

export function renderReport(r: Report): { text: string; html: string } {
  const first = opt("STUDENT_NAME").split(/\s+/)[0];
  const sc = r.score;
  const practice = !!r.practice;
  const setName = r.set.replace(/^PS/, "Problem Set ");
  const fixed = r.parts.filter((p) => p.status === "correct").length;
  const scoreStr = practice ? `Practice redo: ${fixed}/${r.parts.length}` : `${pts(sc.earned)}/${pts(sc.possible)}${sc.mode === "points" ? " points" : " parts"} (${sc.pct}%)`;
  const intro = practice ? `I graded your ${setName} practice redo (${r.course}).` : `I graded your ${r.set} (${r.course}).`;
  const caveat = r.official ? "" : "Heads up: I don't have official solutions for this set, so I solved it myself first. Treat this grade as unofficial.";
  const qs = byQuestion(r.parts, sc.mode);
  const bad = r.parts.filter((p) => p.status !== "correct"); // in problem-set order
  const f = (s: string) => unlatex(s);
  const skipped = r.skipped.length ? `I couldn't read ${r.skipped.join(", ")}; resend ${r.skipped.length === 1 ? "it" : "them"} as a PDF or JPG if you want ${r.skipped.length === 1 ? "it" : "them"} graded too.` : "";

  const qLine = (x: Q) => {
    const icons = x.parts.length > 1 ? x.parts.map((p) => `${partLabel(p)} ${ICON[p.status]}`).join("  ") : ICON[x.parts[0].status];
    const topics = [...new Set(x.parts.map((p) => p.topic))];
    return { n: x.n, topic: topics.slice(0, 2).join(" / ") + (topics.length > 2 ? " …" : ""), score: `${pts(x.earned)}/${pts(x.possible)}`, icons };
  };
  const rows = qs.map(qLine);

  const detail = (p: GradedPart) => [
    f(p.mistake) && `What went wrong: ${f(p.mistake)}`,
    f(p.fix) && `Fix: ${f(p.fix)}`,
    p.graph_check && `Graph check: ${f(p.graph_check)}`,
    f(p.what_was_right) && `Right so far: ${f(p.what_was_right)}`,
  ].filter(Boolean) as string[];

  const text = [
    `${first ? `Hi ${first}, ` : ""}${intro}`, ...(caveat ? ["", caveat] : []), ...(skipped ? ["", skipped] : []), "",
    practice ? scoreStr : `OVERALL: ${scoreStr}`, f(r.summary), "",
    ...(practice
      ? ["COMPARED WITH LAST TIME", ...r.parts.map((p) => `Q${p.number}: ${REDO[p.status]}`), ""]
      : ["BY QUESTION", ...rows.map((x) => `Q${x.n}  ${x.score.padEnd(5)} ${x.icons}   ${x.topic}`), ""]),
    ...(bad.length ? ["WHAT TO FIX", ...bad.flatMap((p) => [`Q${p.number} ${ICON[p.status]} ${p.topic}${p.points_possible != null ? ` (${pts(p.points_earned ?? 0)}/${pts(p.points_possible)})` : ""}`, ...detail(p).map((l) => `   ${l}`), ""])] : ["Nothing to fix. That is a clean set.", ""]),
    ...(r.topFixes.length ? ["TOP THINGS TO WORK ON", ...r.topFixes.map((t, i) => `${i + 1}. ${f(t.title)}: ${f(t.detail)}`), ""] : []),
    ...(r.review.length ? ["REVIEW", ...r.review.map((n) => `• ${n.title}${n.section ? ` › ${n.section}` : ""} (${f(n.why)})${noteLink(r.course, n.slug) ? `: ${noteLink(r.course, n.slug)}` : ""}`), ""] : []),
    bad.length ? "I've added the parts you missed to your upcoming sessions so we lock them in." : "Next session will push a bit further.", "", "— NoteThing",
  ].join("\n");

  const td = "padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;line-height:1.5;color:#222">
<p>${first ? `Hi ${esc(first)}, ` : ""}${esc(intro)}</p>
${caveat ? `<p style="background:#fff8e1;border-radius:8px;padding:8px 12px;font-size:14px">${esc(caveat)}</p>` : ""}${skipped ? `<p style="color:#b4532a">${esc(skipped)}</p>` : ""}
<p style="background:#fff4ec;border-radius:8px;padding:10px 14px;margin:12px 0"><span style="font-size:22px"><b>${esc(scoreStr)}</b></span><br>${esc(f(r.summary))}</p>
${practice
    ? `<h3 style="margin-bottom:4px">Compared with last time</h3>
<table style="border-collapse:collapse;width:100%;font-size:14px">${r.parts.map((p) => `<tr><td style="${td}"><b>Q${esc(p.number)}</b></td><td style="${td}">${esc(p.topic)}</td><td style="${td};white-space:nowrap">${esc(REDO[p.status])}</td></tr>`).join("\n")}</table>`
    : `<h3 style="margin-bottom:4px">By question</h3>
<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="text-align:left;color:#888"><th style="${td}">Q</th><th style="${td}">Topic</th><th style="${td}">Score</th><th style="${td}">Parts</th></tr>
${rows.map((x) => `<tr><td style="${td}"><b>${esc(x.n)}</b></td><td style="${td}">${esc(x.topic)}</td><td style="${td};white-space:nowrap">${esc(x.score)}</td><td style="${td};white-space:nowrap">${esc(x.icons)}</td></tr>`).join("\n")}</table>`}
${bad.length ? `<h3 style="margin-bottom:4px">What to fix</h3>${bad.map((p) => `<p style="margin:8px 0">${ICON[p.status]} <b>Q${esc(p.number)}</b> · ${esc(p.topic)}${p.points_possible != null ? ` (${pts(p.points_earned ?? 0)}/${pts(p.points_possible)})` : ""}<br><span style="color:#444">${detail(p).map(esc).join("<br>")}</span></p>`).join("")}` : "<p>Nothing to fix. That is a clean set.</p>"}
${r.topFixes.length ? `<h3 style="margin-bottom:4px">Top things to work on</h3><ol>${r.topFixes.map((t) => `<li style="margin-bottom:6px"><b>${esc(f(t.title))}</b>: ${esc(f(t.detail))}</li>`).join("")}</ol>` : ""}
${r.review.length ? `<h3 style="margin-bottom:4px">Review</h3><ul>${r.review.map((n) => { const href = noteLink(r.course, n.slug), label = `<b>${esc(n.title)}</b>${n.section ? ` › ${esc(n.section)}` : ""}`; return `<li>${href ? `<a href="${esc(href)}">${label}</a>` : label} <span style="color:#555">(${esc(f(n.why))})</span></li>`; }).join("")}</ul>` : ""}
<p>${bad.length ? "I've added the parts you missed to your upcoming sessions so we lock them in." : "Next session will push a bit further."}</p><p style="color:#888">— NoteThing</p></div>`;
  return { text, html };
}

// ---------- feeding the coach ----------

/** Record each part as a result per topic, and queue what was missed into the next session so it gets re-practised. Idempotent per source. */
export async function recordWeakTopics(r: Report, source: string, maxRetries = 4) {
  // One statement, so a failure can never leave the source with only some of its rows.
  await q(
    `with cleared as (delete from seed_results where course = $1 and source = $2)
     insert into seed_results (course, topic, correct, source, note)
     select $1, t.topic, t.correct, $2, t.note from unnest($3::text[], $4::boolean[], $5::text[]) as t(topic, correct, note)`,
    [r.course, source, r.parts.map((p) => p.topic), r.parts.map((p) => p.status === "correct"),
      r.parts.map((p) => `${r.set} Q${p.number}: ${(p.mistake || p.what_was_right || p.status).slice(0, 200)}`)]);
  const test = (await q<{ name: string }>(`select name from tests where course = $1 and (date is null or date >= current_date) order by date nulls last limit 1`, [r.course]))[0];
  const missed: Retry[] = missedParts(r.parts).slice(0, maxRetries).map((p) => ({
    question: `(${r.set} ${p.number}) ${p.question}`, answer: p.solution ?? p.fix, topic: p.topic, note_slug: p.note_slug,
  }));
  await pushRetries({ course: r.course, test_name: test?.name ?? null }, missed);
}
