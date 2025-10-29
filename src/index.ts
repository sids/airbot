import path from "node:path";

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { z } from "zod";

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

type ClaudeQuery = AsyncGenerator<Record<string, unknown>, void, unknown> & {
  return?: (value?: unknown) => Promise<IteratorResult<Record<string, unknown>, void>>;
  interrupt?: () => Promise<void>;
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

export function createGitHubClient(octokit: Octokit): GitHubClient {
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

const CLAUDE_SUPPORTED_MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);

const findingSchema = z
  .object({
    kind: z.enum(["summary", "file", "line", "range"]),
    path: z.string(),
    body: z.string(),
    suggestion: z.string().optional(),
    line: z.number().int().positive().optional(),
    start_line: z.number().int().positive().optional(),
    side: z.enum(["RIGHT", "LEFT"]).optional(),
  })
  .strict();

const findingsArraySchema = z.array(findingSchema);

const findingsPayloadSchema = z
  .object({
    findings: findingsArraySchema,
  })
  .strict();

type ClaudeRuntimeDependencies = {
  runQuery?: typeof query;
  createServer?: typeof createSdkMcpServer;
  now?: () => number;
};

type RegisteredTool = ToolRegistry[keyof ToolRegistry];

export function createClaudeAgentRuntime(
  dependencies: ClaudeRuntimeDependencies = {},
): AgentRuntime {
  const runQuery = dependencies.runQuery ?? query;
  const createServer = dependencies.createServer ?? createSdkMcpServer;
  const now = dependencies.now ?? Date.now;

  return {
    async run(agentId, definition, context) {
      const startedAt = now();
      const elapsed = () => Math.max(now() - startedAt, 0);

      if (!context.environment.anthropicApiKey) {
        return {
          agentId,
          findings: [],
          durationMs: elapsed(),
          warning: "ANTHROPIC_API_KEY is not set; skipping agent execution.",
        };
      }

      if (!context.pullRequest) {
        return {
          agentId,
          findings: [],
          durationMs: elapsed(),
          warning: "Pull request context unavailable; skipping agent execution.",
        };
      }

      const requestedTools = definition.tools ?? [];
      const registeredTools = requestedTools
        .map((toolName) => context.toolRegistry[toolName])
        .filter((tool): tool is RegisteredTool => Boolean(tool));
      const missingToolNames = requestedTools.filter(
        (toolName) => !context.toolRegistry[toolName],
      );

      const sdkTools = registeredTools.map((toolDefinition) =>
        tool(
          toolDefinition.name,
          toolDefinition.description,
          toolDefinition.schema as unknown as z.ZodTypeAny,
          async (args: unknown) => callTool(toolDefinition, args),
        ),
      );

      const mcpServer =
        sdkTools.length > 0
          ? createServer({
              name: `airbot-tools-${agentId}`,
              version: "0.1.0",
              tools: sdkTools,
            })
          : undefined;

      let stream: ClaudeQuery | undefined;

      try {
        const agentPrompt = buildAgentInstructionPrompt(definition, registeredTools);
        const userPrompt = buildUserPrompt(
          agentId,
          definition,
          context,
          registeredTools,
        );

        const mcpServers = mcpServer
          ? { [`airbot-tools-${agentId}`]: mcpServer }
          : undefined;

        // Keep a handle to the Claude stream so we can terminate it after collecting messages.
        stream = runQuery({
          prompt: userPrompt,
          options: {
            cwd: context.environment.workspace,
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: context.environment.anthropicApiKey,
            },
            agents: {
              [agentId]: {
                description: definition.description,
                prompt: agentPrompt,
                tools: registeredTools.map((tool) => tool.name),
                model: normalizeModel(definition.model),
              },
            },
            mcpServers,
          },
        }) as ClaudeQuery;

        const assistantOutputs: string[] = [];
        let resultMessage: Record<string, unknown> | undefined;

        for await (const message of stream) {
          const type = typeof message.type === "string" ? message.type : undefined;
          if (type === "assistant") {
            const assistantText = collectAssistantText(message);
            if (assistantText) {
              assistantOutputs.push(assistantText);
            }
          } else if (type === "result") {
            resultMessage = message;
          }
        }

        const warnings: string[] = [];
        if (missingToolNames.length > 0) {
          warnings.push(
            `Agent requested unknown tools: ${missingToolNames.join(", ")}.`,
          );
        }

        if (!resultMessage) {
          warnings.push("Agent runtime did not produce a result message.");
          return {
            agentId,
            findings: [],
            durationMs: elapsed(),
            warning: warnings.join(" "),
          };
        }

        const subtype =
          typeof resultMessage.subtype === "string" ? resultMessage.subtype : undefined;
        const isError = resultMessage.is_error === true;
        const resultText =
          typeof resultMessage.result === "string" ? resultMessage.result : undefined;
        const permissionDenialsRaw = resultMessage.permission_denials;
        const permissionDenials = Array.isArray(permissionDenialsRaw)
          ? permissionDenialsRaw
          : [];

        if (permissionDenials.length > 0) {
          warnings.push("One or more tool invocations were denied.");
        }

        if (isError || subtype !== "success") {
          const errorText = resultText && resultText.trim().length > 0
            ? resultText
            : "Agent returned an error result.";
          return {
            agentId,
            findings: [],
            durationMs: elapsed(),
            error: errorText,
          };
        }

        const candidateTexts: string[] = [];
        if (resultText && resultText.trim().length > 0) {
          candidateTexts.push(resultText);
        }
        // Earlier assistant chunks are useful, but prefer the freshest content first.
        candidateTexts.push(...assistantOutputs.reverse());

        const parsed = extractFindingsFromOutputs(candidateTexts);
        if (parsed.warning) {
          warnings.push(parsed.warning);
        }

        return {
          agentId,
          findings: parsed.findings,
          durationMs: elapsed(),
          warning: warnings.length > 0 ? warnings.join(" ") : undefined,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown agent execution error";
        return {
          agentId,
          findings: [],
          durationMs: elapsed(),
          error: message,
        };
      } finally {
        await disposeQuery(stream);
        try {
          await mcpServer?.instance.close();
        } catch {
          // Ignore close failures to avoid masking earlier errors.
        }
      }
    },
  };
}

function createDefaultAgentRuntime(): AgentRuntime {
  return createClaudeAgentRuntime();
}

function normalizeModel(
  model: string | undefined,
): "sonnet" | "opus" | "haiku" | "inherit" | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.toLowerCase();
  if (CLAUDE_SUPPORTED_MODELS.has(normalized)) {
    return normalized as "sonnet" | "opus" | "haiku" | "inherit";
  }
  return undefined;
}

