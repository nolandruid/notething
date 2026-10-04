import fs from "node:fs";
import { gradeProblemSet, identifyProblemSet, renderReport } from "./grade.js";

/** `pnpm grade <file...>`: grade local files and print the report. Reads the DB, sends no email and writes nothing. */
export async function gradeFiles(files: string[]) {
  if (!files.length) throw new Error("usage: pnpm grade <file.pdf|photo.jpg ...>");
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`No such file: ${f}`);
  const target = await identifyProblemSet(files);
  if (!target) throw new Error("Couldn't tell which ingested problem set this is.");
  console.error(`→ ${target.course} ${target.set}, grading ${files.length} file(s)…`);
  const report = await gradeProblemSet(target, files);
  const { text } = renderReport(report);
  console.log(text);
  if (process.env.GRADE_JSON) fs.writeFileSync(process.env.GRADE_JSON, JSON.stringify(report, null, 2));
}
