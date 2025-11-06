import path from "node:path";

const TRUTHY_FLAGS = new Set(["1", "true", "yes", "y", "on"]);

export type ReviewEnvironment = {
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

export function loadReviewEnvironment(env: NodeJS.ProcessEnv): ReviewEnvironment {
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
