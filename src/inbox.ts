import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { q, claimMessage, ensureProcessedTable, failMessage, finishMessage, GIVE_UP_AFTER } from "./db.js";
import { need } from "./env.js";
import { gradeProblemSet, identifyProblemSet, recordWeakTopics, renderReport } from "./grade.js";
import { isImage } from "./llm.js";
import { practicePartsFor } from "./practice.js";
import { ensureInbox, esc, hasGradeable, isGradeable, mail, para, senderAddress } from "./mail.js";
import { errLabel, UserError } from "./redact.js";

/** Only look at recent mail so an old backlog is never graded by surprise. */
const LOOKBACK_DAYS = 7;

type Att = { attachmentId: string; filename?: string; contentType?: string; size: number; contentDisposition?: string };

/** Download a message's gradeable attachments into dir. HEIC photos are converted to JPEG when macOS `sips` is there; otherwise they're reported as skipped. */
async function download(inboxId: string, messageId: string, atts: Att[], dir: string) {
  const files: string[] = [];
  const skipped: string[] = [];
  for (const [i, a] of atts.filter(isGradeable).entries()) {
    const name = (a.filename ?? `attachment-${i + 1}`).replace(/[^\w.() -]/g, "_");
    const res = await mail().inboxes.messages.getAttachment(inboxId, messageId, a.attachmentId);
    const r = await fetch(res.downloadUrl);
    if (!r.ok) throw new UserError(`Couldn't download an attachment (HTTP ${r.status})`);
    let file = path.join(dir, `${i + 1}-${name}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    if (/\.hei[cf]$/i.test(file) || /hei[cf]/i.test(a.contentType ?? "")) {
      const jpg = file.replace(/\.[^.]+$/, "") + ".jpg";
      try { execFileSync("sips", ["-s", "format", "jpeg", file, "--out", jpg], { stdio: "ignore" }); file = jpg; } catch { skipped.push(name); continue; }
    }
    if (!/\.pdf$/i.test(file) && !isImage(file)) { skipped.push(name); continue; }
    files.push(file);
  }
  return { files, skipped };
}

const wrap = (inner: string) => `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px;line-height:1.5;color:#222">${inner}<p style="color:#888">— NoteThing</p></div>`;
async function replyShort(inboxId: string, messageId: string, body: string) {
  await mail().inboxes.messages.reply(inboxId, messageId, { text: `${body}\n\n— NoteThing`, html: wrap(`<p>${para(body)}</p>`) });
}

/**
 * Grade problem sets the student emails in: any recent message from them with a PDF or photos attached,
 * whether it starts a new thread or replies on a session thread. Each message is handled once.
 */
export async function pollInbox() {
  const inbox = await ensureInbox();
  await ensureProcessedTable();
  const student = need("STUDENT_EMAIL").toLowerCase();
  const list = await mail().inboxes.messages.list(inbox.id, { limit: 50, after: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000) });
  const incoming = list.messages.filter((m) => senderAddress(m.from) === student && hasGradeable(m)).reverse(); // oldest first

  for (const m of incoming) {
    if (!(await claimMessage(m.messageId))) continue; // already graded, or another poll has it
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notething-"));
    try {
      console.log("📎 Problem set received");
      const full = await mail().inboxes.messages.get(inbox.id, m.messageId);
      const note = full.extractedText ?? full.text ?? m.preview ?? "";
      const { files, skipped } = await download(inbox.id, m.messageId, full.attachments ?? m.attachments ?? [], dir);
      if (!files.length) {
        await replyShort(inbox.id, m.messageId, "I couldn't open the attachments on that email. Send your answers as a PDF or JPG/PNG photos and I'll grade them.");
        await finishMessage(m.messageId, "unreadable", skipped.join(", "));
        continue;
      }
      // A reply on one of our session emails tells us the course even when the subject never says "Problem Set N".
      const courseHint = m.threadId ? (await q<{ course: string }>(`select course from sessions where thread_id = $1 limit 1`, [m.threadId]))[0]?.course : undefined;
      const target = await identifyProblemSet(files, m.subject ?? "", note, courseHint);
      if (!target) {
        await replyShort(inbox.id, m.messageId, "Which problem set is this? I got your attachment but couldn't tell which one it answers. Reply with the set name (for example \"PS1\") and attach it again, and I'll grade it.");
        await finishMessage(m.messageId, "unknown_set");
        continue;
      }
      // A reply to a practice email is graded on just the parts that email asked for.
      const only = await practicePartsFor(target, m.threadId, m.subject ?? "");
      console.log(`   → ${only ? `practice redo (${only.length} parts), ` : ""}grading ${files.length} file(s)…`);
      const report = await gradeProblemSet(target, files, note, skipped, only);
      if (!report.found) {
        await replyShort(inbox.id, m.messageId, `I opened your attachment but couldn't find answers to ${target.set} in it. Make sure the pages are in focus and attached, then send it again.`);
        await finishMessage(m.messageId, "no_answers", target.set);
        continue;
      }
      await recordWeakTopics(report, `email:${m.messageId}`); // idempotent, so a retry after a failed send doesn't double up
      const { text, html } = renderReport(report);
      await mail().inboxes.messages.reply(inbox.id, m.messageId, { text, html });
      // The report is already in the student's inbox, so never let a bookkeeping failure trigger a second send.
      // Retry the write a few times; the claim stays in 'working' only if the database is down for all of them.
      for (let attempt = 1; ; attempt++) {
        try { await finishMessage(m.messageId, "graded", `${target.set} ${report.score.earned}/${report.score.possible}`); break; }
        catch (e) {
          if (attempt >= 3) { console.error(`   ⚠ report sent but status not recorded: ${errLabel(e)}`); break; }
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      console.log("   ✓ graded, report sent");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failures = await failMessage(m.messageId, msg);
      console.error(`   ✗ grading failed (${failures}/${GIVE_UP_AFTER}): ${errLabel(e)}`);
      if (failures === GIVE_UP_AFTER) { // exactly once, so a racing process can't send a second apology
        try { await replyShort(inbox.id, m.messageId, "I couldn't grade that one, even after a few tries. Try sending it again as a single PDF; if it keeps failing, something is up on my end."); } catch { /* best effort */ }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