async function callTool(
  toolDefinition: RegisteredTool,
  rawInput: unknown,
): Promise<CallToolResult> {
  try {
    const result = await toolDefinition.invoke(rawInput as never);
    const structured =
      result !== null && typeof result === "object"
        ? (result as Record<string, unknown>)
        : { value: result };
    const textSummary =
      typeof result === "string" ? result : JSON.stringify(structured, null, 2);

    return {
      content: [
        {
          type: "text",
          text: textSummary,
        },
      ],
      structuredContent: structured,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown tool error");
    return {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: true,
    };
  }
}

function buildAgentInstructionPrompt(
  definition: AgentDefinition,
  tools: RegisteredTool[],
): string {
  const sections: string[] = [];
  const trimmedPrompt = definition.prompt.trim();
  if (trimmedPrompt.length > 0) {
    sections.push(trimmedPrompt);
  }

  if (tools.length > 0) {
    const toolLines = tools
      .map((toolDefinition) => `- ${toolDefinition.name}: ${toolDefinition.description}`)
      .join("\n");
    sections.push(
      "You have access to the following repository tools:\n" + toolLines,
    );
  } else {
    sections.push("Repository tools are not available for this run.");
  }

  sections.push(
    "Use the tools judiciously to inspect the current pull request changes and repository context before forming conclusions.",
  );

  sections.push(
    "When you are ready to respond, provide JSON matching {\"findings\": [ ... ]}. Each finding must include `kind`, `path`, and `body`, and may include `line`, `start_line`, `side`, and `suggestion`.",
  );
  sections.push("If there are no findings, respond with {\"findings\": []}.");

  return sections.join("\n\n");
}

function buildUserPrompt(
  agentId: AgentIdentifier,
  definition: AgentDefinition,
  context: ReviewContext,
  tools: RegisteredTool[],
): string {
  const sections: string[] = [`/agent ${agentId}`];

  const { environment, pullRequest } = context;
  const prLabel =
    environment.prNumber !== undefined
      ? `${environment.repoSlug}#${environment.prNumber}`
      : environment.repoSlug;
  sections.push(`Task: Review pull request ${prLabel} as the ${definition.description}.`);

  if (pullRequest) {
    const prData = pullRequest.data as Record<string, unknown>;
    const prTitle =
      prData && typeof prData.title === "string" ? (prData.title as string) : undefined;
    if (prTitle) {
      sections.push(`Title: ${prTitle}`);
    }
    const filesSummary = formatChangedFilesList(pullRequest.files);
    sections.push(`Changed files:\n${filesSummary}`);
  } else {
    sections.push(
      "Pull request metadata is unavailable; rely on repository state and tool exploration.",
    );
  }

  if (tools.length > 0) {
    sections.push(
      `Use the available tools (${tools
        .map((toolDefinition) => toolDefinition.name)
        .join(", ")}) to gather context before finalizing findings.`,
    );
  }

  sections.push(
    "Respond only with JSON following the expected schema so AIRBot can parse your findings.",
  );

  return sections.join("\n\n");
}

function formatChangedFilesList(files: PullRequestFile[]): string {
  if (files.length === 0) {
    return "(no file metadata available)";
  }

  const limit = 20;
  const selected = files.slice(0, limit);
  const lines = selected.map((file) => {
    const additions = file.additions ?? 0;
    const deletions = file.deletions ?? 0;
    const status = file.status ? ` (${file.status})` : "";
    return `- ${file.filename} (+${additions}/-${deletions})${status}`;
  });

  if (files.length > limit) {
    lines.push(`- ...and ${files.length - limit} more files`);
  }

  return lines.join("\n");
}

function collectAssistantText(message: Record<string, unknown>): string {
  const payload = message.message;
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      texts.push((block as { text: string }).text);
    }
  }

  return texts.join("\n\n").trim();
}

