import { normalizeGitPath, splitDiffGitHeaderPaths } from "./gitPath";

/**
 * Types describing the structure of a parsed GitHub unified diff.
 */
export type DiffLineType = "context" | "add" | "remove";

export type DiffLine = {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  /** Indicates the original file lacked a trailing newline for this line. */
  noNewlineAtEndOfFile?: boolean;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  sectionHeading?: string;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string;
  newPath: string;
  rawOldPath: string;
  rawNewPath: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  rename?: { from: string; to: string; rawFrom?: string; rawTo?: string };
  modeChange?: { oldMode?: string; newMode?: string };
  index?: string;
};

export type ParsedDiff = DiffFile[];

const DIFF_GIT_PREFIX = "diff --git ";
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedDiff = [];

  let currentFile: DiffFile | undefined;
  let currentHunk: DiffHunk | undefined;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith(DIFF_GIT_PREFIX)) {
      // The `diff --git` header always carries two path tokens. Bail out
      // gracefully if the line is malformed so downstream state stays sane.
      const headerPaths = splitDiffGitHeaderPaths(line.slice(DIFF_GIT_PREFIX.length));
      if (!headerPaths) {
        currentFile = undefined;
        currentHunk = undefined;
        continue;
      }

      const { rawOldPath, rawNewPath } = headerPaths;
      const oldPath = normalizeGitPath(rawOldPath);
      const newPath = normalizeGitPath(rawNewPath);

      currentFile = {
        oldPath,
        newPath,
        rawOldPath,
        rawNewPath,
        hunks: [],
        isBinary: false,
        isNewFile: false,
        isDeletedFile: false,
      };
      files.push(currentFile);
      currentHunk = undefined;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith("index ")) {
      currentFile.index = line.slice("index ".length).trim();
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentFile.isNewFile = true;
      const mode = line.slice("new file mode ".length).trim();
      currentFile.modeChange = {
        ...(currentFile.modeChange ?? {}),
        newMode: mode,
      };
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      currentFile.isDeletedFile = true;
      const mode = line.slice("deleted file mode ".length).trim();
      currentFile.modeChange = {
        ...(currentFile.modeChange ?? {}),
        oldMode: mode,
      };
      continue;
    }

    if (line.startsWith("old mode ")) {
      const mode = line.slice("old mode ".length).trim();
      currentFile.modeChange = {
        ...(currentFile.modeChange ?? {}),
        oldMode: mode,
      };
      continue;
    }

    if (line.startsWith("new mode ")) {
      const mode = line.slice("new mode ".length).trim();
      currentFile.modeChange = {
        ...(currentFile.modeChange ?? {}),
        newMode: mode,
      };
      continue;
    }

    if (line.startsWith("rename from ")) {
      const rawFrom = line.slice("rename from ".length);
      const from = normalizeGitPath(rawFrom);
      currentFile.rename = {
        ...(currentFile.rename ?? {}),
        from,
        rawFrom,
        rawTo: currentFile.rename?.rawTo,
      };
      currentFile.oldPath = from;
      continue;
    }

    if (line.startsWith("rename to ")) {
      const rawTo = line.slice("rename to ".length);
      const to = normalizeGitPath(rawTo);
      currentFile.rename = {
        ...(currentFile.rename ?? {}),
        to,
        rawFrom: currentFile.rename?.rawFrom,
        rawTo,
      };
      currentFile.newPath = to;
      continue;
    }

    if (line.startsWith("--- ")) {
      const normalized = normalizeGitPath(line.slice(4));
      currentFile.oldPath = normalized;
      if (normalized === "/dev/null") {
        currentFile.isNewFile = true;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const normalized = normalizeGitPath(line.slice(4));
      currentFile.newPath = normalized;
      if (normalized === "/dev/null") {
        currentFile.isDeletedFile = true;
      }
      continue;
    }

    if (line.startsWith("Binary files ")) {
      currentFile.isBinary = true;
      currentHunk = undefined;
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      const [, oldStart, oldLength, newStart, newLength, heading] = hunkMatch;
      oldLineNumber = Number(oldStart);
      newLineNumber = Number(newStart);

      currentHunk = {
        header: line,
        oldStart: oldLineNumber,
        oldLines: oldLength ? Number(oldLength) : 1,
        newStart: newLineNumber,
        newLines: newLength ? Number(newLength) : 1,
        sectionHeading: heading?.trim() ? heading.trim() : undefined,
        lines: [],
      };

      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line === "\\ No newline at end of file") {
      const lastLine = currentHunk.lines[currentHunk.lines.length - 1];
      if (lastLine) {
        lastLine.noNewlineAtEndOfFile = true;
      }
      continue;
    }

    const marker = line[0];
    const content = line.slice(1);

    if (marker === " ") {
      const diffLine: DiffLine = {
        type: "context",
        content,
        oldLineNumber,
        newLineNumber,
      };
      currentHunk.lines.push(diffLine);
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (marker === "+") {
      const diffLine: DiffLine = {
        type: "add",
        content,
        newLineNumber,
      };
      currentHunk.lines.push(diffLine);
      newLineNumber += 1;
    } else if (marker === "-") {
      const diffLine: DiffLine = {
        type: "remove",
        content,
        oldLineNumber,
      };
      currentHunk.lines.push(diffLine);
      oldLineNumber += 1;
    }
  }

  return files;
}
