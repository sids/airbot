import { createReadStream } from "node:fs";
import { readFile, readdir, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { Glob } from "bun";
import { z } from "zod";

const DEFAULT_MAX_READ_BYTES = 200_000;
const DEFAULT_MAX_GLOB_RESULTS = 250;
const DEFAULT_MAX_GREP_RESULTS = 200;
const DEFAULT_CONTEXT_CHARS = 200;

const SUPPORTED_ENCODINGS = ["utf8", "utf16le", "latin1"] as const;
type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".beads",
  ".claude",
  ".turbo",
]);

export type ToolName = "Read" | "Glob" | "Grep";

export type ToolContext = {
  repoRoot: string;
};

export type ReadResult = {
  path: string;
  content: string;
};

export type GlobResult = {
  matches: string[];
  truncated: boolean;
};

export type GrepMatch = {
  path: string;
  line: number;
  column: number;
  match: string;
  context: string;
  offset: number;
  byteOffset: number;
};

export type GrepResult = {
  matches: GrepMatch[];
  truncated: boolean;
};

type ToolDefinition<TSchema extends z.ZodTypeAny, TResult> = {
  name: ToolName;
  description: string;
  schema: TSchema;
  invoke: (input: z.input<TSchema>) => Promise<TResult>;
};

export type ToolRegistry = {
  Read: ToolDefinition<typeof readInputSchema, ReadResult>;
  Glob: ToolDefinition<typeof globInputSchema, GlobResult>;
  Grep: ToolDefinition<typeof grepInputSchema, GrepResult>;
};

const encodingSchema = z.enum(SUPPORTED_ENCODINGS);

const readInputSchema = z.object({
  path: z.string().min(1, "path is required"),
  encoding: encodingSchema.default("utf8"),
  maxBytes: z.number().int().positive().max(1_000_000).optional(),
});

const globInputSchema = z.object({
  pattern: z.string().min(1, "pattern is required"),
  cwd: z.string().min(1).optional(),
  maxResults: z.number().int().positive().max(5_000).optional(),
});

const validRegexFlags = new Set(["g", "i", "m", "s", "u", "y", "d"]);

const grepInputSchema = z
  .object({
    pattern: z.string().min(1, "pattern is required"),
    flags: z
      .string()
      .optional()
      .refine(
        (flags) =>
          flags === undefined ||
          flags.split("").every((flag) => validRegexFlags.has(flag)),
        "flags must be valid JavaScript RegExp flags",
      ),
    path: z
      .union([z.string().min(1), z.array(z.string().min(1))])
      .optional(),
    maxResults: z.number().int().positive().max(5_000).optional(),
    encoding: encodingSchema.default("utf8"),
  })
  .strict();

