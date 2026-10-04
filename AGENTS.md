# Guidelines for contributors and coding agents

NoteThing reads a student's private course materials, so the rules below matter more than style. CodeRabbit reads this file as review criteria.

## Privacy

- Course content, generated notes, transcripts, and student data (names, emails, grades, answers) are never committed and never logged. `content/`, `vault/` and `.env` stay gitignored.
- Do not put professor names, course codes, or absolute local paths in code, comments, tests, or docs. Use obvious placeholders (`Jane Doe`, `COURSE101`, `jane@example.com`).
- Secrets come from `.env` only. `.env.example` holds empty or dummy values.
- Log counts and ids, not file contents or model prompts.

## Model output

- Treat every model response as untrusted input. Parse it, then validate it with a zod schema before use. No `as` casts or `any` on model output.
- Handle truncated and filtered responses (`finish_reason` of `length` or `content_filter`) and malformed JSON: retry once at most, then fail with a clear error. Never write a half-parsed result to the database.

## Code

- TypeScript, ESM, Node 22+, run with `tsx`. `pnpm typecheck` must pass.
- SQL is parameterized. Never build queries with string concatenation or template interpolation of user or model data.
- Keep functions small and single-purpose. Prefer pure functions for planning, parsing and grading logic so they are easy to test.
- Never pass file paths or URLs from untrusted input to a shell. Use argument arrays, not shell strings.
- Clean up temp files, including on failure.

## Commits and PRs

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Every change goes through a PR. Keep PRs focused.
- Write the PR description for a human: what changed and why in a few sentences, then how you tested it. No filler.
