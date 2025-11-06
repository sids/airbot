import { Octokit } from "octokit";

import { dedupeFindings } from "./dedupe.js";
import {
  loadReviewEnvironment,
  type ReviewEnvironment,
} from "./environment.js";
import {
  createGitHubClient,
  loadPullRequestContext,
  type GitHubClient,
  type PullRequestDetails,
  type PullRequestFile,
  type PullRequestIdentifier,
} from "./github.js";
import {
  formatReviewPayload,
  type ReviewCommentPayload,
  type ReviewSubmission,
} from "./review-payload.js";
import {
  runClaudeOrchestrator,
  type ClaudeOrchestratorDependencies,
  type OrchestratorRunResult,
  type ReviewContext,
  type RunOrchestrator,
} from "./orchestrator.js";
import { createToolRegistry } from "./tools.js";

export type RunReviewDependencies = {
  githubClient?: GitHubClient;
  runOrchestrator?: RunOrchestrator;
} & ClaudeOrchestratorDependencies;

export {
  createGitHubClient,
  loadPullRequestContext,
  formatReviewPayload,
  runClaudeOrchestrator,
  loadReviewEnvironment,
};

export type {
  GitHubClient,
  PullRequestDetails,
  PullRequestFile,
  PullRequestIdentifier,
  ReviewCommentPayload,
  ReviewContext,
  ReviewEnvironment,
  ReviewSubmission,
  OrchestratorRunResult,
  ClaudeOrchestratorDependencies,
  RunOrchestrator,
};

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

  const orchestratorDependencies: ClaudeOrchestratorDependencies = {
    runQuery: dependencies.runQuery,
    createServer: dependencies.createServer,
    now: dependencies.now,
    discoverPlugins: dependencies.discoverPlugins,
  };

  const runOrchestrator = dependencies.runOrchestrator ?? runClaudeOrchestrator;

  const orchestratorResult = await runOrchestrator(
    context,
    orchestratorDependencies,
  );

  if (orchestratorResult.error) {
    console.error(
      `[airbot] Claude orchestration failed: ${orchestratorResult.error}`,
    );
  } else if (orchestratorResult.warning) {
    console.warn(
      `[airbot] Claude orchestration warning: ${orchestratorResult.warning}`,
    );
  } else {
    console.log(
      `[airbot] Claude orchestration completed with ${orchestratorResult.findings.length} findings.`,
    );
  }

  const dedupedFindings = dedupeFindings(orchestratorResult.findings);
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
          session: {
            durationMs: orchestratorResult.durationMs,
            warning: orchestratorResult.warning,
            error: orchestratorResult.error,
            assistantOutputs: orchestratorResult.assistantOutputs,
            findingCount: orchestratorResult.findings.length,
          },
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
