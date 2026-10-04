import fs from "node:fs";
import path from "node:path";
import { opt, ROOT } from "./env.js";

/** Demo mode: Neon database branches (copy-on-write, instant). `demo-baseline` is a frozen good state; `demo-run` is a throwaway copy of it. */

const API = "https://console.neon.tech/api/v2";
const BASELINE = "demo-baseline";
const RUN = "demo-run";
const ENV_FILE = path.join(ROOT, ".env");

type Branch = { id: string; name: string; default?: boolean };
type Operation = { id: string; status: string };

function config() {
  const key = opt("NEON_API_KEY");
  const project = opt("NEON_PROJECT_ID");
  if (!key || !project) {
    throw new Error(
      "Demo branches are disabled: set NEON_API_KEY and NEON_PROJECT_ID in .env.\n" +
      "  API key: Neon Console → Account settings → API keys. Project ID: Neon Console → your project → Settings.");
  }
  return { key, project };
}

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const { key } = config();
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).message ?? msg; } catch { /* not JSON */ }
    const hint = res.status === 401 || res.status === 403 ? " (check NEON_API_KEY)" : res.status === 404 ? " (check NEON_PROJECT_ID: Neon Console → Settings)" : "";
    throw new Error(`Neon API ${method} ${route.split("?")[0]} failed: ${res.status} ${msg}${hint}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Branch create/delete are asynchronous; wait until Neon says the operations are done. */
async function waitFor(ops: Operation[] = []) {
  const { project } = config();
  for (const op of ops) {
    for (let i = 0; i < 60; i++) {
      const { operation } = await api<{ operation: Operation }>("GET", `/projects/${project}/operations/${op.id}`);
      if (operation.status === "finished" || operation.status === "skipped") break;
      if (["failed", "error", "cancelled"].includes(operation.status)) throw new Error(`Neon operation ${op.id} ${operation.status}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function findBranch(name: string): Promise<Branch | undefined> {
  const { project } = config();
  const { branches } = await api<{ branches: Branch[] }>("GET", `/projects/${project}/branches?search=${encodeURIComponent(name)}`);
  return branches.find((b) => b.name === name);
}

async function deleteBranch(name: string) {
  const b = await findBranch(name);
  if (!b) return;
  const { project } = config();
  if (b.default) throw new Error(`Refusing to delete "${name}": it is the project's primary branch.`);
  const r = await api<{ operations?: Operation[] }>("DELETE", `/projects/${project}/branches/${b.id}`);
  await waitFor(r.operations);
}

/** Database and role come from the main DATABASE_URL (never the demo one). */
function dbAndRole(): { database: string; role: string } {
  const raw = opt("DATABASE_URL");
  if (!raw) throw new Error("DATABASE_URL is not set in .env; it is needed to find the database and role names.");
  try {
    const u = new URL(raw);
    return { database: decodeURIComponent(u.pathname.slice(1)), role: decodeURIComponent(u.username) };
  } catch {
    throw new Error("DATABASE_URL is not a valid connection string.");
  }
}

/** pnpm demo:snapshot: freeze the primary branch's current state as `demo-baseline`. */
export async function demoSnapshot() {
  const { project } = config();
  // demo-run is a child of demo-baseline, and Neon won't delete a branch that has children.
  await deleteBranch(RUN);
  await deleteBranch(BASELINE);
  const r = await api<{ operations?: Operation[] }>("POST", `/projects/${project}/branches`, { branch: { name: BASELINE } });
  await waitFor(r.operations);
  console.log(`✓ Snapshot saved as branch "${BASELINE}" (copy of the primary branch). Next: pnpm demo:reset`);
}

/** pnpm demo:reset: fresh `demo-run` from `demo-baseline`; point .env at it. */
export async function demoReset() {
  const { project } = config();
  const { database, role } = dbAndRole();
  const baseline = await findBranch(BASELINE);
  if (!baseline) throw new Error(`No "${BASELINE}" branch yet. Run pnpm demo:snapshot first.`);
  await deleteBranch(RUN);
  const created = await api<{ branch: Branch; operations?: Operation[] }>("POST", `/projects/${project}/branches`, {
    branch: { name: RUN, parent_id: baseline.id },
    endpoints: [{ type: "read_write" }],
  });
  await waitFor(created.operations);
  const qs = new URLSearchParams({ branch_id: created.branch.id, database_name: database, role_name: role, pooled: "true" });
  let uri: string | undefined;
  for (let i = 0; i < 10 && !uri; i++) {
    try { uri = (await api<{ uri: string }>("GET", `/projects/${project}/connection_uri?${qs}`)).uri; }
    catch (e) { if (i === 9) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  setEnvVar("DEMO_DATABASE_URL", uri);
  console.log(`✓ Fresh branch "${RUN}" ready; DEMO_DATABASE_URL written to .env. Run pnpm demo:off to go back to main.`);
}

/** pnpm demo:off: forget the demo connection string (back to the main branch). */
export function demoOff() {
  setEnvVar("DEMO_DATABASE_URL", undefined);
  console.log("✓ Demo mode off; using DATABASE_URL (main).");
}

/** Replace, add or remove KEY in .env, leaving every other line untouched. The value is quoted and never printed. */
function setEnvVar(key: string, value: string | undefined) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const isKey = (l: string) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l);
  const rest = lines.filter((l) => !isKey(l));
  while (rest.length && rest[rest.length - 1] === "") rest.pop();
  if (value !== undefined) rest.push(`${key}="${value}"`);
  fs.writeFileSync(ENV_FILE, rest.join("\n") + "\n");
}
