import path from "node:path";

import { Octokit } from "octokit";

import type { AgentDefinition, AgentIdentifier, AgentMap } from "./agents";
import { agents } from "./agents";
import { dedupeFindings } from "./dedupe";
import type { ParsedDiff } from "./parsing/unifiedDiff";
import { parseUnifiedDiff } from "./parsing/unifiedDiff";
import { createToolRegistry } from "./tools";
import type { ToolRegistry } from "./tools";
import type { Findings } from "./types";

type ReviewEnvironment = {
  workspace: string;
  owner: string;
  repo: string;
  repoSlug: string;
  prNumber?: number;
  githubToken?: string;
  anthropicApiKey?: string;
  postReview: boolean;
  isCi: boolean;
};

type PullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  blob_url?: string;
  raw_url?: string;
};

type PullRequestDetails = {
  data: Record<string, unknown>;
  diff: string;
  parsedDiff: ParsedDiff;
  files: PullRequestFile[];
};

type PullRequestIdentifier = {
  owner: string;
  repo: string;
  pullNumber: number;
};

export type GitHubClient = {
  getPullRequest(identifier: PullRequestIdentifier): Promise<Record<string, unknown>>;
  getPullRequestDiff(identifier: PullRequestIdentifier): Promise<string>;
  listPullRequestFiles(identifier: PullRequestIdentifier): Promise<PullRequestFile[]>;
  createReview(identifier: PullRequestIdentifier, review: ReviewSubmission): Promise<void>;
};

type ReviewContext = {
  environment: ReviewEnvironment;
  toolRegistry: ToolRegistry;
  pullRequest?: PullRequestDetails;
};

type AgentRunResult = {
  agentId: AgentIdentifier;
  findings: Findings;
  durationMs: number;
  warning?: string;
  error?: string;
};

export type AgentRuntime = {
  run(
    agentId: AgentIdentifier,
    definition: AgentDefinition,
    context: ReviewContext,
  ): Promise<AgentRunResult>;
};

export type RunReviewDependencies = {
  githubClient?: GitHubClient;
  agentRuntime?: AgentRuntime;
};

type ReviewCommentPayload = {
  path: string;
  body: string;
  side?: "RIGHT" | "LEFT";
  line?: number;
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
};

export type ReviewSubmission = {
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  body?: string;
  comments: ReviewCommentPayload[];
};

const GITHUB_REVIEW_EVENT: ReviewSubmission["event"] = "COMMENT";

const TRUTHY_FLAGS = new Set(["1", "true", "yes", "y", "on"]);

export function formatReviewPayload(findings: Findings): ReviewSubmission {
  const comments: ReviewCommentPayload[] = [];
  const summarySections: string[] = [];

  for (const finding of findings) {
    const bodyWithSuggestion = appendSuggestion(finding.body, finding.suggestion);
    switch (finding.kind) {
      case "summary": {
        summarySections.push(bodyWithSuggestion);
        break;
      }
      case "file": {
        summarySections.push(
          finding.path
            ? `**${finding.path}**\n\n${bodyWithSuggestion}`
            : bodyWithSuggestion,
        );
        break;
      }
      case "line": {
        if (!finding.path || typeof finding.line !== "number") {
          summarySections.push(bodyWithSuggestion);
          break;
        }
        comments.push({
          path: finding.path,
          line: finding.line,
          side: finding.side ?? "RIGHT",
          body: bodyWithSuggestion,
        });
        break;
      }
      case "range": {
        if (
          !finding.path ||
          typeof finding.line !== "number" ||
          typeof finding.start_line !== "number"
        ) {
          summarySections.push(bodyWithSuggestion);
          break;
        }
        comments.push({
          path: finding.path,
          line: finding.line,
          start_line: finding.start_line,
          side: finding.side ?? "RIGHT",
          start_side: finding.side ?? "RIGHT",
          body: bodyWithSuggestion,
        });
        break;
      }
      default: {
        summarySections.push(bodyWithSuggestion);
        break;
      }
    }
  }

  const body =
    summarySections.length > 0 ? summarySections.join("\n\n") : undefined;

  return {
    event: GITHUB_REVIEW_EVENT,
    body,
    comments,
  };
}

function appendSuggestion(body: string, suggestion: string | undefined): string {
  if (!suggestion) {
    return body;
  }

  const trimmed = suggestion.endsWith("\n") ? suggestion : `${suggestion}\n`;
  return `${body}\n\n\`\`\`suggestion\n${trimmed}\`\`\``;
}

