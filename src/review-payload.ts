import type { Findings } from "./types.js";

export type ReviewCommentPayload = {
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
