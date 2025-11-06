import type { Octokit } from "octokit";

import type { ReviewEnvironment } from "./environment.js";
import type { ParsedDiff } from "./parsing/unifiedDiff.js";
import { parseUnifiedDiff } from "./parsing/unifiedDiff.js";
import type { ReviewSubmission } from "./review-payload.js";

export type PullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  blob_url?: string;
  raw_url?: string;
};

export type PullRequestDetails = {
  data: Record<string, unknown>;
  diff: string;
  parsedDiff: ParsedDiff;
  files: PullRequestFile[];
};

export type PullRequestIdentifier = {
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

export async function loadPullRequestContext(
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
