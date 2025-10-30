# Repository Guidelines

## Project Structure & Module Organization
- `src/` — TypeScript source for AIRBot. Core orchestration lives in `src/index.ts`; domain helpers reside in `src/agents.ts`, `src/tools.ts`, `src/dedupe.ts`, and `src/parsing/`.
- `tests/` — Bun test suites; mirror source structure (e.g., `tests/parsing/*.test.ts`) and keep fixtures alongside the specs.
- `.claude/skills/` — Each skill lives in its own directory (e.g., `.claude/skills/security-checklist/`) with a `SKILL.md` frontmatter file (must declare `name`, `description`, `license`) plus any supporting docs or scripts.
- `.github/workflows/airbot.yml` — CI entry point; ensure new automation steps stay Bun-first.
- `CLAUDE.md` & `README.md` — Contributor-facing rubric and overview; update when behavior or scope shifts.

## Claude Reviewers & Skills
- **TypeScript Style Reviewer** — TypeScript conventions, null safety, and module hygiene (`.claude/skills/ts-style/`).
- **Security Reviewer** — Node/TS security checklist (`.claude/skills/security-checklist/`).
- **Test Reviewer** — Bun testing expectations (`.claude/skills/test-coverage/`).
- **Backend Architecture Reviewer** — Kotlin service layering, packaging, and DI rules (`.claude/skills/backend-code-organisation/`).
- **Kotlin Coroutines Reviewer** — Coroutine/threading guardrails for Kotlin backends (`.claude/skills/kotlin-coroutines/`).
- **SQL DAO Reviewer** — SQL/DAL performance and schema practices (`.claude/skills/sql-dao/`).

The current prototype invokes all six reviewers on every run. Add or disable agents by editing `src/agents.ts`; each reviewer should cite a skill directory and corresponding rubric entries in `CLAUDE.md`.

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

## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Auto-syncs to JSONL for version control
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**
```bash
bd ready --json
```

**Create new issues:**
```bash
bd create "Issue title" -t bug|feature|task -p 0-4 --json
bd create "Issue title" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**
```bash
bd update bd-42 --status in_progress --json
bd update bd-42 --priority 1 --json
```

**Complete work:**
```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task**: `bd update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:
- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### MCP Server (Recommended)

If using Claude or MCP-compatible clients, install the beads MCP server:

```bash
pip install beads-mcp
```

Add to MCP config (e.g., `~/.config/claude/config.json`):
```json
{
  "beads": {
    "command": "beads-mcp",
    "args": []
  }
}
```

Then use `mcp__beads__*` functions instead of CLI commands.

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and QUICKSTART.md.

## Security & Configuration Tips
- Never commit secrets. Use `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` only via CI secrets or local `.env` files ignored by Git.
- Keep tool definitions read-only; avoid exposing shell execution inside agents to maintain CI safety.
