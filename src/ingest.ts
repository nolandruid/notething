import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureCourse, q } from "./db.js";
import { CHEAP_MODEL, CONTENT_DIR, isoDate, opt, slugify, VAULT_DIR } from "./env.js";
import { readDocx } from "./docx.js";
import { askJSON, fileBlock, isImage, type Block } from "./llm.js";
import { isVideo, transcribe, transcriptText } from "./transcribe.js";

type Kind = "notes" | "slides" | "syllabus" | "video" | "problemset" | "student_work";
interface Src { abs: string; rel: string; kind: Kind; hash: string; isNew: boolean; topic: string; toks: string[] }

const SUPPORTED = /\.(pdf|png|jpe?g|webp|gif|docx|txt|md)$/i;

// ---------- discovery ----------

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return []; // skips .transcripts, .DS_Store
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

/** Folder that groups a lecture: "Topic 1/Content/x.pdf" -> "Topic 1". */
function topicOf(rel: string) {
  const parts = path.dirname(rel).split(path.sep).filter((p) => p !== ".");
  while (parts.length && /^(content|notes|videos?|slides|scans?)$/i.test(parts.at(-1)!)) parts.pop();
  return parts.join("/");
}

const NOISE = new Set(["video", "scanned", "scan", "part", "content", "typed", "note", "notes", "lecture", "slide", "slides", "handwritten"]);
/** "BudgetConstraint_Scanned2" -> ["budget","constraint"]; "video_BC_part1" -> ["bc"]. */
function tokensOf(file: string) {
  return path.parse(file).name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE.has(t) && !/^\d+$/.test(t) && !/^(scanned|scan|part)\d+$/.test(t))
    .map((t) => (t.length > 3 ? t.replace(/s$/, "") : t));
}
const sameLecture = (a: string[], b: string[]) => {
  const [ja, jb] = [a.join(""), b.join("")];
  const ini = (t: string[]) => t.map((x) => x[0]).join("");
  return !!ja && !!jb && (ja === jb || (a.length > 1 && ini(a) === jb) || (b.length > 1 && ini(b) === ja));
};

function kindFromName(file: string): Kind | undefined {
  const n = path.basename(file);
  const student = opt("STUDENT_NAME").toLowerCase().split(/\s+/).filter(Boolean);
  const isStudent = (student.length && student.every((t) => n.toLowerCase().includes(t))) || /^[A-Z][a-z]+_[A-Z][a-z]+_/.test(n);
  if (isVideo(n)) return "video";
  if (/syllabus|course.?outline/i.test(n)) return "syllabus";
  if (/solution/i.test(n)) return "problemset";
  if (isStudent && /ps.?\d|problem.?set|assignment|homework/i.test(n)) return "student_work";
  if (/^(problem.?set|ps.?\d)|assignment|homework/i.test(n)) return "problemset";
  if (/slide|deck/i.test(n)) return "slides";
  if (/scan|note|handwritten/i.test(n) || isImage(n) || /\.docx$/i.test(n)) return "notes";
  return undefined;
}

async function kindFromModel(file: string): Promise<Kind> {
  try {
    const r = await askJSON(z.object({ kind: z.enum(["notes", "slides", "syllabus", "problemset", "student_work"]) }), [
      ...(await contentBlocks(file)),
      { type: "text", text: `Classify this course file "${path.basename(file)}": syllabus (course outline/test dates), notes (professor's lecture notes, handwritten or typed), slides (lecture slide deck), problemset (assignment questions or official solutions), student_work (a student's own submitted answers).` },
    ], { model: CHEAP_MODEL, maxTokens: 256 });
    return r.kind;
  } catch (e) {
    console.warn(`  ! Couldn't classify ${path.basename(file)} (${(e as Error).message}); treating as notes`);
    return "notes";
  }
}

