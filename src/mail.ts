import { AgentMailClient } from "agentmail";
import path from "node:path";
import { z } from "zod";
import { claimMessage, ensureProcessedTable, getSetting, isProcessed, now, q, setSetting } from "./db.js";
import { isoDate, need, opt, parseDay, STUDY_HOUR, VAULT_DIR } from "./env.js";
import { askJSON } from "./llm.js";

interface Session {
  id: number; course: string; scheduled_for: Date; kind: string; test_name: string | null;
  topics: string[]; note_slugs: string[]; status: string; thread_id: string | null;
}
interface QuizItem { id: number; question: string; answer: string; topic: string; note_slug: string | null; is_retry: boolean }

let _mail: AgentMailClient | undefined;
export const mail = () => (_mail ??= new AgentMailClient({ apiKey: need("AGENTMAIL_API_KEY", "Get one at https://agentmail.to") }));

// ---------- inbox ----------

/** Returns { id, email } of the coach inbox, creating `notething@agentmail.to` on first use. */
export async function ensureInbox(): Promise<{ id: string; email: string }> {
  const env = opt("AGENTMAIL_INBOX");
  if (env) {
    const inbox = await mail().inboxes.get(env);
    return { id: inbox.inboxId, email: inbox.email };
  }
  const saved = await getSetting("agentmail_inbox");
  if (saved) return JSON.parse(saved);
  let inbox;
  try {
    inbox = await mail().inboxes.create({ username: "notething", displayName: "NoteThing Coach", clientId: "notething-coach" });
  } catch {
    // Username taken by someone else: let AgentMail pick one (clientId keeps this idempotent).
    inbox = await mail().inboxes.create({ displayName: "NoteThing Coach", clientId: "notething-coach-auto" });
  }
  const out = { id: inbox.inboxId, email: inbox.email };
  await setSetting("agentmail_inbox", JSON.stringify(out));
  console.log(`📬 Created AgentMail inbox: ${out.email}\n   (set AGENTMAIL_INBOX=${out.id} in .env to pin it)`);
  return out;
}

// ---------- coach stats ----------

interface Stats { byTopic: Record<string, { right: number; total: number }>; lastTime: string[]; streak: number }

async function stats(course: string): Promise<Stats> {
  const rows = await q<{ topic: string; correct: boolean }>(
    `select qi.topic, a.correct from attempts a join quiz_items qi on qi.id = a.quiz_item_id join sessions s on s.id = qi.session_id where s.course = $1
     union all select topic, correct from seed_results where course = $1`, [course]);
  const byTopic: Stats["byTopic"] = {};
  for (const r of rows) { const t = (byTopic[r.topic.toLowerCase()] ??= { right: 0, total: 0 }); t.total++; if (r.correct) t.right++; }

  const last = (await q<{ id: number }>(`select id from sessions where course = $1 and status = 'graded' order by sent_at desc limit 1`, [course]))[0];
  const lastTime = last ? (await q<{ topic: string; right: number; total: number }>(
    `select qi.topic, count(*) filter (where a.correct)::int as right, count(*)::int as total
     from quiz_items qi join attempts a on a.quiz_item_id = qi.id where qi.session_id = $1 group by qi.topic`, [last.id]))
    .map((r) => `${r.topic}: ${r.right}/${r.total}`) : [];
  const seeds = await q<{ note: string }>(`select note from seed_results where course = $1 and not correct limit 8`, [course]);
  if (!last && seeds.length) lastTime.push(...seeds.map((s) => `missed on problem set — ${s.note}`));

  const recent = await q<{ status: string }>(`select status from sessions where course = $1 and status in ('sent','graded') order by sent_at desc`, [course]);
  let streak = 0;
  for (const r of recent) { if (r.status !== "graded") { if (streak === 0) continue; break; } streak++; }
  return { byTopic, lastTime, streak };
}

const progressLine = (s: Stats) => {
  const acc = Object.entries(s.byTopic).sort((a, b) => a[1].right / a[1].total - b[1].right / b[1].total)
    .slice(0, 5).map(([t, v]) => `${t} ${Math.round((100 * v.right) / v.total)}%`);
  return `🔥 Streak: ${s.streak} session${s.streak === 1 ? "" : "s"}${acc.length ? ` · Accuracy: ${acc.join(" · ")}` : " · Accuracy: no data yet"}`;
};

// ---------- composing a session ----------

