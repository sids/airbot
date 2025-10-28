import type { Finding, Findings } from "./types";

/**
 * Builds a stable deduplication key for a finding.
 *
 * We rely on an ordered tuple so that adding new surfaced properties only
 * requires extending this helper. Optional properties are normalized to `null`
 * so that "missing" and `undefined` values hash identically, preventing noisy
 * duplicates from sneaking through.
 */
function buildFindingKey(finding: Finding): string {
  const normalizedSide = finding.side === "LEFT" ? "LEFT" : "RIGHT";

  return JSON.stringify([
    finding.path,
    finding.kind,
    finding.body,
    finding.suggestion ?? null,
    finding.line ?? null,
    finding.start_line ?? null,
    // GitHub treats omitted side metadata as the default RIGHT side; normalize so
    // reviewers that explicitly set RIGHT still dedupe with the implicit default.
    normalizedSide,
  ]);
}

/**
 * Removes duplicate findings while preserving the original ordering.
 *
 * Duplicates are defined as findings that match on every surfaced property we
 * emit to GitHub (path, kind, body, suggestion, line metadata, review side).
 * When duplicates are encountered we keep the first instance so that any
 * subsequent logic depending on stable ordering is unaffected.
 */
export function dedupeFindings(findings: Findings): Findings {
  const seen = new Set<string>();
  const unique: Findings = [];

  for (const finding of findings) {
    const key = buildFindingKey(finding);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(finding);
  }

  return unique;
}
