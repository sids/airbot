import { describe, expect, test } from "bun:test";

import type { Octokit } from "octokit";

import {
  createGitHubClient,
  formatReviewPayload,
  runClaudeOrchestrator,
} from "../src/index";
import type { ReviewSubmission } from "../src/index";
import type { Finding } from "../src/types";
import type { ToolRegistry } from "../src/tools";
import { z } from "zod";

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



describe("runClaudeOrchestrator", () => {
  type OrchestratorContext = Parameters<typeof runClaudeOrchestrator>[0];
  type OrchestratorDependencies = Parameters<typeof runClaudeOrchestrator>[1];

  function createContext(
    overrides: Partial<OrchestratorContext> & {
      environment?: Partial<OrchestratorContext["environment"]>;
    } = {},
  ): OrchestratorContext {
    const basePullRequest: NonNullable<OrchestratorContext["pullRequest"]> = {
      data: { title: "Refine orchestrator" },
      diff: "",
      parsedDiff: [] as unknown as import("../src/parsing/unifiedDiff").ParsedDiff,
      files: [
        {
          filename: "src/index.ts",
          additions: 4,
          deletions: 1,
          changes: 5,
          status: "modified",
        } as unknown as { filename: string },
      ],
    };

    const baseContext: OrchestratorContext = {
      environment: {
        workspace: "/workspace",
        owner: "acme",
        repo: "airbot",
        repoSlug: "acme/airbot",
        postReview: false,
        isCi: false,
        anthropicApiKey: "sk-test",
      },
      toolRegistry: {} as ToolRegistry,
      pullRequest: basePullRequest,
    };

    const environment = {
      ...baseContext.environment,
      ...(overrides.environment ?? {}),
    };

    const toolRegistry = overrides.toolRegistry ?? baseContext.toolRegistry;
    const pullRequest =
      Object.prototype.hasOwnProperty.call(overrides, "pullRequest")
        ? (overrides.pullRequest as OrchestratorContext["pullRequest"])
        : baseContext.pullRequest;

    return {
      environment,
      toolRegistry,
      pullRequest,
    };
  }

  function createStubServer() {
    return {
      instance: {
        async connect() {
          // no-op
        },
        async close() {
          // no-op
        },
      },
    } as unknown;
  }

  // Minimal AsyncGenerator stub that mimics the Claude SDK stream interface for unit tests.
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

  test("returns a warning when ANTHROPIC_API_KEY is missing", async () => {
    const context = createContext({ environment: { anthropicApiKey: undefined } });

    const result = await runClaudeOrchestrator(context);

    expect(result.warning).toContain("ANTHROPIC_API_KEY");
    expect(result.findings).toHaveLength(0);
  });

  test("returns a warning when pull request context is missing", async () => {
    const context = createContext({ pullRequest: undefined });

    const result = await runClaudeOrchestrator(context);

    expect(result.warning).toContain("Pull request context unavailable");
    expect(result.findings).toHaveLength(0);
  });

  test("collects findings from the result payload", async () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Reviewing pull request" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result:
          '{"findings":[{"kind":"summary","path":"","body":"Ready to ship."}]}',
      },
    ];

    let clock = 0;
    let returnCount = 0;
    let interruptCount = 0;
    let serverCreated = 0;

    const toolRegistry: ToolRegistry = {
      Read: {
        name: "Read",
        description: "Read file contents",
        schema: z.object({ path: z.string() }),
        invoke: async () => "ok",
      },
    } as unknown as ToolRegistry;

    const dependencies: OrchestratorDependencies = {
      runQuery: () =>
        createStubQuery(messages, {
          onReturn: () => {
            returnCount += 1;
          },
          onInterrupt: () => {
            interruptCount += 1;
          },
        }),
      createServer: () => {
        serverCreated += 1;
        return createStubServer();
      },
      now: () => {
        clock += 5;
        return clock;
      },
    };

    const context = createContext({ toolRegistry });

    const result = await runClaudeOrchestrator(context, dependencies);

    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.body).toContain("Ready to ship");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(returnCount).toBe(1);
    expect(interruptCount).toBe(0);
    expect(serverCreated).toBe(1);
  });

  test("falls back to assistant JSON when result text is empty", async () => {
    const assistantPayload = [
      "Initial notes.",
      "",
      "```json",
      '{"findings":[{"kind":"file","path":"src/index.ts","body":"Double-check imports."}]}',
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

    const dependencies: OrchestratorDependencies = {
      runQuery: () =>
        createStubQuery(messages, {
          onReturn: () => {
            returnCount += 1;
          },
        }),
      createServer: () => createStubServer(),
      now: () => Date.now(),
    };

    const context = createContext();

    const result = await runClaudeOrchestrator(context, dependencies);

    expect(result.error).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe("src/index.ts");
    expect(returnCount).toBe(1);
  });
});