/** A file as model input. .docx becomes text (with equations as LaTeX) plus its pictures, labelled "image N". */
async function contentBlocks(file: string): Promise<Block[]> {
  if (/\.docx$/i.test(file)) {
    const { text, images } = await readDocx(file);
    return [
      { type: "text", text: `<typed_notes file="${path.basename(file)}">\n${text}\n</typed_notes>` },
      ...images.flatMap((im): Block[] => [
        { type: "text", text: `[${im.name} from ${path.basename(file)}, as marked in the text above]` },
        { type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data.toString("base64")}` } },
      ]),
    ];
  }
  return [fileBlock(file)];
}

async function discover(course: string): Promise<{ srcs: Src[]; urls: { url: string; topic: string }[] }> {
  const dir = path.join(CONTENT_DIR, course);
  const files = walk(dir);
  const known = new Map((await q<{ hash: string; kind: Kind }>(`select hash, kind from documents where course = $1`, [course])).map((r) => [r.hash, r.kind]));
  const srcs: Src[] = [];
  const urls: { url: string; topic: string }[] = [];
  for (const abs of files) {
    const rel = path.relative(dir, abs);
    if (path.basename(abs) === "videos.txt") {
      for (const line of fs.readFileSync(abs, "utf8").split("\n").map((l) => l.trim()))
        if (/^https?:\/\//.test(line)) urls.push({ url: line, topic: topicOf(rel) });
      continue;
    }
    if (!SUPPORTED.test(abs) && !isVideo(abs)) { console.warn(`  · ignoring unsupported file ${rel}`); continue; }
    const hash = sha(fs.readFileSync(abs));
    const kind = known.get(hash) ?? kindFromName(abs) ?? (await kindFromModel(abs));
    srcs.push({ abs, rel, kind, hash, isNew: !known.has(hash), topic: topicOf(rel), toks: tokensOf(abs) });
  }
  return { srcs, urls };
}

async function record(course: string, s: Pick<Src, "rel" | "hash" | "kind">) {
  await q(`insert into documents (course, path, hash, kind) values ($1,$2,$3,$4) on conflict (hash) do nothing`, [course, s.rel, s.hash, s.kind]);
}

// ---------- syllabus ----------

const SyllabusSchema = z.object({
  tests: z.array(z.object({
    name: z.string().describe("e.g. 'Midterm 1'"),
    date: z.string().nullable().describe("YYYY-MM-DD, or null if TBD"),
    topics: z.array(z.string()).describe("topics/lectures covered, as named in the syllabus (e.g. 'Topic 1: Budget constraint')"),
  })),
});

async function ingestSyllabus(course: string, s: Src) {
  console.log(`  ▸ syllabus: ${s.rel}`);
  const r = await askJSON(SyllabusSchema, [...(await contentBlocks(s.abs)), {
    type: "text",
    text: `Today is ${isoDate(new Date())}. Extract every test, midterm, quiz and exam from this syllabus with its date (infer the year from context) and the topics it covers. If topics aren't listed per test, infer them from the course schedule (cumulative finals cover everything).`,
  }], { maxTokens: 8000 });
  for (const t of r.tests)
    await q(`insert into tests (course, name, date, topics) values ($1,$2,$3,$4)
             on conflict (course, name) do update set date = excluded.date, topics = excluded.topics`, [course, t.name, t.date, t.topics]);
  console.log(`    ✓ ${r.tests.length} tests: ${r.tests.map((t) => `${t.name} (${t.date ?? "TBD"})`).join(", ")}`);
  await record(course, s);
}

// ---------- problem sets & the student's own work ----------

const setOf = (file: string) => {
  const n = path.parse(file).name.replace(/20\d\d$/, "");
  return `PS${n.match(/(?:problem.?set|ps)\s*_?(\d+)/i)?.[1] ?? n.match(/(\d+)/)?.[1] ?? "?"}`;
};

const ProblemsSchema = z.object({
  problems: z.array(z.object({
    number: z.string().describe("e.g. '1', '2b'"),
    topic: z.string().describe("short concept name, e.g. 'budget constraint', 'elasticity'"),
    question: z.string(),
    solution: z.string().nullable(),
  })),
});

async function ingestProblemSet(course: string, set: string, files: Src[]) {
  console.log(`  ▸ problem set ${set}: ${files.map((f) => f.rel).join(", ")}`);
  const r = await askJSON(ProblemsSchema, [...(await Promise.all(files.map((f) => contentBlocks(f.abs)))).flat(), {
    type: "text",
    text: "These are a problem set and (possibly) its official solutions. Extract each problem/sub-part with the concept it tests, the full question, and the official solution (null if not provided). Use LaTeX $...$ for math.",
  }]);
  for (const p of r.problems)
    await q(`insert into problems (course, set_name, number, topic, question, solution) values ($1,$2,$3,$4,$5,$6)
             on conflict (course, set_name, number) do update set topic = excluded.topic, question = excluded.question,
             solution = coalesce(excluded.solution, problems.solution)`, [course, set, p.number, p.topic, p.question, p.solution]);
  console.log(`    ✓ ${r.problems.length} problems`);
  for (const f of files) await record(course, f);
}

const StudentSchema = z.object({
  results: z.array(z.object({ number: z.string(), topic: z.string(), correct: z.boolean(), note: z.string().describe("what they got wrong or right, one sentence") })),
});

async function ingestStudentWork(course: string, s: Src) {
  const set = setOf(s.abs);
  console.log(`  ▸ student work (${set}): ${s.rel}`);
  const probs = await q(`select number, topic, question, solution from problems where course = $1 and set_name = $2 order by number`, [course, set]);
  const r = await askJSON(StudentSchema, [...(await contentBlocks(s.abs)), {
    type: "text",
    text: `This is the student's own submitted ${set}. Compare each answer to the official solutions below and mark it correct or not. Be fair: partially correct with the key idea = correct.\n\n${JSON.stringify(probs)}`,
  }], { maxTokens: 8000 });
  await q(`delete from seed_results where course = $1 and source = $2`, [course, s.rel]);
  for (const x of r.results) await q(`insert into seed_results (course, topic, correct, source, note) values ($1,$2,$3,$4,$5)`, [course, x.topic, x.correct, s.rel, `${set} Q${x.number}: ${x.note}`]);
  const missed = r.results.filter((x) => !x.correct);
  console.log(`    ✓ ${r.results.length - missed.length}/${r.results.length} correct${missed.length ? `; weak: ${[...new Set(missed.map((m) => m.topic))].join(", ")}` : ""}`);
  await record(course, s);
}

// ---------- lecture notes ----------

const NoteSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  markdown: z.string().describe("Full note body (no frontmatter), starting with '# Title'"),
  concepts: z.array(z.string()).describe("Key concepts, matching the [[wikilinks]] used"),
  figures: z.array(z.object({
    id: z.string().describe("short id used in the {{figure:id}} placeholder"),
    svg: z.string().describe("complete standalone <svg xmlns=...>...</svg> redrawing the graph"),
    description: z.string().describe("text description of the graph: axes, curves, labeled points, shifts"),
  })),
});

