# AIRBot (AI Review Bot)

AIRBot (short for **AI Review Bot**) aims to build an automated pull-request reviewer that understands repositories written in any language. It will combine the Claude Agent SDK with GitHub’s APIs to surface the most important review findings, while staying fast, deterministic, and safe to run in CI.

## What We Are Building
- **Multi-language awareness:** The agent inspects file types, project metadata, and dependency manifests to adapt its review strategy beyond TypeScript—covering everything from Go backends to Python scripts and frontend assets.
- **Context-rich analysis:** It ingests repo anchors (README, configs, lint rules), full PR diffs, commit history, and existing review comments to avoid duplicates and focus on high-signal issues.
- **Specialized subagents & skills:** Dedicated reviewers (style, security, testing, etc.) collaborate via the Claude Agent SDK, each scoped to read-only tools and guided by project-specific skill documents.
- **Actionable output:** Findings map cleanly to GitHub review comments, line annotations, or summary notes; if a note already exists, the agent reacts with a 👍 instead of duplicating it.
- **CI ready:** Everything runs headlessly in GitHub Actions using Bun for builds/tests, with secrets constrained to the minimum scopes required for fetching data and posting reviews.

## High-Level Approach
1. **Initialize context:** Fetch repository metadata, changed files, and language signals to decide which heuristics and skills to invoke.
2. **Hydrate knowledge:** Pull anchor files and relevant modules via read-only tools so each subagent sees the standards that matter.
3. **Analyze diffs:** Parse unified diffs, track code hunks, and hand off targeted sections to specialized subagents for deeper inspection.
4. **Aggregate findings:** De-duplicate overlapping comments, stitch together summary insights, and format suggestions that fit GitHub’s Review API.
5. **Post or dry-run:** Depending on environment, either output a human-readable report or submit comments directly to the PR.

## Current Status
- Bun-powered TypeScript scaffold with placeholder modules (`src/`), tests (`tests/`), optional reviewer plugins (`plugins/airbot-typescript`, `plugins/airbot-security`, `plugins/airbot-backend`), and a GitHub Actions workflow.
- Reviewer roster includes TypeScript style, security, and test coverage agents, plus Kotlin-oriented backend reviewers (architecture, coroutines, SQL DAO) sourced from the bundled plugins.
- No runtime implementation yet—core logic, prompts, and tooling will be filled in next iterations.

## Getting Started
```bash
bun install
bun run build
bun test
```

Use `bun run review` once the review workflow is implemented to compile and execute the agent locally against a pull request.

## Running the Review CLI

The review entrypoint expects a pull-request context that mirrors the GitHub Actions environment. At minimum, provide the repository slug and pull request number; supplying `GITHUB_TOKEN` allows the orchestrator to fetch PR metadata and diff files. The run stays in dry-run mode by default—set `AIRBOT_POST_REVIEW=1` to submit comments back to GitHub.

```bash
export GITHUB_REPOSITORY=owner/repo
export PR_NUMBER=123
export GITHUB_TOKEN=ghp_example            # optional for metadata fetches
export ANTHROPIC_API_KEY=sk-ant-example    # required to execute agents
export AIRBOT_POST_REVIEW=1                # optional: actually post a review

bun run review
```

### Reviewer Roster & Triggering

AIRBot currently ships six Claude reviewers:
- **TypeScript Style Reviewer** – TypeScript conventions, null safety, module organization (`plugins/airbot-typescript/skills/ts-style/` or `~/.claude/plugins/airbot-typescript/skills/ts-style/`).
- **Security Reviewer** – Node/TS security guardrails (`plugins/airbot-security/skills/security-checklist/` or home equivalent).
- **Test Reviewer** – Coverage expectations for Bun-based projects (`plugins/airbot-typescript/skills/test-coverage/` or home equivalent).
- **Backend Architecture Reviewer** – Kotlin service layering guidance (`plugins/airbot-backend/skills/backend-code-organisation/` or home equivalent).
- **Kotlin Coroutines Reviewer** – Coroutine/threading discipline (`plugins/airbot-backend/skills/kotlin-coroutines/` or home equivalent).
- **SQL DAO Reviewer** – SQL/DAL performance and schema rules (`plugins/airbot-backend/skills/sql-dao/` or home equivalent).

All six reviewers run by default in the current prototype; future iterations may toggle them based on the languages or directories touched in a pull request. Additional reviewers can be introduced by extending one of the grouped plugins or adding new Claude Code plugins under `plugins/<id>/` (or in `~/.claude/plugins/<id>/`) with their own `.claude-plugin/plugin.json` manifest.

At runtime AIRBot inspects these skill definitions (CLAUDE.md plus each plugin's `skills/*/SKILL.md`) and spawns temporary subagents that apply the appropriate rubric—no static agent manifests are required.

### Installing The Plugins Via Claude Code

The repository bundles a marketplace manifest at `.claude-plugin/marketplace.json` that advertises all six reviewer plugins. To install them with Claude Code:

```bash
# From the repository root
claude /plugin marketplace add airbot ./.claude-plugin/marketplace.json
claude /plugin install airbot airbot-typescript
claude /plugin install airbot airbot-security
claude /plugin install airbot airbot-backend
```

Installing publishes the plugins into `~/.claude/plugins/`, where the runtime automatically discovers them.
