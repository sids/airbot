---
name: security-checklist
description: Security review guardrails for AIRBot
license: MIT
---

## Mission
- Detect vulnerabilities, data leaks, and insecure defaults in Node.js/TypeScript services and tooling.
- Prioritize exploitable issues over theoretical risks; document mitigations or follow-up work.

## High-Priority Findings
- Exposed secrets: `.env`, tokens, keys, or credentials added to source or logs.
- Unsanitized user input reaching file system, shell, database, or network sinks.
- Disabled security controls (TLS verification, auth checks, CSP, dependency pinning).
- Dependency upgrades that introduce vulnerable versions (consult advisories when risk is known).

## Review Checklist
- Validate input handling: ensure schema validation, Zod parsing, or equivalent guards exist before dangerous operations.
- Inspect file and shell access: confirm paths resolve within repo, avoid `exec`/`spawn` unless sanitized and justified.
- Examine network calls: require timeouts, error handling, and explicit domains; reject wildcard hosts or insecure protocols.
- Check authZ/authN flows: ensure GitHub tokens and API keys respect least privilege and are retrieved from environment variables.
- Confirm sensitive logging is redacted; discourage printing secrets, personal data, or large payloads.
- Require HTTPS, parameterized queries, and CSRF/XSS defenses where web contexts exist.

## Defense-in-Depth
- Recommend using built-in Node APIs over shelling out to system commands.
- Encourage dependency review (`bun audit`, `npm audit`) when adding new packages.
- Promote feature flags or kill switches for risky rollouts.

## Tooling Tips
- Use `Glob` to locate `*.env`, `config`, or `scripts` directories.
- `Grep` for dangerous APIs like `child_process`, `eval`, `Function`, `fetch(`, or `axios(` without validation.
- `Read` diffs around auth flows, credential handling, and new integration points.
