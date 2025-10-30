import { describe, expect, test } from "bun:test";

import type { Octokit } from "octokit";

import {
  createClaudeAgentRuntime,
  createGitHubClient,
  formatReviewPayload,
  runAgents,
} from "../src/index";
import type { AgentRuntime, ReviewSubmission } from "../src/index";
import type { AgentDefinition, AgentMap } from "../src/agents";
import type { Finding } from "../src/types";
import { createToolRegistry } from "../src/tools";
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
      "typescript-style-reviewer": {
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
      "backend-architecture-reviewer": {
        description: "backend",
        prompt: "prompt",
        tools: emptyTools,
        model: "fake",
      },
      "kotlin-coroutines-reviewer": {
        description: "coroutines",
        prompt: "prompt",
        tools: emptyTools,
        model: "fake",
      },
      "sql-dao-reviewer": {
        description: "sql",
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
      "typescript-style-reviewer",
      "security-reviewer",
      "test-reviewer",
      "backend-architecture-reviewer",
      "kotlin-coroutines-reviewer",
      "sql-dao-reviewer",
    ]);
    expect(results).toHaveLength(6);
    expect(findings).toHaveLength(6);
    expect(findings[0]?.body).toContain("typescript-style-reviewer");
  });
});

class FakeOctokit {
  pullResponse: Record<string, unknown>;
  diffResponse: unknown;
  fileResponses: Array<Record<string, unknown>>;
  getCalls: Array<Record<string, unknown>>;
  requestCalls: Array<{ route: string; params: Record<string, unknown> }>;
  paginateCalls: Array<{ fn: unknown; params: unknown }>;
  createReviewCalls: Array<Record<string, unknown>>;
  listFilesCalls: Array<Record<string, unknown>>;
  rest: {
    pulls: {
      get: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
      listFiles: (params: Record<string, unknown>) => Promise<void>;
      createReview: (params: Record<string, unknown>) => Promise<void>;
    };
  };

  constructor() {
    this.pullResponse = {};
    this.diffResponse = "";
    this.fileResponses = [];
    this.getCalls = [];
    this.requestCalls = [];
    this.paginateCalls = [];
    this.createReviewCalls = [];
    this.listFilesCalls = [];
    this.rest = {
      pulls: {
        get: async (params) => {
          this.getCalls.push(params);
          return { data: this.pullResponse };
        },
        listFiles: async (params) => {
          this.listFilesCalls.push(params);
        },
        createReview: async (params) => {
          this.createReviewCalls.push(params);
        },
      },
    };
  }

  paginate = async (fn: unknown, params: unknown) => {
    this.paginateCalls.push({ fn, params });
    return this.fileResponses;
  };

  request = async (route: string, params: Record<string, unknown>) => {
    this.requestCalls.push({ route, params });
    return { data: this.diffResponse };
  };
}

describe("createGitHubClient", () => {
  test("wraps Octokit pull request endpoints with expected parameters", async () => {
    const identifier = { owner: "acme", repo: "airbot", pullNumber: 7 };
    const fakeOctokit = new FakeOctokit();
    fakeOctokit.pullResponse = { number: 7, state: "open" };
    fakeOctokit.diffResponse = "diff content";
    fakeOctokit.fileResponses = [
      { filename: "src/index.ts", additions: 5 },
      { filename: "README.md", changes: 1 },
    ];

    const client = createGitHubClient(fakeOctokit as unknown as Octokit);

    const pull = await client.getPullRequest(identifier);
    const diff = await client.getPullRequestDiff(identifier);
    const files = await client.listPullRequestFiles(identifier);

    const review: ReviewSubmission = {
      event: "COMMENT",
      body: "Summary body",
      comments: [
        {
          path: "src/index.ts",
          body: "Line comment",
          line: 12,
          side: "RIGHT",
        },
      ],
    };

    await client.createReview(identifier, review);

    expect(pull).toEqual(fakeOctokit.pullResponse);
    expect(diff).toBe("diff content");
    expect(files).toEqual(fakeOctokit.fileResponses);

    expect(fakeOctokit.getCalls).toEqual([
      {
        owner: identifier.owner,
        repo: identifier.repo,
        pull_number: identifier.pullNumber,
      },
    ]);

    expect(fakeOctokit.requestCalls).toEqual([
      {
        route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        params: {
          owner: identifier.owner,
          repo: identifier.repo,
          pull_number: identifier.pullNumber,
          headers: { accept: "application/vnd.github.v3.diff" },
        },
      },
    ]);

    expect(fakeOctokit.paginateCalls).toEqual([
      {
        fn: fakeOctokit.rest.pulls.listFiles,
        params: {
          owner: identifier.owner,
          repo: identifier.repo,
          pull_number: identifier.pullNumber,
          per_page: 100,
        },
      },
    ]);

    expect(fakeOctokit.listFilesCalls).toHaveLength(0);

    expect(fakeOctokit.createReviewCalls).toEqual([
      {
        owner: identifier.owner,
        repo: identifier.repo,
        pull_number: identifier.pullNumber,
        event: review.event,
        body: review.body,
        comments: review.comments,
      },
    ]);
  });

  test("normalizes non-string diff payloads to an empty string", async () => {
    const identifier = { owner: "acme", repo: "airbot", pullNumber: 8 };
    const fakeOctokit = new FakeOctokit();
    fakeOctokit.diffResponse = { data: "binary" };

    const client = createGitHubClient(fakeOctokit as unknown as Octokit);

    const diff = await client.getPullRequestDiff(identifier);

    expect(diff).toBe("");
  });
});