function splitPathSegments(relativePath: string): string[] {
  return relativePath
    .split(/[/\\]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// Check each path segment so nested ignored directories are excluded as well.
function includesIgnoredDirectory(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") {
    return false;
  }

  const segments = splitPathSegments(relativePath);
  return segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
}

function resolveWithinRepo(repoRoot: string, relativePath: string): string {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0) {
    throw new Error("Path cannot be empty");
  }

  const absolute = path.resolve(repoRoot, trimmed);
  const normalizedRoot = path.resolve(repoRoot);
  const relative = path.relative(normalizedRoot, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path "${relativePath}" escapes the repository root`);
  }

  return absolute;
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  const normalizedRoot = path.resolve(repoRoot);
  const relative = path.relative(normalizedRoot, absolutePath);
  return relative === "" ? "." : relative;
}

async function assertIsReadableFile(absolutePath: string): Promise<void> {
  const fileInfo = await lstat(absolutePath);
  if (fileInfo.isSymbolicLink()) {
    throw new Error(`Path "${absolutePath}" is a symbolic link and is not readable`);
  }
  if (!fileInfo.isFile()) {
    throw new Error(`Path "${absolutePath}" is not a file`);
  }
}

function defineTool<TSchema extends z.ZodTypeAny, TResult>(
  config: {
    name: ToolName;
    description: string;
    schema: TSchema;
    executor: (input: z.output<TSchema>) => Promise<TResult>;
  },
): ToolDefinition<TSchema, TResult> {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    invoke: async (input) => {
      const parsed = config.schema.parse(input);
      return config.executor(parsed);
    },
  };
}

async function readFileWithLimit(
  absolutePath: string,
  encoding: SupportedEncoding,
  maxBytes: number,
): Promise<string> {
  const info = await stat(absolutePath);
  if (info.size > maxBytes) {
    throw new Error(
      `File exceeds maximum allowed size of ${maxBytes} bytes (was ${info.size} bytes)`,
    );
  }

  return await readFile(absolutePath, { encoding });
}

async function collectFiles(
  repoRoot: string,
  inputPaths: string[],
): Promise<string[]> {
  const queue = [...inputPaths];
  const files: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const candidate = queue.pop();
    if (!candidate) {
      continue;
    }

    // Resolve once so ./foo and foo point to the same inode.
    const resolved = path.resolve(candidate);
    if (visited.has(resolved)) {
      continue;
    }
    visited.add(resolved);

    const stats = await lstat(resolved);
    if (stats.isSymbolicLink()) {
      // Skip symlinks to avoid directory escapes.
      continue;
    }

    if (stats.isDirectory()) {
      const relative = toRepoRelative(repoRoot, resolved);
      if (includesIgnoredDirectory(relative)) {
        continue;
      }

      // Walk directory contents iteratively to avoid deep recursion.
      const contents = await readdir(resolved, { withFileTypes: true });
      for (const entry of contents) {
        const next = path.join(resolved, entry.name);
        queue.push(next);
      }
      continue;
    }

    if (stats.isFile()) {
      const relative = toRepoRelative(repoRoot, resolved);
      if (includesIgnoredDirectory(relative)) {
        continue;
      }
      files.push(resolved);
    }
  }

  return Array.from(new Set(files)).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function sortDistinct(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

type LineYield = {
  line: string;
  lineEndingChars: number;
  lineBytes: number;
  lineEndingBytes: number;
};

async function* streamFileLines(
  filePath: string,
  encoding: SupportedEncoding,
): AsyncGenerator<LineYield> {
  const stream = createReadStream(filePath, { encoding });
  let buffer = "";

  // Yield newline-delimited slices while keeping partial chunks buffered.
  for await (const chunk of stream) {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      let line = buffer.slice(0, newlineIndex);
      let lineEndingChars = 1;
      let lineEndingBytes = Buffer.byteLength("\n", encoding);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
        lineEndingChars += 1;
        lineEndingBytes += Buffer.byteLength("\r", encoding);
      }

      buffer = buffer.slice(newlineIndex + 1);
      yield {
        line,
        lineEndingChars,
        lineBytes: Buffer.byteLength(line, encoding),
        lineEndingBytes,
      };
    }
  }

  if (buffer.length > 0) {
    yield {
      line: buffer,
      lineEndingChars: 0,
      lineBytes: Buffer.byteLength(buffer, encoding),
      lineEndingBytes: 0,
    };
  }
}

// Regex needs full content when it spans newlines or uses dotall semantics.
function shouldUseFullScan(pattern: string, flags: string | undefined): boolean {
  if (flags?.includes("s")) {
    return true;
  }

  if (pattern.includes("\n")) {
    return true;
  }

  if (pattern.includes("\\n") || pattern.includes("\\r")) {
    return true;
  }

  return false;
}

// Keep context bounded while biasing toward equal prefix/suffix around the match.
function buildContextSnippet(
  line: string,
  start: number,
  length: number,
): string {
  if (line.length <= DEFAULT_CONTEXT_CHARS) {
    return line;
  }

  const safeLength = Math.max(length, 1);
  const available = DEFAULT_CONTEXT_CHARS - safeLength;
  const half = Math.floor(available / 2);

  const prefixStart = Math.max(start - half, 0);
  const suffixEnd = Math.min(start + safeLength + half, line.length);

  const prefixEllipsis = prefixStart > 0 ? "…" : "";
  const suffixEllipsis = suffixEnd < line.length ? "…" : "";

  return (
    prefixEllipsis +
    line.slice(prefixStart, suffixEnd) +
    suffixEllipsis
  );
}

type LineIndex = {
  charOffsets: number[];
  byteOffsets: number[];
};

// Pre-compute line + byte offsets so we can translate regex indices quickly.
function buildLineIndex(
  content: string,
  encoding: SupportedEncoding,
): LineIndex {
  const charOffsets: number[] = [0];
  const byteOffsets: number[] = [0];

  let byteOffset = 0;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i] ?? "";
    byteOffset += Buffer.byteLength(char, encoding);
    if (char === "\n") {
      charOffsets.push(i + 1);
      byteOffsets.push(byteOffset);
    }
  }

  return { charOffsets, byteOffsets };
}

function findLineStartIndex(
  lineIndex: LineIndex,
  matchOffset: number,
): { line: number; startCharOffset: number; startByteOffset: number } {
  const { charOffsets, byteOffsets } = lineIndex;
  let low = 0;
  let high = charOffsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const offset = charOffsets[mid] ?? 0;

    if (offset <= matchOffset) {
      if (mid === charOffsets.length - 1 || charOffsets[mid + 1]! > matchOffset) {
        return {
          line: mid + 1,
          startCharOffset: offset,
          startByteOffset: byteOffsets[mid] ?? 0,
        };
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { line: 1, startCharOffset: 0, startByteOffset: 0 };
}

type FindMatchOptions = {
  filePath: string;
  repoRoot: string;
  pattern: string;
  flags: string;
  encoding: SupportedEncoding;
  limit: number;
  matches: GrepMatch[];
};

// Streaming mode scans line-by-line to avoid loading large files into memory.
async function findMatchesStreaming(options: FindMatchOptions): Promise<boolean> {
  const { filePath, repoRoot, pattern, flags, encoding, limit, matches } = options;
  const regex = new RegExp(pattern, flags);
  let lineNumber = 0;
  let charOffset = 0;
  let byteOffset = 0;

  for await (const {
    line,
    lineEndingChars,
    lineBytes,
    lineEndingBytes,
  } of streamFileLines(filePath, encoding)) {
    if (matches.length >= limit) {
      return true;
    }

    lineNumber += 1;
    regex.lastIndex = 0;
    let result: RegExpExecArray | null;

    while ((result = regex.exec(line)) !== null) {
      const matchText = result[0] ?? "";
      const column = result.index + 1;
      const byteOffsetForMatch =
        byteOffset + Buffer.byteLength(line.slice(0, result.index), encoding);
      const charOffsetForMatch = charOffset + result.index;

      matches.push({
        path: toRepoRelative(repoRoot, filePath),
        line: lineNumber,
        column,
        match: matchText,
        context: buildContextSnippet(line, result.index, matchText.length),
        offset: charOffsetForMatch,
        byteOffset: byteOffsetForMatch,
      });

      if (matches.length >= limit) {
        return true;
      }
    }

    charOffset += line.length + lineEndingChars;
    byteOffset += lineBytes + lineEndingBytes;
  }

  return false;
}

// Fallback to whole-file scan for multiline patterns so indexes stay accurate.
async function findMatchesFullScan(options: FindMatchOptions): Promise<boolean> {
  const { filePath, repoRoot, pattern, flags, encoding, limit, matches } = options;
  const content = await readFile(filePath, { encoding });
  const regex = new RegExp(pattern, flags);
  const lineIndex = buildLineIndex(content, encoding);

  let result: RegExpExecArray | null;
  while ((result = regex.exec(content)) !== null) {
    const matchText = result[0] ?? "";
    const matchOffset = result.index;
    const {
      line,
      startCharOffset,
      startByteOffset,
    } = findLineStartIndex(lineIndex, matchOffset);

    let lineEndIndex = content.indexOf("\n", matchOffset);
    if (lineEndIndex === -1) {
      lineEndIndex = content.length;
    }

    let lineText = content.slice(startCharOffset, lineEndIndex);
    if (lineText.endsWith("\r")) {
      lineText = lineText.slice(0, -1);
    }

    const precedingSlice = content.slice(startCharOffset, matchOffset);
    const byteOffsetForMatch =
      startByteOffset + Buffer.byteLength(precedingSlice, encoding);

    matches.push({
      path: toRepoRelative(repoRoot, filePath),
      line,
      column: matchOffset - startCharOffset + 1,
      match: matchText,
      context: buildContextSnippet(lineText, matchOffset - startCharOffset, matchText.length),
      offset: matchOffset,
      byteOffset: byteOffsetForMatch,
    });

    if (matches.length >= limit) {
      return true;
    }
  }

  return false;
}

export function createToolRegistry(context: ToolContext): ToolRegistry {
  const readTool = defineTool({
    name: "Read",
    description:
      "Read the contents of a repository file after validating the path.",
    schema: readInputSchema,
    executor: async ({ path: relativePath, encoding, maxBytes }) => {
      const absolutePath = resolveWithinRepo(context.repoRoot, relativePath);
      await assertIsReadableFile(absolutePath);
      const content = await readFileWithLimit(
        absolutePath,
        encoding,
        maxBytes ?? DEFAULT_MAX_READ_BYTES,
      );
      return {
        path: toRepoRelative(context.repoRoot, absolutePath),
        content,
      };
    },
  });

  const globTool = defineTool({
    name: "Glob",
    description:
      "List repository files matching a glob pattern without leaving the workspace.",
    schema: globInputSchema,
    executor: async ({ pattern, cwd, maxResults }) => {
      const baseDir = cwd
        ? resolveWithinRepo(context.repoRoot, cwd)
        : context.repoRoot;
      const baseStats = await lstat(baseDir);
      // Refuse symlink targets so globbing cannot alias outside repo root.
      if (baseStats.isSymbolicLink() || !baseStats.isDirectory()) {
        throw new Error(`cwd "${cwd ?? "."}" is not a directory`);
      }

      const globber = new Glob(pattern);
      const matches: string[] = [];
      let truncated = false;
      const limit = maxResults ?? DEFAULT_MAX_GLOB_RESULTS;

      for (const match of globber.scanSync({ cwd: baseDir })) {
        const candidate = path.resolve(baseDir, match);

        let absolute: string;
        try {
          // Reuse path validator so glob output cannot escape the repo root.
          absolute = resolveWithinRepo(context.repoRoot, candidate);
        } catch {
          continue;
        }

        const relative = toRepoRelative(context.repoRoot, absolute);
        if (includesIgnoredDirectory(relative)) {
          continue;
        }

        matches.push(relative);
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }

      return {
        matches: sortDistinct(matches),
        truncated,
      };
    },
  });

  const grepTool = defineTool({
    name: "Grep",
    description:
      "Search for a regular expression within repository files and return matching lines.",
    schema: grepInputSchema,
    executor: async ({
      pattern,
      flags,
      path: providedPath,
      maxResults,
      encoding,
    }) => {
      const requestedPaths = Array.isArray(providedPath)
        ? providedPath
        : providedPath
          ? [providedPath]
          : ["."];

      const resolvedPaths = requestedPaths.map((candidate) =>
        resolveWithinRepo(context.repoRoot, candidate),
      );

      const filesToSearch = await collectFiles(context.repoRoot, resolvedPaths);
      const limit = maxResults ?? DEFAULT_MAX_GREP_RESULTS;
      const matches: GrepMatch[] = [];
      let truncated = false;

      const baseFlags = flags ?? "";
      const flagSet = new Set(baseFlags.split("").filter(Boolean));
      flagSet.add("g");
      const finalFlags = Array.from(flagSet).join("");
      const useFullScan = shouldUseFullScan(pattern, baseFlags);
      // Zod already validated the encoding, but narrow for downstream helpers.
      const selectedEncoding = encoding as SupportedEncoding;

      for (const filePath of filesToSearch) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }

        const hitLimit = useFullScan
          ? await findMatchesFullScan({
              filePath,
              repoRoot: context.repoRoot,
              pattern,
              flags: finalFlags,
              encoding: selectedEncoding,
              limit,
              matches,
            })
          : await findMatchesStreaming({
              filePath,
              repoRoot: context.repoRoot,
              pattern,
              flags: finalFlags,
              encoding: selectedEncoding,
              limit,
              matches,
            });

        if (hitLimit) {
          truncated = true;
          break;
        }
      }

      return { matches, truncated };
    },
  });

  return {
    Read: readTool,
    Glob: globTool,
    Grep: grepTool,
  };
}

export const tools = createToolRegistry({ repoRoot: process.cwd() });
