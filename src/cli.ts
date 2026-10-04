import { migrate } from "./db.js";
import { ingest } from "./ingest.js";
import { gradeFiles } from "./gradecli.js";
import { pollInbox } from "./inbox.js";
import { ensureInbox, fastForward, pollReplies, sendNext } from "./mail.js";
import { plan } from "./plan.js";
import { errLabel, UserError } from "./redact.js";

const [cmd, arg, ...rest] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELP = `NoteThing — your course, read for you.

  pnpm migrate              create database tables
  pnpm ingest [course]      turn content/<course>/ files into Obsidian notes (+ tests, problem sets)
  pnpm plan [course]        build the study schedule toward each test
  pnpm send-next            email the next due study session
  pnpm poll                 grade replies and emailed problem sets, adjust the plan
  pnpm grade <file...>      dry run: grade a problem set PDF/photos and print the report (no email, no DB writes)
  pnpm fast-forward <n>     demo: send the next n sessions right now
  pnpm start                ingest + send + poll every 60s (alias: pnpm run run)
  pnpm inbox                create/show the AgentMail inbox`;

async function main() {
  switch (cmd) {
    case "migrate": return migrate();
    case "ingest": return ingest(arg);
    case "plan": return plan(arg);
    case "send-next": return void (await sendNext());
    case "poll": { await pollInbox(); return pollReplies(); }
    case "grade": return gradeFiles([arg, ...rest].filter((f): f is string => !!f));
    case "fast-forward": {
      const n = Number(arg ?? 1);
      if (!Number.isInteger(n) || n < 1) throw new UserError("usage: fast-forward <n>");
      return fastForward(n);
    }
    case "inbox": { const i = await ensureInbox(); return console.log(`📬 ${i.email}`); }
    case "run": {
      console.log("🔁 NoteThing running (Ctrl-C to stop)");
      for (;;) {
        for (const step of [() => ingest(), async () => { while (await sendNext()); }, async () => { await pollInbox(); await pollReplies(); }]) {
          try { await step(); } catch (e) { console.error(`✗ ${errLabel(e)}`); }
        }
        await sleep(60_000);
      }
    }
    default: console.log(HELP);
  }
}

main().catch((e) => { console.error(`\n✗ ${errLabel(e)}`); process.exit(1); });