describe("createClaudeAgentRuntime", () => {
  const baseDefinition: AgentDefinition = {
    description: "TypeScript style reviewer",
    prompt: "Focus on TypeScript issues and code quality gaps.",
    tools: ["Read", "Grep"],
    model: "sonnet",
  };

  function createRuntimeContext(): Parameters<AgentRuntime["run"]>[2] {
    return {
      environment: {
        workspace: "/repo",
        owner: "acme",
        repo: "airbot",
        repoSlug: "acme/airbot",
        prNumber: 42,
        githubToken: undefined,
        anthropicApiKey: "test-key",
        postReview: false,
        isCi: false,
      },
      toolRegistry: createToolRegistry({ repoRoot: process.cwd() }),
      pullRequest: {
        data: { title: "Improve runtime" },
        diff: "",
        parsedDiff: {} as unknown,
        files: [
          {
            filename: "src/index.ts",
            additions: 10,
            deletions: 2,
            status: "modified",
          },
        ],
      },
    } as Parameters<AgentRuntime["run"]>[2];
  }

  const createStubServer = () =>
    ({
      type: "sdk",
      name: "stub",
      instance: {
        async connect() {
          // no-op
        },
        async close() {
          // no-op
        },
      },
    }) as unknown;

  function createStubQuery(
    messages: unknown[],
    hooks: { onReturn?: () => void; onInterrupt?: () => void } = {},
  ): any {
    let index = 0;
    return {
      async next() {
        if (index < messages.length) {
          return { value: messages[index++], done: false } as const;
        }
        return { value: undefined, done: true } as const;
      },
      async return(value?: unknown) {
        hooks.onReturn?.();
        return { value, done: true } as const;
      },
      async throw(error: unknown) {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => {
        // Allow tests to assert whether we attempted the interrupt fallback.
        hooks.onInterrupt?.();
      },
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      supportedCommands: async () => [],
      supportedModels: async () => [],
      mcpServerStatus: async () => [],
      accountInfo: async () => ({}),
    };
  }

  test("collects findings from agent result payload", async () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Analyzing pull request" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result:
          '{"findings":[{"kind":"summary","path":"","body":"Consider tightening lint rules."}]}',
      },
    ];

    let clock = 0;
    let returnCount = 0;
    let interruptCount = 0;
    const runtime = createClaudeAgentRuntime({
      runQuery: () =>
        createStubQuery(messages, {
          onReturn: () => {
            returnCount += 1;
          },
          onInterrupt: () => {
            interruptCount += 1;
          },
        }),
      createServer: () => createStubServer(),
      now: () => {
        clock += 5;
        return clock;
      },
    });

    const result = await runtime.run(
      "typescript-style-reviewer",
      baseDefinition,
      createRuntimeContext(),
    );

    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.body).toContain("tightening lint rules");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(returnCount).toBe(1);
    expect(interruptCount).toBe(0);
  });

  test("surfaces SDK errors in the runtime response", async () => {
    const runtime = createClaudeAgentRuntime({
      runQuery: () => {
        throw new Error("sdk unavailable");
      },
      createServer: () => createStubServer(),
      now: () => 0,
    });

    const outcome = await runtime.run(
      "typescript-style-reviewer",
      baseDefinition,
      createRuntimeContext(),
    );

    expect(outcome.error).toContain("sdk unavailable");
    expect(outcome.findings).toHaveLength(0);
  });

  test("uses assistant JSON when result payload is empty", async () => {
    const assistantPayload = [
      "Initial notes.",
      "",
      "```json",
      '{"findings":[{"kind":"file","path":"src/index.ts","body":"Double-check type imports."}]}',
      "```",
    ].join("\n");
    const messages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: assistantPayload }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
      },
    ];

    let returnCount = 0;
    const runtime = createClaudeAgentRuntime({
      runQuery: () =>
        createStubQuery(messages, {
          onReturn: () => {
            returnCount += 1;
          },
        }),
      createServer: () => createStubServer(),
      now: () => Date.now(),
    });

    const outcome = await runtime.run(
      "typescript-style-reviewer",
      baseDefinition,
      createRuntimeContext(),
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.warning).toBeUndefined();
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.path).toBe("src/index.ts");
    expect(returnCount).toBe(1);
  });
});
