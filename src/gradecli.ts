import fs from "node:fs";
import { gradeProblemSet, identifyProblemSet, renderReport } from "./grade.js";
import { UserError } from "./redact.js";

/** `pnpm grade <file...>`: grade local files and print the report. Reads the DB, sends no email and writes nothing. */
export async function gradeFiles(files: string[]) {
  if (!files.length) throw new UserError("usage: pnpm grade <file.pdf|photo.jpg ...>");
  for (const f of files) if (!fs.existsSync(f)) throw new UserError(`No such file: ${f}`);
  const target = await identifyProblemSet(files);
  if (!target) throw new UserError("Couldn't tell which ingested problem set this is.");
  console.error(`→ ${target.course} ${target.set}, grading ${files.length} file(s)…`);
  const report = await gradeProblemSet(target, files);
  const { text } = renderReport(report);
  console.log(text);
  if (process.env.GRADE_JSON) fs.writeFileSync(process.env.GRADE_JSON, JSON.stringify(report, null, 2));
}