const NOTE_SYSTEM = `You turn a professor's course materials into excellent Obsidian study notes for a student who will be tested on them.

Format rules:
- '# <Lecture title>' then sections with '## ' headings following the lecture's structure.
- Under EACH section: first the cleaned-up content (faithful, tidy bullets; every formula in LaTeX $...$ or $$...$$), THEN a callout that genuinely helps the student understand it:
  > [!explain]
  > <2-4 sentences: the intuition in plain English, WHY it works or matters, and one concrete example with real numbers (use the lecture's own numbers where it has them). Add a short "Watch out:" line when students typically slip (sign errors, which intercept moves, mixing up axes).>
  Do not just restate the bullets above it.
- Cite sources inline: page numbers like (p. 4) for PDFs, timestamps like (12:34) for the lecture video.
- Use [[wikilinks]] for key concepts (e.g. [[Budget constraint]], [[Opportunity cost]]).
- The typed notes arrive as text with equations already converted to LaTeX, plus the pictures pasted in them labelled "image N" (those are the professor's graphs). Read the pictures and the scanned handwriting; they hold the graphs and the worked examples.
- For every graph/diagram, put a placeholder line {{figure:<id>}} where it belongs and add a matching "figures" entry with an SVG redraw and a text description. SVG rules, follow them exactly:
  * ONE graph per figure (never several panels in one SVG). To show a change, overlay before (gray, dashed) and after (blue, solid) on the same axes and label each.
  * <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 380" font-family="sans-serif" font-size="14">. Plot area: x from 70 to 470, y from 30 to 320 (origin at 70,320). Compute every coordinate from a linear scale you pick for that graph (e.g. pixels = 70 + x*k); do not eyeball. Lines that must be parallel get identical slopes; a line that pivots about an intercept keeps that intercept at exactly the same pixel point.
  * Axes with arrowheads and axis names (e.g. x₁, x₂, F, G). Put the axis name just past each arrow tip, inside the viewBox (text-anchor="end" if needed). Mark every intercept or key point the notes give with its value on the axis (e.g. 20, 100) and a small dot.
  * Text labels must not overlap lines, dots or each other, and must stay fully inside the viewBox: put them in empty space beside the thing they name, give them a white halo (stroke="#fff" stroke-width="4" paint-order="stroke"), and use text-anchor="end" near the right edge.
  * Shaded regions (e.g. the budget set: everything on or below the budget line, down to the axes) use <polygon> whose vertices you list explicitly, with a light fill and fill-opacity 0.25; check it covers the intended side of the line. No scripts, no external references.
  * The graph must match the numbers in the note exactly (check intercepts, slopes, direction of every shift).
- In JSON strings, write every LaTeX backslash doubled (\\\\frac, \\\\beta, \\\\times) so it survives parsing.
- End with '## Key terms': a bullet list of terms with one-line definitions.
Be accurate and complete: carry over every definition, formula, worked example and exercise from the sources. Do not invent content the sources don't support, and if something is truly illegible say so once rather than guessing. Don't write meta-commentary about the source files.`;

