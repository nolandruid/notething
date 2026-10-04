# Contributing

Thanks for helping! NoteThing is small on purpose: a handful of TypeScript CLI scripts.

1. `pnpm install`, `cp .env.example .env`, fill in keys, `pnpm migrate`.
2. Branch from `main` (`feat/...`, `fix/...`), keep PRs focused, use [conventional commits](https://www.conventionalcommits.org/).
3. `pnpm typecheck` must pass. CodeRabbit reviews every PR; address or reply to its comments.
4. **Never commit course materials, generated notes, transcripts or `.env`.** `content/` and `vault/` are gitignored; keep it that way. Use your own course files locally for testing.

Layout: `src/ingest.ts` (files to notes), `src/transcribe.ts` + `scripts/transcribe.py` (video to transcript), `src/plan.ts` (schedule), `src/mail.ts` (coach emails + grading), `src/db.ts` (Neon schema), `src/llm.ts` (OpenRouter model helper).
