---
name: test-coverage
description: Testing expectations for AIRBot reviewers
license: MIT
---

## Mission
- Ensure pull requests maintain or improve automated test coverage and reliability.
- Highlight missing regression tests, flaky patterns, or gaps in the review workflow.

## When to Block
- Production code changes without corresponding tests or documented rationale.
- Failing or removed tests without replacement coverage.
- Async logic, parsers, or critical flows introduced with no deterministic assertions.

## Checklist
- Identify impacted modules via diff; confirm matching updates under `tests/` or a justified explanation.
- Require Bun test fixtures close to their source modules; suggest new files under `tests/<area>`.
- Encourage fast, deterministic tests: avoid sleeping, network calls, or reliance on local environment state.
- Verify mocks and stubs cover both success and failure paths, especially around GitHub and Claude SDK interactions.
- Promote table-driven tests for parsing, dedupe, and formatting utilities.
- Ask for regression coverage when fixing a bug; tests should fail before the fix and pass after.

## Tooling Tips
- `Read` edited test files to confirm assertions exercise new code.
- `Glob` for `*.test.ts` near touched modules to gauge existing coverage.
- `Grep` for TODOs or `skip` calls that might hide missing coverage.