const SessionSchema = z.object({
  subject: z.string().describe("email subject, specific and motivating, <70 chars"),
  opener: z.string().describe("2-3 sentences, coach voice: encouraging but direct; reference past performance explicitly when there is any"),
  task: z.string().describe("clear instructions for today: what to read, in what order, what to focus on"),
  minutes: z.number().describe("realistic time estimate for the whole session"),
  note_summaries: z.array(z.object({ slug: z.string(), summary: z.string().describe("3-5 sentence recap of the note's key ideas") })),
  questions: z.array(z.object({
    question: z.string(), answer: z.string().describe("model answer used for grading"),
    topic: z.string().describe("short concept name, consistent with past topic names"), note_slug: z.string(),
  })),
});

export const COACH = `You are NoteThing, a personal study coach emailing a university student one study session at a time.
Voice: warm, encouraging, but direct and specific — like a great TA. No fluff, no emojis spam. Plain text (light markdown ok, LaTeX as $...$).
Use the student's track record: name weak topics and numbers ("you missed 2/3 on elasticity last time, so today we revisit it").
Quiz questions should be exam-style (model them on the course's problem sets when provided), answerable by email in a few lines.`;

async function composeSession(s: Session) {
  const notes = await q<{ slug: string; title: string; markdown: string }>(`select slug, title, markdown from notes where course = $1 and slug = any($2)`, [s.course, s.note_slugs]);
  const problems = await q(`select set_name, number, topic, question, solution from problems where course = $1 limit 40`, [s.course]);
  const retries = await q<QuizItem>(`select * from quiz_items where session_id = $1 and is_retry`, [s.id]);
  const st = await stats(s.course);
  const test = s.test_name ? (await q<{ date: string }>(`select to_char(date,'YYYY-MM-DD') as date from tests where course = $1 and name = $2`, [s.course, s.test_name]))[0] : undefined;
  const today = await now();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysLeft = test?.date ? Math.round((parseDay(test.date).getTime() - startOfToday.getTime()) / 86400000) : undefined;
  const nNew = Math.max(2, 5 - retries.length);

  const plan = await askJSON(SessionSchema, [{
    type: "text",
    text: `Session #${s.id} (${s.kind}) for ${s.course}, ${isoDate(today)}${s.test_name ? ` — preparing for ${s.test_name}${daysLeft !== undefined ? ` in ${daysLeft} days` : ""}` : ""}.
Topics: ${s.topics.join("; ")}
Track record by topic: ${JSON.stringify(st.byTopic)}
Last time: ${st.lastTime.join("; ") || "first session"}
Streak: ${st.streak}
Retry questions already included (missed before): ${JSON.stringify(retries.map((r) => r.question))}

Write ${nNew} NEW quiz questions (prioritize weak topics within today's notes), a summary per note, and the email copy.

<notes>
${notes.map((n) => `<note slug="${n.slug}">\n${n.markdown}\n</note>`).join("\n")}
</notes>
<problem_sets>
${JSON.stringify(problems)}
</problem_sets>`,
  }], { system: COACH, maxTokens: 16000 });

  for (const qn of plan.questions.slice(0, nNew))
    await q(`insert into quiz_items (session_id, question, answer, topic, note_slug) values ($1,$2,$3,$4,$5)`, [s.id, qn.question, qn.answer, qn.topic, qn.note_slug]);
  const items = await q<QuizItem>(`select * from quiz_items where session_id = $1 order by is_retry desc, id`, [s.id]);
  return { plan, items, notes, progress: progressLine(st) };
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const para = (s: string) => esc(s).replace(/\n/g, "<br>");
export const notePath = (course: string, slug: string) => path.join(VAULT_DIR, course, `${slug}.md`);
export const obsidian = (p: string) => `obsidian://open?path=${encodeURIComponent(p)}`;

function render(s: Session, c: Awaited<ReturnType<typeof composeSession>>) {
  const { plan, items, notes, progress } = c;
  const title = (slug: string) => notes.find((n) => n.slug === slug)?.title ?? slug;
  const text = [
    plan.opener, "", progress, "",
    `TODAY (~${plan.minutes} min)`, plan.task, "",
    "READ", ...plan.note_summaries.map((n) => `• ${title(n.slug)} — ${notePath(s.course, n.slug)}\n  ${n.summary}`), "",
    "QUIZ", ...items.map((it, i) => `${i + 1}. ${it.is_retry ? "[retry] " : ""}${it.question}`), "",
    "Reply to this email with your answers (number them 1, 2, 3…). I'll grade them and adjust your plan.",
    "", "— NoteThing",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;line-height:1.5;color:#222">
<p>${para(plan.opener)}</p>
<p style="background:#fff4ec;border-radius:8px;padding:8px 12px;font-size:14px">${esc(progress)}</p>
<h3 style="margin-bottom:4px">Today · ~${plan.minutes} min</h3><p>${para(plan.task)}</p>
<h3 style="margin-bottom:4px">Read</h3>
${plan.note_summaries.map((n) => `<p><a href="${obsidian(notePath(s.course, n.slug))}"><b>${esc(title(n.slug))}</b></a><br><span style="color:#555">${para(n.summary)}</span></p>`).join("\n")}
<h3 style="margin-bottom:4px">Quiz</h3>
<ol>${items.map((it) => `<li style="margin-bottom:8px">${it.is_retry ? '<span style="color:#b4532a">[retry]</span> ' : ""}${para(it.question)}</li>`).join("")}</ol>
<p><b>Reply to this email with your answers</b> (number them 1, 2, 3…). I'll grade them and adjust your plan.</p>
<p style="color:#888">— NoteThing</p></div>`;
  return { text, html };
}

export async function sendSession(s: Session) {
  const inbox = await ensureInbox();
  const to = need("STUDENT_EMAIL", "The address study sessions are emailed to.");
  const composed = await composeSession(s);
  const { text, html } = render(s, composed);
  const res = await mail().inboxes.messages.send(inbox.id, {
    to: [to], subject: composed.plan.subject, text, html, labels: ["notething", `session-${s.id}`],
  });
  await q(`update sessions set status = 'sent', sent_message_id = $2, thread_id = $3, sent_at = $4 where id = $1`, [s.id, res.messageId, res.threadId, await now()]);
  console.log(`✉️  Sent session #${s.id} "${composed.plan.subject}" → ${to} (${composed.items.length} questions)`);
}

export async function sendNext(): Promise<boolean> {
  const t = await now();
  const s = (await q<Session>(`select * from sessions where status = 'pending' and scheduled_for <= $1 order by scheduled_for limit 1`, [t]))[0];
  if (!s) {
    const next = (await q<Session>(`select * from sessions where status = 'pending' order by scheduled_for limit 1`))[0];
    console.log(next ? `Nothing due. Next session #${next.id} at ${new Date(next.scheduled_for).toLocaleString()}.` : "No pending sessions; run plan.");
    return false;
  }
  await sendSession(s);
  return true;
}

/** Demo mode: jump the clock to each of the next n sessions and send them now. */
export async function fastForward(n: number) {
  const list = await q<Session>(`select * from sessions where status = 'pending' order by scheduled_for limit $1`, [n]);
  if (!list.length) return console.log("No pending sessions; run plan.");
  for (const s of list) {
    await setSetting("clock", new Date(s.scheduled_for).toISOString());
    console.log(`⏩ Clock → ${new Date(s.scheduled_for).toLocaleString()}`);
    await sendSession(s);
  }
}

// ---------- replies & grading ----------

/** "Nolan <nolan@x.com>" -> "nolan@x.com" (lowercased). */
export const senderAddress = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

const GradeSchema = z.object({
  results: z.array(z.object({
    quiz_item_id: z.number(),
    response: z.string().describe("the student's answer to this question (empty if skipped)"),
    correct: z.boolean(),
    feedback: z.string().describe("1-2 sentences, specific"),
    reexplain: z.string().describe("for misses: a short, clear re-explanation of the concept (3-5 sentences); empty if correct"),
  })),
  summary: z.string().describe("2-3 sentence coach wrap-up: score, what's solid, what we'll revisit next session"),
});

export interface Retry { question: string; answer: string; topic: string; note_slug: string | null }

/**
 * Push missed material into the next pending session (creating a practice session if none is left):
 * its topics + notes get a "revisit" entry and each missed question comes back as a retry quiz item.
 * Safe to call twice for the same items.
 */
export async function pushRetries(target: { course: string; test_name: string | null }, missed: Retry[]) {
  if (!missed.length) return;
  let next = (await q<Session>(`select * from sessions where course = $1 and status = 'pending' order by scheduled_for limit 1`, [target.course]))[0];
  if (!next) {
    const d = await now(); d.setDate(d.getDate() + 1); d.setHours(STUDY_HOUR, 0, 0, 0);
    next = (await q<Session>(`insert into sessions (course, scheduled_for, kind, test_name) values ($1,$2,'practice',$3) returning *`, [target.course, d, target.test_name]))[0];
  }
  const topics = [...new Set([...next.topics, ...missed.map((m) => `revisit: ${m.topic}`)])];
  const slugs = [...new Set([...next.note_slugs, ...missed.map((m) => m.note_slug).filter((x): x is string => !!x)])];
  await q(`update sessions set topics = $2, note_slugs = $3 where id = $1`, [next.id, topics, slugs]);
  for (const m of missed)
    await q(`insert into quiz_items (session_id, question, answer, topic, note_slug, is_retry)
             select $1::int,$2::text,$3::text,$4::text,$5::text,true where not exists (select 1 from quiz_items where session_id = $1::int and question = $2::text and is_retry)`,
      [next.id, m.question, m.answer, m.topic, m.note_slug]);
  console.log(`   ↻ ${missed.length} missed topic(s) pushed into session #${next.id}`);
}

const bumpWeakTopics = (s: Session, missed: QuizItem[]) => pushRetries(s, missed);

// ---------- replies that aren't really answers ----------

/** Words that make up a reply like "Test", "ok thanks" or "got it": not an attempt at the quiz. */
const FILLER = new Set(["test", "testing", "tests", "ok", "okay", "k", "kk", "thanks", "thank", "you", "thx", "ty", "hi", "hello", "hey", "yes", "yeah", "yep", "no", "sure", "got", "it", "done", "cool", "nice", "great", "good", "please", "lol", "hmm", "a", "the", "this", "is", "works", "working"]);

/** Drop quoted history ("> ..." lines, "On <date> ... wrote:" and everything after it) and a "Sent from" footer. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (/^\s*(on .{5,200}wrote:?|-{2,}\s*original message\s*-{2,}|from:\s.+@.+)\s*$/i.test(line) || /^\s*sent from my /i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** True when a reply has no real answers: empty after stripping quoted text, or only filler like "Test" / "ok". */
export function isEmptyAnswer(text: string): boolean {
  const t = stripQuoted(text);
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  if (/\d/.test(t)) return false; // numbered answers, numbers, equations
  const words = t.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  return words.length <= 6 && words.every((w) => FILLER.has(w));
}

/** PDFs and photos worth grading (ignores tiny inline signature images). */
export function isGradeable(a: { filename?: string; contentType?: string; size: number; contentDisposition?: string }): boolean {
  if (a.size < 5_000 || (a.contentDisposition === "inline" && a.size < 50_000)) return false;
  const kind = `${a.contentType ?? ""} ${a.filename ?? ""}`.toLowerCase();
  return /application\/pdf|image\/|\.(pdf|png|jpe?g|webp|gif|heic|heif)\b/.test(kind);
}
export const hasGradeable = (m: { attachments?: { filename?: string; contentType?: string; size: number; contentDisposition?: string }[] }) => !!m.attachments?.some(isGradeable);

async function askForAnswers(inboxId: string, messageId: string) {
  const text = "I didn't see any answers in that reply, so I haven't graded anything. Reply with your answers numbered 1, 2, 3… (just a line or two each is fine) and I'll grade them. This session stays open until then.\n\n— NoteThing";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;line-height:1.5;color:#222"><p>I didn't see any answers in that reply, so I haven't graded anything.</p><p>Reply with your answers numbered 1, 2, 3… (just a line or two each is fine) and I'll grade them. This session stays open until then.</p><p style="color:#888">— NoteThing</p></div>`;
  await mail().inboxes.messages.reply(inboxId, messageId, { text, html });
}

export async function pollReplies() {
  const inbox = await ensureInbox();
  await ensureProcessedTable();
  const student = need("STUDENT_EMAIL").toLowerCase();
  const open = await q<Session>(`select * from sessions where status = 'sent' and thread_id is not null order by sent_at`);
  const bodyOf = (m: { extractedText?: string; text?: string; preview?: string }) => m.extractedText ?? m.text ?? m.preview ?? "";
  for (const s of open) {
    const thread = await mail().inboxes.threads.get(inbox.id, s.thread_id!);
    // Only the student can answer: ignore the coach's own messages and anyone else on the thread.
    // Replies with PDFs/photos attached are emailed problem sets; pollInbox grades those.
    const candidates = thread.messages.filter((m) => senderAddress(m.from) === student && !hasGradeable(m));
    const fresh: typeof candidates = [];
    for (const m of candidates) if (!(await isProcessed(m.messageId))) fresh.push(m);
    if (!fresh.length) continue;

    // Grade the latest reply that has real answers; "Test" / "ok" follow-ups don't count.
    const reply = [...fresh].reverse().find((m) => !isEmptyAnswer(bodyOf(m)));
    const dismiss = async (kept?: string) => {
      const claimed: string[] = [];
      for (const m of fresh) if (m.messageId !== kept && (await claimMessage(m.messageId, "no_answers"))) claimed.push(m.messageId);
      return claimed;
    };
    if (!reply) {
      const claimed = await dismiss();
      if (claimed.length) {
        console.log(`📥 Reply on session #${s.id} has no answers; asking for them (session stays open)`);
        await askForAnswers(inbox.id, fresh.at(-1)!.messageId);
      }
      continue;
    }
    const answer = bodyOf(reply);
    const items = await q<QuizItem>(`select * from quiz_items where session_id = $1 order by is_retry desc, id`, [s.id]);
    console.log(`📥 Reply on session #${s.id} from ${reply.from}; grading ${items.length} answers…`);
    const g = await askJSON(GradeSchema, [{
      type: "text",
      text: `Grade the student's emailed answers. Questions in the order they were numbered in the email:\n${JSON.stringify(items.map((it, i) => ({ n: i + 1, quiz_item_id: it.id, question: it.question, model_answer: it.answer, topic: it.topic })))}\n\n<student_reply>\n${answer}\n</student_reply>\n\nBe fair: accept equivalent reasoning and notation. Missing answers are incorrect.`,
    }], { system: COACH, maxTokens: 8000 });

    const byId = new Map(items.map((it) => [it.id, it]));
    // Only trust results that point at a real question in this session, once each.
    const seen = new Set<number>();
    const results = g.results.filter((r) => byId.has(r.quiz_item_id) && !seen.has(r.quiz_item_id) && !!seen.add(r.quiz_item_id));
    if (!results.length) throw new Error("The grader's results didn't match any question in this session");
    if (results.every((r) => !r.response.trim())) {
      // The model found nothing it could call an answer: don't count a blank reply as all wrong.
      console.log(`📥 Reply on session #${s.id} has no answers; asking for them (session stays open)`);
      await dismiss();
      await askForAnswers(inbox.id, reply.messageId);
      continue;
    }
    for (const r of results)
      await q(`insert into attempts (quiz_item_id, response, correct, feedback, reply_message_id) values ($1,$2,$3,$4,$5)`, [r.quiz_item_id, r.response, r.correct, r.feedback, reply.messageId]);
    await dismiss(reply.messageId);

    const missed = results.filter((r) => !r.correct).map((r) => byId.get(r.quiz_item_id)).filter((x): x is QuizItem => !!x);
    const score = `${results.length - missed.length}/${results.length}`;

    const text = [g.summary, "", `Score: ${score}`, "", ...results.map((r, i) => {
      const it = byId.get(r.quiz_item_id);
      return `${i + 1}. ${r.correct ? "✅" : "❌"} ${it?.question ?? ""}\n   ${r.feedback}${r.reexplain ? `\n   Quick re-explain: ${r.reexplain}` : ""}${!r.correct && it ? `\n   Model answer: ${it.answer}` : ""}`;
    }), "", missed.length ? "I've added these to your next session so we lock them in." : "Clean sweep. Next session will push a bit further.", "", "— NoteThing"].join("\n");
    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;line-height:1.5;color:#222">
<p>${para(g.summary)}</p><p><b>Score: ${score}</b></p><ol>${results.map((r) => {
      const it = byId.get(r.quiz_item_id);
      return `<li style="margin-bottom:10px">${r.correct ? "✅" : "❌"} ${para(it?.question ?? "")}<br><span style="color:#444">${para(r.feedback)}</span>${r.reexplain ? `<br><span style="color:#b4532a"><b>Re-explain:</b> ${para(r.reexplain)}</span>` : ""}${!r.correct && it ? `<br><span style="color:#555"><b>Model answer:</b> ${para(it.answer)}</span>` : ""}</li>`;
    }).join("")}</ol><p>${missed.length ? "I've added these to your next session so we lock them in." : "Clean sweep. Next session will push a bit further."}</p><p style="color:#888">— NoteThing</p></div>`;

    await mail().inboxes.messages.reply(inbox.id, reply.messageId, { text, html });
    await q(`update sessions set status = 'graded' where id = $1`, [s.id]);
    await bumpWeakTopics(s, missed);
    console.log(`   ✓ graded ${score}, feedback sent`);
  }
}
