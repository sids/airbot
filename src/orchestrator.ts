import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { ReviewEnvironment } from "./environment.js";
import type { PullRequestDetails, PullRequestFile } from "./github.js";
import {
  discoverLocalPluginConfigs,
  type PluginDiscoveryResult,
} from "./plugins.js";
import type { ToolRegistry } from "./tools.js";
import type { Findings } from "./types.js";

type ClaudeQuery = AsyncGenerator<Record<string, unknown>, void, unknown> & {
  return?: (value?: unknown) => Promise<IteratorResult<Record<string, unknown>, void>>;
  interrupt?: () => Promise<void>;
};

type RegisteredTool = ToolRegistry[keyof ToolRegistry];

type CallToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

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

export type ReviewContext = {
  environment: ReviewEnvironment;
  toolRegistry: ToolRegistry;
  pullRequest?: PullRequestDetails;
};

export type ClaudeOrchestratorDependencies = {
  runQuery?: typeof query;
  createServer?: typeof createSdkMcpServer;
  now?: () => number;
  discoverPlugins?: (
    workspace: string,
  ) => Promise<PluginDiscoveryResult>;
};

export type OrchestratorRunResult = {
  findings: Findings;
  durationMs: number;
  warning?: string;
  error?: string;
  assistantOutputs: string[];
};

export type RunOrchestrator = (
  context: ReviewContext,
  dependencies?: ClaudeOrchestratorDependencies,
) => Promise<OrchestratorRunResult>;

export async function runClaudeOrchestrator(
  context: ReviewContext,
  dependencies: ClaudeOrchestratorDependencies = {},
): Promise<OrchestratorRunResult> {
  const runQuery = dependencies.runQuery ?? query;
  const createServer = dependencies.createServer ?? createSdkMcpServer;
  const now = dependencies.now ?? Date.now;
  const discoverPlugins =
    dependencies.discoverPlugins ?? discoverLocalPluginConfigs;

  const startedAt = now();
  const elapsed = () => Math.max(now() - startedAt, 0);

  if (!context.environment.anthropicApiKey) {
    return {
      findings: [],
      durationMs: elapsed(),
      warning: "ANTHROPIC_API_KEY is not set; skipping Claude orchestration.",
      assistantOutputs: [],
    };
  }

  if (!context.pullRequest) {
    return {
      findings: [],
      durationMs: elapsed(),
      warning: "Pull request context unavailable; skipping Claude orchestration.",
      assistantOutputs: [],
    };
  }

  const registeredTools = Object.values(
    context.toolRegistry,
  ) as RegisteredTool[];
  const sdkTools = registeredTools.map((toolDefinition) =>
    tool(
      toolDefinition.name,
      toolDefinition.description,
      toolDefinition.schema.shape,
      async (args: unknown) => callTool(toolDefinition, args),
    ),
  );

  const mcpServer =
    sdkTools.length > 0
      ? createServer({
          name: "airbot-tools",
          version: "0.2.0",
          tools: sdkTools,
        })
      : undefined;

  const pluginDiscovery = await discoverPlugins(context.environment.workspace);
  const pluginConfigs = pluginDiscovery.configs;
  const pluginWarnings = pluginDiscovery.warnings;

  let stream: ClaudeQuery | undefined;

  try {
    const userPrompt = buildOrchestratorPrompt(context, registeredTools);

    const mcpServers = mcpServer ? { "airbot-tools": mcpServer } : undefined;

    stream = runQuery({
      prompt: userPrompt,
      options: {
        cwd: context.environment.workspace,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: context.environment.anthropicApiKey,
        },
        mcpServers,
        plugins: pluginConfigs.length > 0 ? pluginConfigs : undefined,
        settingSources: ["project"],
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

    const warnings: string[] = [...pluginWarnings];

    if (!resultMessage) {
      warnings.push("Claude orchestration did not produce a result message.");
      return {
        findings: [],
        durationMs: elapsed(),
        warning: warnings.join(" "),
        assistantOutputs,
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
      const errorText =
        resultText && resultText.trim().length > 0
          ? resultText
          : "Claude orchestrator returned an error result.";
      return {
        findings: [],
        durationMs: elapsed(),
        error: errorText,
        assistantOutputs,
      };
    }

    const candidateTexts: string[] = [];
    if (resultText && resultText.trim().length > 0) {
      candidateTexts.push(resultText);
    }
    candidateTexts.push(...assistantOutputs.slice().reverse());

    const parsed = extractFindingsFromOutputs(candidateTexts);
    if (parsed.warning) {
      warnings.push(parsed.warning);
    }

    return {
      findings: parsed.findings,
      durationMs: elapsed(),
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
      assistantOutputs,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Claude orchestration error";
    return {
      findings: [],
      durationMs: elapsed(),
      error: message,
      assistantOutputs: [],
      warning: pluginWarnings.length > 0 ? pluginWarnings.join(" ") : undefined,
    };
  } finally {
    await disposeQuery(stream);
    try {
      await mcpServer?.instance.close();
    } catch {
      // Ignore close failures to avoid masking earlier errors.
    }
  }
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

function buildOrchestratorPrompt(
  context: ReviewContext,
  tools: RegisteredTool[],
): string {
  const sections: string[] = [];

  const { environment, pullRequest } = context;
  const prLabel =
    environment.prNumber !== undefined
      ? `${environment.repoSlug}#${environment.prNumber}`
      : environment.repoSlug;

  sections.push(
    "You are AIRBot's autonomous review orchestrator. Discover the reviewer skills exposed by the installed Claude plugins and spin up focused subagents that apply each rubric to the pull request.",
  );

  sections.push(
    "For each domain (TypeScript style, security, tests, backend architecture, Kotlin coroutines, SQL/DAO), load the corresponding skill guidance (CLAUDE.md plus the plugin's skills/*/SKILL.md) and instantiate an ad-hoc subagent that cites the skill while producing findings.",
  );

  const metadataNotice = pullRequest
    ? ""
    : " Pull request metadata is limited; rely on repository exploration.";
  sections.push(`Target pull request: ${prLabel}.${metadataNotice}`);

  if (pullRequest) {
    const prData = pullRequest.data as Record<string, unknown>;
    const prTitle =
      prData && typeof prData.title === "string" ? (prData.title as string) : undefined;
    if (prTitle) {
      sections.push(`Title: ${prTitle}`);
    }
    const filesSummary = formatChangedFilesList(pullRequest.files);
    sections.push(`Changed files:\n${filesSummary}`);
  }

  if (tools.length > 0) {
    const toolLines = tools
      .map((toolDefinition) => `- ${toolDefinition.name}: ${toolDefinition.description}`)
      .join("\n");
    sections.push(
      "Repository tools available during this session:\n" + toolLines,
    );
  } else {
    sections.push("Repository tools are not available for this run.");
  }

  sections.push(
    "Let subagents run as needed, summarize or deduplicate overlapping findings, and only surface actionable insights.",
  );

  sections.push(
    'Respond with JSON matching {"findings": [...]}.' +
      " Each finding must include kind, path, and body, and may include line, start_line, side, and suggestion." +
      ' Return {"findings": []} when there are no issues.',
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
      warning: "Claude orchestrator did not return structured findings JSON.",
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
      ? `Unable to parse findings JSON (${lastError}).`
      : "Unable to parse findings JSON.",
  };
}

async function disposeQuery(stream: ClaudeQuery | undefined): Promise<void> {
  if (!stream) {
    return;
  }

  try {
    if (typeof stream.return === "function") {
      await stream.return();
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
    candidates.push(trimmed);
  }

  return candidates;
}
