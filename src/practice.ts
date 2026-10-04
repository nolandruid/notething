import path from "node:path";
import { z } from "zod";
import { courses, q } from "./db.js";
import { need, opt } from "./env.js";
import { askJSON, fileBlock } from "./llm.js";
import { ensureInbox, esc, mail } from "./mail.js";
import { latexToText } from "./latex.js";
import { officialFiles, partKey, unlatex } from "./grade.js";

/** The subject a practice email is sent with, and how a reply to it is recognised. */
export const practiceSubject = (set: string) => `Practice: redo these from ${set.replace(/^PS/, "Problem Set ")}`;
const PRACTICE_SUBJECT = /practice:\s*redo these from/i;

export interface PracticePart { number: string; hint: string }
interface Miss { set: string; number: string; note: string }

const PRACTICE_DDL = `create table if not exists practice_sets (
  id serial primary key, course text not null, set_name text not null,
  thread_id text, message_id text, parts jsonb not null, created_at timestamptz default now())`;
let ready: Promise<unknown> | undefined;
/** Older databases predate `practice_sets`; create it on first use so no re-migrate is needed. */
const ensurePracticeTable = () => (ready ??= q(PRACTICE_DDL).catch((e) => { ready = undefined; throw e; }));

// ---------- what was missed ----------

/**
 * The parts still wrong, from seed_results notes shaped "PS1 Q4(a): ...". The newest result per part wins, so a
 * part fixed in a later graded submission (or an earlier practice redo) is no longer counted as missed.
 */
export function stillMissed(rows: { correct: boolean; note: string | null }[]): Miss[] {
  const latest = new Map<string, Miss & { correct: boolean }>();
  for (const r of rows) { // rows arrive oldest first
    const m = r.note?.match(/^(PS\d+) Q(\S+?): ([\s\S]*)$/);
    if (m) latest.set(`${m[1]}/${partKey(m[2])}`, { set: m[1], number: m[2], note: m[3], correct: r.correct });
  }
  return [...latest.values()].filter((x) => !x.correct);
}

/** Pick the set to practice: the one with the most recent result among those with misses. */
const pickSet = (misses: Miss[]) => misses.at(-1)?.set;

// ---------- verbatim questions from the problem-set PDF ----------

const Extract = z.object({
  parts: z.array(z.object({
    number: z.string().describe("the part label exactly as requested, e.g. '4(a)'"),
    setup: z.string().describe("verbatim shared text this part depends on (the intro before the lettered parts, given values, definitions, tables); empty if none"),
    question: z.string().describe("verbatim text of this part's own question"),
    hint: z.string().describe("one short line to the student, second person, on what went wrong last time, without stating the full correct answer"),
  })),
});

async function extractQuestions(course: string, set: string, misses: Miss[]): Promise<z.infer<typeof Extract>["parts"]> {
  const pdf = (await officialFiles(course, set)).find((f) => !/solution|soln|answer/i.test(path.basename(f)));
  if (!pdf) throw new Error(`No ${set} problem set PDF on file for ${course}; run pnpm ingest first.`);
  const want = misses.map((m) => ({ number: m.number, what_went_wrong_last_time: unlatex(m.note) }));
  const r = await askJSON(Extract, [
    { type: "text", text: "The attached PDF is a problem set. Copy out the exact question text for the parts listed below." },
    fileBlock(pdf),
    { type: "text", text: `Parts: ${JSON.stringify(want)}

Rules:
- Verbatim. Do not paraphrase, shorten, solve, or add answers. Keep the part's own wording and numbers.
- Include the setup text the part depends on (the shared intro, given prices/incomes/functions, tables) in "setup". If several lettered parts share one intro, repeat the same intro for each. "setup" never contains text of any lettered part, and no question number or section heading ("5.", "Budget Constraints").
- If the part is a sub-part such as (b)(iv), "question" includes the lead-in of (b) that (iv) depends on, then the (iv) wording.
- Write math as LaTeX inside $...$ exactly as typeset, and every dollar amount as \\$ outside math (\\$200, never $200). If the part needs a figure or table you cannot copy as text, add a short bracketed note such as [see the graph in the problem set].
- "hint": one line, second person ("you"), from what_went_wrong_last_time. Say what slipped, not the final answer.
- Return exactly one entry per requested part, with "number" as requested.` },
  ], { system: "You transcribe exam questions accurately and never invent text.", maxTokens: 12000, effort: "low" });
  return r.parts;
}