/** LaTeX commands that start with "n": inside math, a newline followed by one of these was really `\\nu`, `\\neq`, ... */
const N_COMMANDS = /\n(?=(?:u|eq|e|abla|ot|i|leq|geq|less|gtr|mid|parallel|subseteq|Rightarrow|rightarrow|exists|ewline|cong|sim|warrow|earrow|vdash|atural)(?![a-zA-Z]))/g;

/**
 * Strip control characters and repair LaTeX commands whose backslash was eaten as a JSON escape (\f, \b, \t, \r,
 * and \n inside math). Newlines outside math are real Markdown line breaks and are left alone.
 */
export function cleanMarkdown(md: string) {
  return md
    .replace(/\$\$[\s\S]+?\$\$|\$[^$]+?\$/g, (math) => math.replace(N_COMMANDS, "\\n"))
    .replace(/\f/g, "\\f").replace(/\x08/g, "\\b").replace(/\t(?=[a-zA-Z])/g, "\\t").replace(/\r(?=[a-zA-Z])/g, "\\r")
    .replace(/[\x00-\x08\x0b\x0e-\x1f]/g, "");
}

function validSvg(svg: string) {
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s) || /<script|on\w+=/i.test(s)) return false;
  const opens = (s.match(/<(?!\/|!|\?)[a-z][^>]*[^/]>/gi) ?? []).length;
  const closes = (s.match(/<\/[a-z][^>]*>/gi) ?? []).length;
  return Math.abs(opens - closes) <= 2;
}

async function buildLecture(course: string, topic: string, group: Src[]) {
  const rank = (g: Src) => (g.kind === "video" ? 2 : /\.docx$/i.test(g.rel) ? 0 : 1);
  group = [...group].sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
  const primary = group.find((g) => g.kind !== "video") ?? group[0];
  const slug = slugify(`${topic ? `${topic}-` : ""}${primary.toks.join(" ") || path.parse(primary.abs).name}`);
  console.log(`  ▸ lecture "${slug}": ${group.map((g) => g.rel).join(", ")}`);
  const blocks: Block[] = [];
  const courseDir = path.join(CONTENT_DIR, course);
  for (const g of group) {
    if (g.kind === "video") {
      const t = transcribe(courseDir, g.abs);
      if (t) blocks.push({ type: "text", text: `<lecture_video_transcript source="${g.rel}"${t.title ? ` title="${t.title}"` : ""} duration_s="${t.duration}">\n${transcriptText(t)}\n</lecture_video_transcript>` });
    } else blocks.push(...(await contentBlocks(g.abs)));
  }
  if (!blocks.length) { console.warn("    ! no usable sources, skipping"); return; }
  blocks.push({
    type: "text",
    text: `Course: ${course}. ${topic ? `Unit: ${topic}. ` : ""}Write ONE merged lecture note from all sources above.
Typed notes (if present) are the most accurate text; the scanned handwritten PDFs hold the graphs and handwritten extras; the video transcript shows what the professor emphasized and explained aloud (cite its timestamps).`,
  });
  const r = await askJSON(NoteSchema, blocks, { system: NOTE_SYSTEM, maxTokens: 64000 });

  const assets = path.join(VAULT_DIR, course, "assets");
  fs.mkdirSync(assets, { recursive: true });
  let md = cleanMarkdown(r.markdown);
  for (const f of r.figures) {
    const file = `${slug}-${slugify(f.id)}.svg`;
    const svg = f.svg.includes("xmlns=") ? f.svg : f.svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    const embed = validSvg(svg)
      ? (fs.writeFileSync(path.join(assets, file), svg.trim()), `![[assets/${file}|560]]\n*${f.description}*`)
      : `> [!graph]\n> ${f.description.replace(/\n/g, "\n> ")}`;
    md = md.split(`{{figure:${f.id}}}`).join(embed);
  }
  md = md.replace(/\{\{figure:[^}]+\}\}/g, ""); // drop orphan placeholders
  const fm = [
    "---", `course: ${course}`, `lecture: ${JSON.stringify(topic || r.title)}`,
    `source:`, ...group.map((g) => `  - ${JSON.stringify(g.rel)}`),
    `tags: [${[...new Set(["notething", course, ...r.tags.map(slugify).filter((tag) => tag !== slugify(course))])].join(", ")}]`, `created: ${isoDate(new Date())}`, "---", "",
  ].join("\n");
  const full = fm + md.trim() + "\n";
  fs.mkdirSync(path.join(VAULT_DIR, course), { recursive: true });
  fs.writeFileSync(path.join(VAULT_DIR, course, `${slug}.md`), full);

  await q(`insert into notes (course, title, slug, markdown, source_doc, lecture) values ($1,$2,$3,$4,$5,$6)
           on conflict (course, slug) do update set title = excluded.title, markdown = excluded.markdown, source_doc = excluded.source_doc`,
    [course, r.title, slug, full, group.map((g) => g.rel).join(", "), topic]);
  for (const c of r.concepts) await q(`insert into concepts (course, name, note_slug) values ($1,$2,$3) on conflict do nothing`, [course, c, slug]);
  for (const g of group) await record(course, g);
  console.log(`    ✓ vault/${course}/${slug}.md (${r.figures.length} figures, ${r.concepts.length} concepts)`);
}

