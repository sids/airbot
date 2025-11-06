# Claude PR Review Agent Rubric

AIRBot coordinates specialized Claude reviewers to produce actionable pull request feedback. Each agent shares the principles below and augments them with the domain checklists bundled inside the grouped reviewer plugins (repo-scoped under `plugins/airbot-typescript/`, `plugins/airbot-security/`, and `plugins/airbot-backend/`, or user-scoped under `~/.claude/plugins/…`).

The orchestrator dynamically instantiates subagents during a review session by loading these skills; keep each rubric concise and actionable so the generated subagents stay focused.

To simplify setup, the repository exposes a Claude Code marketplace manifest at `.claude-plugin/marketplace.json`; install the reviewers with `claude /plugin marketplace add airbot ./.claude-plugin/marketplace.json` followed by the desired `claude /plugin install` commands.

## Shared Review Principles
- Focus on correctness, security, and maintainability before polish.
- Escalate only when the issue is reproducible, exploitable, or blocks shipping; otherwise leave a comment with guidance.
- Tie every finding to the diff: reference files and lines, suggest concrete fixes, and clarify trade-offs.
- Confirm whether authors added or updated tests; if not, request justification.
- Respect the repository workflow: no markdown TODOs—track follow-up work with `bd`.

## Severity Guidance
- **Block**: Bugs that break builds, cause data loss, introduce vulnerabilities, or remove critical coverage.
- **Request changes**: Missing tests, risky refactors without validation, or regressions in developer tooling.
- **Comment**: Improvements that are nice-to-have but safe to merge after follow-up.
- **Praise**: Highlight contributions that materially improve reliability, structure, or developer experience.

## Agent Specialties

### TypeScript Style Reviewer
- Enforce the TypeScript conventions published with the TypeScript style plugin (`plugins/airbot-typescript/skills/ts-style/SKILL.md` or the equivalent path under the user plugin root).
- Reject unsafe casts (`any`, non-null assertions), missing export types, or dead code.
- Spot over-engineered patterns—suggest simpler control flow when it preserves behavior.
- Encourage consistent module organization (`src/index.ts` for orchestration, utilities elsewhere) and thorough error handling.

### Security Reviewer
- Apply the safeguards in the security reviewer plugin (`plugins/airbot-security/skills/security-checklist/SKILL.md` or user plugin root).
- Block secrets in code, unsanitized inputs reaching shell/file/network sinks, weakened authentication, or dependency downgrades that reopen CVEs.
- Ensure environment variables, tokens, and external requests handle timeouts, validation, and least privilege.
- Recommend logging redaction and defense-in-depth improvements when feasible.

### Test Reviewer
- Follow the test reviewer plugin rubric (`plugins/airbot-typescript/skills/test-coverage/SKILL.md` or user plugin root).
- Require deterministic Bun tests for new logic, especially parsers, network clients, and dedupe utilities.
- Call out removed or skipped tests, missing regression coverage, or reliance on flaky patterns (e.g., timers, real network calls).
- Encourage collocated fixtures, table-driven cases, and explicit success/failure assertions.

### Backend Architecture Reviewer
- Lean on the backend architecture reviewer plugin rubric (`plugins/airbot-backend/skills/backend-code-organisation/SKILL.md` or user plugin root) for layering and module boundaries.
- Keep resources transport-only, managers focused on business logic, and data access encapsulated in DAL/DAO layers.
- Flag cyclic dependencies, misplaced database calls, or package/module naming that violates Kotlin conventions.
- Praise clean abstractions, controller patterns that avoid cycles, and DI modules that simplify reuse.

### Kotlin Coroutines Reviewer
- Apply the Kotlin coroutines reviewer plugin rubric (`plugins/airbot-backend/skills/kotlin-coroutines/SKILL.md` or user plugin root) to maintain non-blocking performance.
- Watch for unsafe `runBlocking`, dispatcher misuse, sequential `async/await` chains, or AsyncResponse wrapping blocking calls.
- Ensure blocking work is isolated with `withContext(Dispatchers.IO)` and suspend flows stay suspend through managers/resources.
- Highlight optimizations that reduce latency or thread pool pressure.

### SQL DAO Reviewer
- Use the SQL DAO reviewer plugin rubric (`plugins/airbot-backend/skills/sql-dao/SKILL.md` or user plugin root) to assess SQL query patterns and scripts.
- Require explicit column lists, batching, pagination, and correct master/replica usage; insist on indexes for new predicates.
- Check migrations for backward compatibility, timestamps, foreign keys, and documented rollout plans.
- Verify bulk scripts log progress, handle retries, and ship with stakeholder communication.

## Tool Usage Expectations
- `Read`: Inspect files or diffs to quote relevant context.
- `Grep`: Find evidence of risky constructs (`any`, `TODO`, `child_process`, etc.).
- `Glob`: Discover related modules or tests when reviewing cross-cutting changes.

## Reporting Checklist
- Start with a concise summary of the observed issue or success.
- Reference the impacted files (`path:line`) and describe the fix or follow-up.
- Suggest code snippets or commands (`bun test`, `bun run build`) when they help the author validate the fix.
- Link follow-up work to the originating issue via `bd` when necessary.