export interface PracticeItem { number: string; setup: string; question: string; hint: string }

/** Verbatim questions + hints for the missed parts. Parts the model skipped fall back to the stored question text. */
export async function buildItems(course: string, set: string, misses: Miss[]): Promise<PracticeItem[]> {
  const stored = await q<{ number: string; question: string }>(`select number, question from problems where course = $1 and set_name = $2 order by id`, [course, set]);
  const got = new Map((await extractQuestions(course, set, misses)).map((p) => [partKey(p.number), p]));
  const items: PracticeItem[] = [];
  for (const s of stored) {
    const m = misses.find((x) => partKey(x.number) === partKey(s.number));
    if (!m) continue;
    const g = got.get(partKey(s.number));
    if (!g?.question.trim()) console.warn(`   ⚠ ${set} ${s.number} not found in the PDF extraction; using the ingested text`);
    items.push({ number: s.number, setup: g?.setup.trim() ?? "", question: g?.question.trim() || s.question, hint: g?.hint.trim() || unlatex(m.note) });
  }
  return items;
}

// ---------- the email ----------

const INTRO = (set: string) => `Before the midterm, redo these ${set.replace(/^PS/, "Problem Set ")} questions you missed. Work them on paper (graphs too), snap photos, and reply to this email with them attached. I'll grade them against the official solutions.`;
/** LaTeX to readable text; models sometimes double a dollar sign on money ("$$1"), which is never intended. */
const tex = (s: string) => latexToText(s).replace(/\$\$(?=\d)/g, "$");
const questionOf = (n: string) => n.match(/^\d+/)?.[0] ?? n;

export function renderPractice(set: string, items: PracticeItem[]): { subject: string; text: string; html: string } {
  const first = opt("STUDENT_NAME").split(/\s+/)[0];
  const groups = new Map<string, PracticeItem[]>();
  for (const it of items) groups.set(questionOf(it.number), [...(groups.get(questionOf(it.number)) ?? []), it]);
  // One setup per question: the longest version any of its parts carried.
  const setupOf = (ps: PracticeItem[]) => tex(ps.map((p) => p.setup).sort((a, b) => b.length - a.length)[0] ?? "").replace(/^(?:[^\n$]{0,40}\n)?\d+[.)]\s+/, "");
  // Parts often carry the setup inside their own text; don't show the same words twice.
  // The part label is printed as "Q4(a)." already, so drop a leading "(a)" the transcription carried along.
  const bodyOf = (p: PracticeItem, setup: string) => {
    let t = tex(p.question).replace(/\n(?:i{1,3}|iv|v)[.)]\s+/i, " "); // "...for the\niv. 170th coke?" is one sentence
    if (setup && t.startsWith(setup)) t = t.slice(setup.length).trim() || t;
    const label = p.number.replace(/^\d+/, "");
    return label && t.toLowerCase().startsWith(label.toLowerCase()) ? t.slice(label.length).replace(/^[.:]?\s+/, "") || t : t;
  };

  const text = [
    `${first ? `Hi ${first}, ` : ""}${INTRO(set)}`, "",
    ...[...groups.values()].flatMap((ps) => {
      const setup = setupOf(ps);
      return [...(setup ? [setup, ""] : []), ...ps.flatMap((p) => [`Q${p.number}. ${bodyOf(p, setup)}`, `   Last time: ${tex(p.hint)}`, ""])];
    }),
    "Reply with your photos attached (one email is fine). I'll mark each of these against the official solutions and tell you what's fixed.", "", "— NoteThing",
  ].join("\n");

  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;line-height:1.5;color:#222">
