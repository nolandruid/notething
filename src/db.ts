import { neon } from "@neondatabase/serverless";
import { need, opt } from "./env.js";

type Sql = ReturnType<typeof neon>;
let _sql: Sql | undefined;

/** Neon HTTP client (tagged template: sql`select ...`). */
export function db(): Sql {
  _sql ??= neon(opt("DEMO_DATABASE_URL") || need("DATABASE_URL", "Create a free Postgres DB at https://neon.tech and paste its connection string."));
  return _sql;
}

/** One-line, secret-free description of which database we're talking to. */
export const dbLabel = () => (opt("DEMO_DATABASE_URL") ? 'db: demo branch "demo-run"' : "db: main");

/** Run a parameterized query and get typed rows back. */
export async function q<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as T[];
}

const PROCESSED_DDL = `create table if not exists processed_messages (
     message_id text primary key, kind text not null, detail text, failures int not null default 0,
     created_at timestamptz default now())`;

const SCHEMA = [
  `create table if not exists courses (name text primary key, created_at timestamptz default now())`,
  `create table if not exists documents (
     id serial primary key, course text not null references courses(name), path text not null,
     hash text not null unique, kind text not null check (kind in ('notes','slides','syllabus','video','problemset','student_work')),
     created_at timestamptz default now())`,
  `create table if not exists notes (
     id serial primary key, course text not null, title text not null, slug text not null,
     markdown text not null, source_doc text, lecture text, created_at timestamptz default now(),
     unique (course, slug))`,
  `create table if not exists concepts (
     id serial primary key, course text not null, name text not null, note_slug text not null,
     unique (course, name, note_slug))`,
  `create table if not exists tests (
     id serial primary key, course text not null, name text not null, date date,
     topics text[] not null default '{}', unique (course, name))`,
  `create table if not exists sessions (
     id serial primary key, course text not null, scheduled_for timestamptz not null,
     kind text not null default 'learn', test_name text, topics text[] not null default '{}',
     note_slugs text[] not null default '{}', status text not null default 'pending',
     sent_message_id text, thread_id text, sent_at timestamptz, created_at timestamptz default now())`,
  `create table if not exists quiz_items (
     id serial primary key, session_id int not null references sessions(id) on delete cascade,
     question text not null, answer text not null, topic text not null, note_slug text,
     is_retry boolean not null default false)`,
  `create table if not exists attempts (
     id serial primary key, quiz_item_id int not null references quiz_items(id) on delete cascade,
     response text, correct boolean not null, feedback text, reply_message_id text,
     created_at timestamptz default now())`,
  `create table if not exists problems (
     id serial primary key, course text not null, set_name text not null, number text not null,
     topic text not null, question text not null, solution text, unique (course, set_name, number))`,
  `create table if not exists seed_results (
     id serial primary key, course text not null, topic text not null, correct boolean not null,
     source text not null, note text)`,
  `create table if not exists practice_sets (
     id serial primary key, course text not null, set_name text not null,
     thread_id text, message_id text, parts jsonb not null, created_at timestamptz default now())`,
  `create table if not exists settings (key text primary key, value text not null)`,
  PROCESSED_DDL,
];

export async function migrate() {
  for (const stmt of SCHEMA) await q(stmt);
  console.log(`✓ Migrated (${SCHEMA.length} tables)`);
}

export async function getSetting(key: string): Promise<string | undefined> {
  return (await q<{ value: string }>(`select value from settings where key = $1`, [key]))[0]?.value;
}
export async function setSetting(key: string, value: string) {
  await q(`insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = $2`, [key, value]);
}

/** "Now", possibly advanced by fast-forward demo mode. */
export async function now(): Promise<Date> {
  const ff = await getSetting("clock");
  const real = new Date();
  return ff && new Date(ff) > real ? new Date(ff) : real;
}

export async function ensureCourse(name: string) {
  await q(`insert into courses (name) values ($1) on conflict do nothing`, [name]);
}

export async function courses(only?: string): Promise<string[]> {
  if (only) return [only];
  return (await q<{ name: string }>(`select name from courses order by name`)).map((r) => r.name);
}

// ---------- inbound messages we've already dealt with ----------

const MAX_FAILURES = 3;
let processedReady: Promise<unknown> | undefined;
/** Older databases predate `processed_messages`; create it on first use so `pnpm poll` works without re-migrating. */
export function ensureProcessedTable() {
  processedReady ??= q(PROCESSED_DDL).catch((e) => { processedReady = undefined; throw e; });
  return processedReady;
}

/** True once a message is claimed, finished, or has failed too many times to retry. */
export async function isProcessed(id: string): Promise<boolean> {
  await ensureProcessedTable();
  const r = (await q<{ kind: string; failures: number }>(`select kind, failures from processed_messages where message_id = $1`, [id]))[0];
  return !!r && !(r.kind === "failed" && r.failures < MAX_FAILURES);
}

/** How long a message may sit in `working` before we assume the process that claimed it died. */
const STALE_CLAIM = "30 minutes";

/** Atomically take ownership of a message so it is never handled twice. A previously failed message can be re-claimed until it has failed MAX_FAILURES times, and a claim abandoned by a crashed process can be taken over after STALE_CLAIM. */
export async function claimMessage(id: string, kind = "working"): Promise<boolean> {
  await ensureProcessedTable();
  const r = await q(
    `insert into processed_messages (message_id, kind) values ($1, $2)
     on conflict (message_id) do update set kind = $2, created_at = now()
       where (processed_messages.kind = 'failed' and processed_messages.failures < $3)
          or (processed_messages.kind = 'working' and processed_messages.created_at < now() - $4::interval)
     returning message_id`, [id, kind, MAX_FAILURES, STALE_CLAIM]);
  return r.length > 0;
}

export async function finishMessage(id: string, kind: string, detail?: string) {
  await q(`update processed_messages set kind = $2, detail = $3 where message_id = $1`, [id, kind, detail ?? null]);
}

/** Record a failure; returns the new failure count (the caller gives up at MAX_FAILURES). */
export async function failMessage(id: string, error: string): Promise<number> {
  const r = await q<{ failures: number }>(
    `update processed_messages set kind = 'failed', detail = $2, failures = failures + 1 where message_id = $1 returning failures`, [id, error.slice(0, 500)]);
  return r[0]?.failures ?? MAX_FAILURES;
}
export const GIVE_UP_AFTER = MAX_FAILURES;
