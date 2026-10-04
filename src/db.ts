import { neon } from "@neondatabase/serverless";
import { need } from "./env.js";

type Sql = ReturnType<typeof neon>;
let _sql: Sql | undefined;

/** Neon HTTP client (tagged template: sql`select ...`). */
export function db(): Sql {
  _sql ??= neon(need("DATABASE_URL", "Create a free Postgres DB at https://neon.tech and paste its connection string."));
  return _sql;
}

/** Run a parameterized query and get typed rows back. */
export async function q<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as T[];
}

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
  `create table if not exists settings (key text primary key, value text not null)`,
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