<p>${first ? `Hi ${esc(first)}, ` : ""}${esc(INTRO(set))}</p>
${[...groups.values()].map((ps) => {
    const setup = setupOf(ps);
    return `${setup ? `<p style="background:#fff4ec;border-radius:8px;padding:8px 12px">${esc(setup).replace(/\n/g, "<br>")}</p>` : ""}${ps.map((p) => `<p style="margin:10px 0 2px"><b>Q${esc(p.number)}.</b> ${esc(bodyOf(p, setup)).replace(/\n/g, "<br>")}</p><p style="margin:0 0 8px;color:#b4532a;font-size:14px">Last time: ${esc(tex(p.hint))}</p>`).join("")}`;
  }).join("")}
<p>Reply with your photos attached (one email is fine). I'll mark each of these against the official solutions and tell you what's fixed.</p><p style="color:#888">— NoteThing</p></div>`;
  return { subject: practiceSubject(set), text, html };
}

// ---------- the command ----------

/** `pnpm practice [course] [--dry-run] [--parts "4(a),5(f)"]`: email the parts still missed, as questions to redo. */
export async function practice(args: string[]) {
  const dry = args.includes("--dry-run");
  const pi = args.indexOf("--parts");
  const forced = pi >= 0 ? (args[pi + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const course = args.find((a, i) => !a.startsWith("--") && i !== pi + 1);
  for (const c of await courses(course)) {
    const rows = await q<{ correct: boolean; note: string | null }>(`select correct, note from seed_results where course = $1 order by id`, [c]);
    let misses = stillMissed(rows);
    const set = pickSet(misses);
    if (forced.length) {
      const sets = new Set(rows.map((r) => r.note?.match(/^(PS\d+) /)?.[1]).filter((s): s is string => !!s));
      const chosen = [...sets].at(-1) ?? "PS1";
      misses = forced.map((n) => misses.find((m) => partKey(m.number) === partKey(n)) ?? { set: chosen, number: n, note: "you asked to redo this one" });
    } else if (set) misses = misses.filter((m) => m.set === set);
    const target = forced.length ? misses[0].set : set;
    if (!target || !misses.length) { console.log(`${c}: nothing missed, nothing to practice.`); continue; }

    console.error(`→ ${c} ${target}: ${misses.length} part(s) to redo (${misses.map((m) => m.number).join(", ")})`);
    const items = await buildItems(c, target, misses);
    const { subject, text, html } = renderPractice(target, items);
    if (dry) { console.log(`Subject: ${subject}\n\n${text}`); continue; }

    const inbox = await ensureInbox();
    const to = need("STUDENT_EMAIL", "The address practice emails are sent to.");
    const res = await mail().inboxes.messages.send(inbox.id, { to: [to], subject, text, html, labels: ["notething", "practice"] });
    console.log(`✉️  Sent "${subject}" → ${to} (${items.length} questions)`);
    // The email is out; keep trying to record it so the reply can be graded against exactly these parts.
    await ensurePracticeTable();
    const parts: PracticePart[] = items.map((i) => ({ number: i.number, hint: i.hint }));
    for (let attempt = 1; ; attempt++) {
      try {
        await q(`insert into practice_sets (course, set_name, thread_id, message_id, parts) values ($1,$2,$3,$4,$5::jsonb)`, [c, target, res.threadId, res.messageId, JSON.stringify(parts)]);
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`Practice email sent (thread ${res.threadId}) but saving its part list failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
}

// ---------- grading the reply ----------

/** The parts a reply is redoing, if it answers a practice email (matched by thread, else by the practice subject). */
export async function practicePartsFor(target: { course: string; set: string }, threadId: string | undefined, subject: string): Promise<string[] | undefined> {
  await ensurePracticeTable();
  const byThread = threadId
    ? (await q<{ parts: PracticePart[] }>(`select parts from practice_sets where course = $1 and set_name = $2 and thread_id = $3 order by id desc limit 1`, [target.course, target.set, threadId]))[0]
    : undefined;
  const row = byThread ?? (PRACTICE_SUBJECT.test(subject)
    ? (await q<{ parts: PracticePart[] }>(`select parts from practice_sets where course = $1 and set_name = $2 order by id desc limit 1`, [target.course, target.set]))[0]
    : undefined);
  return row?.parts.map((p) => p.number);
}
