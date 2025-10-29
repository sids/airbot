import { describe, expect, test } from "bun:test";

import { formatReviewPayload, runAgents } from "../src/index";
import type { AgentRuntime } from "../src/index";
import type { AgentMap } from "../src/agents";
import type { Finding } from "../src/types";
import type { ToolRegistry } from "../src/tools";

describe("formatReviewPayload", () => {
  test("groups summary findings and prepares inline comments", () => {
    const findings: Finding[] = [
      {
        kind: "summary",
        path: "",
        body: "Overall summary issue",
      },
      {
        kind: "file",
        path: "src/example.ts",
        body: "File-level context",
      },
      {
        kind: "line",
        path: "src/example.ts",
        line: 42,
        side: "RIGHT",
        body: "Highlight a specific problem",
      },
      {
        kind: "range",
        path: "src/other.ts",
        start_line: 5,
        line: 8,
        side: "LEFT",
        body: "Range comment for a block",
      },
      {
        kind: "line",
        path: "src/example.ts",
        line: 99,
        body: "Inline suggestion",
        suggestion: "const answer = 42;",
      },
      {
        kind: "line",
        path: "",
        body: "Missing metadata should fall back to summary",
      },
    ];

    const review = formatReviewPayload(findings);

    expect(review.event).toBe("COMMENT");
    expect(review.comments).toHaveLength(3);
    expect(review.comments.map((comment) => comment.path)).toEqual([
      "src/example.ts",
      "src/other.ts",
      "src/example.ts",
    ]);

    const suggestionComment = review.comments.find(
      (comment) => comment.line === 99,
    );
    expect(suggestionComment?.body).toContain("```suggestion");

    expect(review.body).toBeDefined();
    expect(review.body).toContain("Overall summary issue");
    expect(review.body).toContain("**src/example.ts**");
    expect(review.body).toContain("Missing metadata should fall back to summary");
  });
});

describe("runAgents", () => {
  test("invokes the runtime for each agent and aggregates findings", async () => {
    const emptyTools = [] as (keyof ToolRegistry)[];
    const agentDefinitions: AgentMap = {
      "style-reviewer": {
        description: "style",
        prompt: "prompt",
        tools: emptyTools,
        model: "fake",
      },
      "security-reviewer": {
        description: "security",
        prompt: "prompt",
        tools: emptyTools,
        model: "fake",
      },
      "test-reviewer": {
        description: "test",
        prompt: "prompt",
        tools: emptyTools,
        model: "fake",
      },
    };

    const runtimeCalls: string[] = [];
    const runtime: AgentRuntime = {
      async run(agentId) {
        runtimeCalls.push(agentId);
        return {
          agentId,
          findings: [
            {
              kind: "summary",
              path: "",
              body: `issue (${agentId})`,
            },
          ],
          durationMs: 5,
        };
      },
    };

    const context = {
      environment: {
        workspace: "/workspace",
        owner: "owner",
        repo: "repo",
        repoSlug: "owner/repo",
        postReview: false,
        isCi: false,
      },
      toolRegistry: {} as ToolRegistry,
    };

    const { results, findings } = await runAgents(runtime, agentDefinitions, context);

    expect(runtimeCalls).toEqual([
      "style-reviewer",
      "security-reviewer",
      "test-reviewer",
    ]);
    expect(results).toHaveLength(3);
    expect(findings).toHaveLength(3);
    expect(findings[0]?.body).toContain("style-reviewer");
  });
});