function loadReviewEnvironment(env: NodeJS.ProcessEnv): ReviewEnvironment {
  const workspace = env.GITHUB_WORKSPACE
    ? path.resolve(env.GITHUB_WORKSPACE)
    : process.cwd();

  const repoSlug = env.GITHUB_REPOSITORY ?? env.AIRBOT_REPOSITORY;
  if (!repoSlug) {
    throw new Error(
      "Missing GITHUB_REPOSITORY environment variable (expected owner/repo).",
    );
  }

  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Repository slug "${repoSlug}" is invalid. Expected format "owner/repo".`,
    );
  }

  const rawPrNumber = env.PR_NUMBER ?? env.GITHUB_PR_NUMBER ?? "";
  const prNumber = rawPrNumber ? Number.parseInt(rawPrNumber, 10) : undefined;
  if (rawPrNumber && Number.isNaN(prNumber)) {
    throw new Error(
      `Pull request number "${rawPrNumber}" is not a valid integer.`,
    );
  }

  const githubToken = env.GITHUB_TOKEN || undefined;
  const anthropicApiKey = env.ANTHROPIC_API_KEY || undefined;
  const postReview =
    !!githubToken && getBooleanFlag(env.AIRBOT_POST_REVIEW ?? env.POST_REVIEW);

  const isCi =
    getBooleanFlag(env.CI) ||
    getBooleanFlag(env.GITHUB_ACTIONS) ||
    env.CI === "1" ||
    env.GITHUB_ACTIONS === "true";

  return {
    workspace,
    owner,
    repo,
    repoSlug,
    prNumber,
    githubToken,
    anthropicApiKey,
    postReview,
    isCi,
  };
}

function getBooleanFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return TRUTHY_FLAGS.has(value.toLowerCase());
}

async function loadPullRequestContext(
  client: GitHubClient,
  env: ReviewEnvironment,
): Promise<PullRequestDetails> {
  if (env.prNumber === undefined) {
    throw new Error(
      "Cannot fetch pull request data without PR_NUMBER or GITHUB_PR_NUMBER.",
    );
  }

  const identifier: PullRequestIdentifier = {
    owner: env.owner,
    repo: env.repo,
    pullNumber: env.prNumber,
  };

  // Fetch metadata, files, and diff in parallel so the overall latency is bounded
  // by the slowest GitHub endpoint.
  const [pullData, diffText, files] = await Promise.all([
    client.getPullRequest(identifier),
    client.getPullRequestDiff(identifier),
    client.listPullRequestFiles(identifier),
  ]);

  return {
    data: pullData,
    diff: diffText,
    parsedDiff: parseUnifiedDiff(diffText),
    files,
  };
}

function createGitHubClient(octokit: Octokit): GitHubClient {
  // Wrap Octokit so orchestration can swap in a fake client during tests.
  return {
    async getPullRequest(identifier) {
      const response = await octokit.rest.pulls.get({
        owner: identifier.owner,
        repo: identifier.repo,
        pull_number: identifier.pullNumber,
      });
      return response.data as Record<string, unknown>;
    },
    async getPullRequestDiff(identifier) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: identifier.owner,
          repo: identifier.repo,
          pull_number: identifier.pullNumber,
          headers: { accept: "application/vnd.github.v3.diff" },
        },
      );
      return typeof response.data === "string" ? response.data : "";
    },
    async listPullRequestFiles(identifier) {
      return (await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: identifier.owner,
        repo: identifier.repo,
        pull_number: identifier.pullNumber,
        per_page: 100,
      })) as PullRequestFile[];
    },
    async createReview(identifier, review) {
      await octokit.rest.pulls.createReview({
        owner: identifier.owner,
        repo: identifier.repo,
        pull_number: identifier.pullNumber,
        event: review.event,
        body: review.body,
        comments: review.comments,
      });
    },
  };
}

function createDefaultAgentRuntime(): AgentRuntime {
  // Default runtime short-circuits until the Claude integration lands; keeping it
  // here lets unit tests inject richer behavior without touching runReview.
  return {
    async run(agentId, _definition, context) {
      const startedAt = Date.now();
      try {
        if (!context.environment.anthropicApiKey) {
          return {
            agentId,
            findings: [],
            durationMs: Date.now() - startedAt,
            warning: "ANTHROPIC_API_KEY is not set; skipping agent execution.",
          };
        }

        if (!context.pullRequest) {
          return {
            agentId,
            findings: [],
            durationMs: Date.now() - startedAt,
            warning: "Pull request context unavailable; skipping agent execution.",
          };
        }

        // TODO: Integrate Claude Agent SDK once prompts and tooling are ready.
        return {
          agentId,
          findings: [],
          durationMs: Date.now() - startedAt,
          warning: "Agent execution not yet implemented.",
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown agent execution error";
        return {
          agentId,
          findings: [],
          durationMs: Date.now() - startedAt,
          error: message,
        };
      }
    },
  };
}

export async function runAgents(
  agentRuntime: AgentRuntime,
  agentMap: AgentMap,
  context: ReviewContext,
): Promise<{ results: AgentRunResult[]; findings: Findings }> {
  const results: AgentRunResult[] = [];
  const findings: Findings = [];

  for (const [agentId, definition] of Object.entries(agentMap) as [
    AgentIdentifier,
    AgentDefinition,
  ][]) {
    const result = await agentRuntime.run(agentId, definition, context);
    results.push(result);
    findings.push(...result.findings);
  }

  // Return both raw results (for logging) and flattened findings (for dedupe).
  return { results, findings };
}

export async function runReview(
  dependencies: RunReviewDependencies = {},
): Promise<void> {
  const environment = loadReviewEnvironment(process.env);
  console.log(
    `[airbot] Starting review for ${environment.repoSlug}` +
      (environment.prNumber !== undefined ? `#${environment.prNumber}` : ""),
  );

  const toolRegistry = createToolRegistry({ repoRoot: environment.workspace });
  const context: ReviewContext = {
    environment,
    toolRegistry,
  };

  const githubClient =
    dependencies.githubClient ??
    (environment.githubToken
      ? createGitHubClient(new Octokit({ auth: environment.githubToken }))
      : undefined);

  // Let callers supply a preconfigured runtime (e.g., mocked SDK) while keeping
  // the default path lightweight during scaffolding.
  const agentRuntime =
    dependencies.agentRuntime ?? createDefaultAgentRuntime();

  if (githubClient && environment.prNumber !== undefined) {
    try {
      context.pullRequest = await loadPullRequestContext(githubClient, environment);
      console.log(
        `[airbot] Fetched pull request data with ${context.pullRequest.files.length} changed files.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error fetching PR data";
      console.error(`[airbot] Failed to fetch pull request data: ${message}`);
    }
  } else {
    console.warn(
      "[airbot] GitHub client or PR number missing; running in metadata-light mode.",
    );
  }

  const { results: agentResults, findings: collectedFindings } =
    await runAgents(agentRuntime, agents, context);

  for (const result of agentResults) {
    if (result.error) {
      console.error(`[airbot] Agent ${result.agentId} failed: ${result.error}`);
    } else if (result.warning) {
      console.warn(
        `[airbot] Agent ${result.agentId} warning: ${result.warning}`,
      );
    } else {
      console.log(
        `[airbot] Agent ${result.agentId} completed with ${result.findings.length} findings.`,
      );
    }
  }

  const dedupedFindings = dedupeFindings(collectedFindings);
  const review = formatReviewPayload(dedupedFindings);

  if (
    !environment.postReview ||
    !githubClient ||
    environment.prNumber === undefined
  ) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          repository: environment.repoSlug,
          prNumber: environment.prNumber,
          findings: dedupedFindings,
          review,
          agents: agentResults.map((result) => ({
            agentId: result.agentId,
            durationMs: result.durationMs,
            warning: result.warning,
            error: result.error,
            findingCount: result.findings.length,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!review.body && review.comments.length === 0) {
    console.log(
      "[airbot] No findings detected after de-duplication; skipping review submission.",
    );
    return;
  }

  await githubClient.createReview(
    {
      owner: environment.owner,
      repo: environment.repo,
      pullNumber: environment.prNumber,
    },
    review,
  );

  console.log(
    `[airbot] Submitted review with ${review.comments.length} inline comments.`,
  );
}

if (import.meta.main) {
  runReview().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Unknown review execution error";
    console.error(`[airbot] Review run failed: ${message}`);
    process.exitCode = 1;
  });
}
