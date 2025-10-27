# Repository Guidelines

## Project Structure & Module Organization
- `src/` — TypeScript source for AIRBot. Core orchestration lives in `src/index.ts`; domain helpers reside in `src/agents.ts`, `src/tools.ts`, `src/dedupe.ts`, and `src/parsing/`.
- `tests/` — Bun test suites; mirror source structure (e.g., `tests/parsing/*.test.ts`) and keep fixtures alongside the specs.
- `.claude/skills/` — Each skill lives in its own directory (e.g., `.claude/skills/security-checklist/`) with a `SKILL.md` frontmatter file (must declare `name`, `description`, `license`) plus any supporting docs or scripts.
- `.github/workflows/airbot.yml` — CI entry point; ensure new automation steps stay Bun-first.
- `CLAUDE.md` & `README.md` — Contributor-facing rubric and overview; update when behavior or scope shifts.

## Build, Test, and Development Commands
- `bun install` — Resolve dependencies declared in `package.json`. Run after any dependency change.
- `bun run build` — Type-check and emit compiled output to `dist/` using `tsconfig.json`.
- `bun test` — Execute Bun’s test runner; add `--coverage` once coverage rules are defined.
- `bun run review` — Compile then execute the CLI entrypoint (currently a placeholder) against the active repo state.

## Coding Style & Naming Conventions
- TypeScript with strict mode; prefer explicit `type` aliases for shared shapes (see `src/types.ts`).
- Use PascalCase for types/interfaces, camelCase for variables/functions, and kebab-case for files.
- Keep modules focused: orchestration in `src/index.ts`, pure utilities in dedicated files, and shared contracts in `src/types.ts`.
- Document non-obvious logic with concise comments; avoid restating the code.

## Testing Guidelines
- Use `bun:test`; name files `*.test.ts` and collocate close to the functionality under test.
- Favor deterministic, side-effect-free tests. Mock GitHub/Claude interactions with typed stubs until official SDK helpers are available.
- Ensure new parsing or dedupe utilities ship with representative fixture coverage.

## Commit & Pull Request Guidelines
- Write commits in imperative mood (e.g., “Add diff parser scaffolding”). Group unrelated changes into separate commits.
- Pull requests should include: purpose summary, implementation notes, testing evidence (`bun test`, `bun run build`), and any follow-up TODOs.
- Reference issues with `Fixes #123` when closing bugs. Add screenshots or terminal snippets if the change affects output formatting.

## Security & Configuration Tips
- Never commit secrets. Use `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` only via CI secrets or local `.env` files ignored by Git.
- Keep tool definitions read-only; avoid exposing shell execution inside agents to maintain CI safety.