function extractFindingsFromOutputs(
  outputs: string[],
): { findings: Findings; warning?: string } {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const output of outputs) {
    if (!output) {
      continue;
    }
    for (const candidate of extractJsonCandidates(output)) {
      const trimmed = candidate.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      candidates.push(trimmed);
    }
  }

  if (candidates.length === 0) {
    return {
      findings: [],
      warning: "Agent did not return structured findings JSON.",
    };
  }

  let lastError: string | undefined;

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const objectResult = findingsPayloadSchema.safeParse(parsed);
      if (objectResult.success) {
        return { findings: objectResult.data.findings };
      }

      const arrayResult = findingsArraySchema.safeParse(parsed);
      if (arrayResult.success) {
        return { findings: arrayResult.data };
      }

      lastError = objectResult.error?.message ?? arrayResult.error.message;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    findings: [],
    warning: lastError
      ? `Unable to parse agent findings JSON (${lastError}).`
      : "Unable to parse agent findings JSON.",
  };
}

async function disposeQuery(stream: ClaudeQuery | undefined): Promise<void> {
  if (!stream) {
    return;
  }

  try {
    if (typeof stream.return === "function") {
      await stream.return();
      // `return()` is the graceful shutdown path; once it resolves we do not need to send an interrupt.
      return;
    }
    if (typeof stream.interrupt === "function") {
      await stream.interrupt();
    }
  } catch {
    // Best-effort cleanup; errors here are non-critical.
  }
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;

  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    candidates.push(match[1] ?? "");
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // Unfenced JSON sometimes appears as the entire assistant message; treat it as a candidate too.
    candidates.push(trimmed);
  }

  return candidates;
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
