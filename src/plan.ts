import { z } from "zod";
import { courses, now, q } from "./db.js";
import { isoDate, STUDY_HOUR } from "./env.js";
import { askJSON } from "./llm.js";

interface Note { slug: string; title: string; lecture: string | null }
interface Test { name: string; date: string | null; topics: string[] }

const at = (day: Date) => { const d = new Date(day); d.setHours(STUDY_HOUR, 0, 0, 0); return d; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

/** Ask the model which notes each test covers (falls back to "all notes"). */
async function mapTestsToNotes(tests: Test[], notes: Note[]): Promise<Record<string, string[]>> {
  const all = Object.fromEntries(tests.map((t) => [t.name, notes.map((n) => n.slug)]));
  if (notes.length <= 1) return all;
  try {
    const r = await askJSON(z.object({ tests: z.array(z.object({ name: z.string(), note_slugs: z.array(z.string()) })) }), [{
      type: "text",
      text: `Map each test to the lecture notes it covers.\nTests: ${JSON.stringify(tests)}\nNotes: ${JSON.stringify(notes)}\nReturn every test by its exact name with the slugs of the notes it covers (cumulative exams cover everything up to them).`,
    }], { maxTokens: 4000, effort: "low" });
    const valid = new Set(notes.map((n) => n.slug));
    for (const t of r.tests) {
      const slugs = t.note_slugs.filter((s) => valid.has(s));
      if (slugs.length && t.name in all) all[t.name] = slugs;
    }
  } catch (e) { console.warn(`  ! topic mapping failed (${(e as Error).message}); using all notes for every test`); }
  return all;
}

/**
 * Rebuild the pending schedule: from today until each dated test, spread that test's notes over
 * the available days (new lectures first, each with a spaced revisit of the previous one), then
 * practice sessions every other day, and a full review session the day before the test.
 */
export async function plan(only?: string) {
  for (const course of await courses(only)) {
    const notes = await q<Note>(`select slug, title, lecture from notes where course = $1 order by lecture nulls last, id`, [course]);
    if (!notes.length) { console.log(`${course}: no notes yet; run ingest first`); continue; }
    const today = await now();
    let tests = (await q<Test>(`select name, to_char(date, 'YYYY-MM-DD') as date, topics from tests where course = $1 and date >= $2::date order by date`, [course, isoDate(today)]));
    if (!tests.length) tests = [{ name: "Self-check (no test dates found)", date: isoDate(addDays(today, 7)), topics: [] }];
    const covers = await mapTestsToNotes(tests, notes);
    const title = (slug: string) => notes.find((n) => n.slug === slug)?.title ?? slug;

    await q(`delete from sessions where course = $1 and status = 'pending'`, [course]);
    let start = today.getHours() < STUDY_HOUR ? today : addDays(today, 1);
    start = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let made = 0;
    for (const test of tests) {
      const testDay = parseDay(test.date!);
      const days: Date[] = [];
      for (let d = start; d < testDay; d = addDays(d, 1)) days.push(d);
      if (!days.length) continue;
      const slugs = covers[test.name];
      const reviewDay = days.length >= 2 ? days.pop()! : undefined;
      // Learn: new lectures on consecutive days (with a spaced revisit of the previous one).
      const perDay = Math.ceil(slugs.length / days.length) || 1;
      let prev: string[] = [], d = 0;
      for (let i = 0; i < slugs.length && d < days.length; i += perDay, d++) {
        const fresh = slugs.slice(i, i + perDay);
        const noteSlugs = [...fresh, ...prev.slice(0, 1)];
        await q(`insert into sessions (course, scheduled_for, kind, test_name, topics, note_slugs) values ($1,$2,'learn',$3,$4,$5)`,
          [course, at(days[d]), test.name, noteSlugs.map(title), noteSlugs]);
        prev = fresh; made++;
      }
      // Practice: every other remaining day, cycle through the material (weak topics get pulled in at send time).
      for (let k = 0, dd = d + 1; dd < days.length; dd += 2, k++) {
        const noteSlugs = [slugs[k % slugs.length], slugs[(k + 1) % slugs.length]].filter((x, j, arr) => arr.indexOf(x) === j);
        await q(`insert into sessions (course, scheduled_for, kind, test_name, topics, note_slugs) values ($1,$2,'practice',$3,$4,$5)`,
          [course, at(days[dd]), test.name, noteSlugs.map(title), noteSlugs]);
        made++;
      }
      if (reviewDay) {
        await q(`insert into sessions (course, scheduled_for, kind, test_name, topics, note_slugs) values ($1,$2,'review',$3,$4,$5)`,
          [course, at(reviewDay), test.name, [`${test.name} review`, ...slugs.slice(0, 5).map(title)], slugs]);
        made++;
      }
      start = addDays(testDay, 1);
    }
    const rows = await q<{ scheduled_for: Date; kind: string; topics: string[] }>(`select scheduled_for, kind, topics from sessions where course = $1 and status = 'pending' order by scheduled_for`, [course]);
    console.log(`\n🗓  ${course}: ${made} sessions planned toward ${tests.map((t) => `${t.name} (${t.date})`).join(", ")}`);
    for (const r of rows) console.log(`  ${isoDate(new Date(r.scheduled_for))} ${String(STUDY_HOUR).padStart(2, "0")}:00  [${r.kind}] ${r.topics.join(" · ")}`);
  }
}