function groupLectures(srcs: Src[]): Src[][] {
  const groups: Src[][] = [];
  // Non-video sources seed groups; videos attach to the best match in the same topic folder.
  const ordered = [...srcs].sort((a, b) => Number(a.kind === "video") - Number(b.kind === "video") || b.toks.length - a.toks.length);
  for (const s of ordered) {
    const g = groups.find((g) => g[0].topic === s.topic && g.some((m) => sameLecture(m.toks, s.toks)));
    g ? g.push(s) : groups.push([s]);
  }
  return groups;
}

// ---------- entry ----------

export async function ingest(only?: string) {
  if (!fs.existsSync(CONTENT_DIR)) { console.error(`No content/ dir. Create content/<course>/ and drop files in.`); return; }
  const courseNames = only ? [only] : fs.readdirSync(CONTENT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  if (!courseNames.length) console.log("Nothing to ingest: drop files into content/<course>/");
  for (const course of courseNames) {
    console.log(`\n📚 ${course}`);
    await ensureCourse(course);
    const { srcs, urls } = await discover(course);
    const by = (k: Kind) => srcs.filter((s) => s.kind === k);

    for (const s of by("syllabus").filter((s) => s.isNew)) await ingestSyllabus(course, s);

    const sets = Map.groupBy(by("problemset"), (s) => setOf(s.abs));
    for (const [set, files] of sets) if (files.some((f) => f.isNew)) await ingestProblemSet(course, set, files);

    for (const s of by("student_work").filter((s) => s.isNew)) await ingestStudentWork(course, s);

    const lectureSrcs = srcs.filter((s) => s.kind === "notes" || s.kind === "slides" || s.kind === "video");
    for (const g of groupLectures(lectureSrcs)) if (g.some((s) => s.isNew)) {
      try { await buildLecture(course, g[0].topic, g); } catch (e) { console.error(`    ✗ ${(e as Error).message}`); }
    }

    // Lecture videos listed by URL in videos.txt: each becomes its own lecture note.
    for (const { url, topic } of urls) {
      const hash = sha(url);
      if ((await q(`select 1 from documents where hash = $1`, [hash])).length) continue;
      const t = transcribe(path.join(CONTENT_DIR, course), url);
      if (!t) continue;
      const src: Src = { abs: url, rel: url, kind: "video", hash, isNew: true, topic, toks: tokensOf(t.title ?? `url${hash.slice(0, 8)}`) };
      try { await buildLecture(course, topic, [src]); } catch (e) { console.error(`    ✗ ${(e as Error).message}`); }
    }
  }
}
export const _test = { cleanMarkdown, tokensOf, kindFromName, topicOf, groupLectures, setOf, sameLecture };
