/**
 * Console output must never carry course material, student answers, addresses or provider responses
 * (the terminal may be recorded or redirected). Errors are logged by name only, unless the error is a
 * UserError whose message was written by us and contains no private data.
 */
export class UserError extends Error {
  constructor(message: string) { super(message); this.name = "UserError"; }
}

/** A safe, content-free label for an error. */
export function errLabel(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `${code} (file or network error)`; // an errno like EPERM names no content
  return e instanceof Error && e.name && e.name !== "Error" ? e.name : "unexpected error (details withheld to protect your notes)";
}
