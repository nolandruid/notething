import "dotenv/config";
import path from "node:path";

/** Read a required env var, exiting with a friendly message if it's missing. */
export function need(name: string, hint = ""): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`\n✗ Missing ${name}. Add it to .env (see .env.example).${hint ? `\n  ${hint}` : ""}\n`);
    process.exit(1);
  }
  return v;
}

export const opt = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

export const ROOT = process.cwd();
export const CONTENT_DIR = path.join(ROOT, "content");
export const VAULT_DIR = path.resolve(opt("VAULT_DIR", path.join(ROOT, "vault")));
export const MODEL = opt("NOTETHING_MODEL", "openai/gpt-6-luna");
export const CHEAP_MODEL = opt("NOTETHING_CHEAP_MODEL", "openai/gpt-5-nano");
export const STUDY_HOUR = (() => {
  const h = Number(opt("STUDY_HOUR", "18"));
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    console.error("\n✗ STUDY_HOUR must be a whole number from 0 to 23.\n");
    process.exit(1);
  }
  return h;
})();

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80) || "note";

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Parse "YYYY-MM-DD" as a local calendar day (new Date("YYYY-MM-DD") would be UTC midnight). */
export const parseDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
