import { describe, expect, it } from "bun:test";

import { dedupeFindings } from "../src/dedupe";
import type { Findings } from "../src/types";

describe("dedupeFindings", () => {
  it("removes duplicate findings while keeping the first occurrence", () => {
    const findings: Findings = [
      { path: "src/app.ts", kind: "line", body: "Issue", line: 12 },
      { path: "src/app.ts", kind: "line", body: "Issue", line: 12 },
      { path: "README.md", kind: "summary", body: "Summary" },
      { path: "src/app.ts", kind: "line", body: "Issue", line: 12 },
    ];

    const deduped = dedupeFindings(findings);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toBe(findings[0]);
    expect(deduped[1]).toBe(findings[2]);
  });

  it("keeps findings when metadata differs", () => {
    const findings: Findings = [
      { path: "src/app.ts", kind: "line", body: "Issue", line: 12 },
      { path: "src/app.ts", kind: "line", body: "Issue", line: 13 },
      {
        path: "src/app.ts",
        kind: "range",
        body: "Range issue",
        start_line: 20,
        suggestion: "Change this",
      },
      {
        path: "src/app.ts",
        kind: "range",
        body: "Range issue",
        start_line: 20,
        suggestion: "Different suggestion",
      },
      {
        path: "src/app.ts",
        kind: "range",
        body: "Range issue",
        start_line: 20,
        side: "LEFT",
      },
    ];

    const deduped = dedupeFindings(findings);

    expect(deduped).toHaveLength(findings.length);
  });

  it("treats missing optional properties as equivalent", () => {
    const findings: Findings = [
      { path: "src/app.ts", kind: "summary", body: "Summary" },
      {
        path: "src/app.ts",
        kind: "summary",
        body: "Summary",
        suggestion: undefined,
        line: undefined,
        start_line: undefined,
      },
      { path: "src/app.ts", kind: "summary", body: "Summary", side: undefined },
      {
        path: "src/app.ts",
        kind: "summary",
        body: "Summary",
        // Explicit RIGHT should collapse with the implicit default.
        side: "RIGHT",
      },
    ];

    const deduped = dedupeFindings(findings);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toBe(findings[0]);
  });
});
