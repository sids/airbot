// Git uses C-style escapes to represent paths in diff headers. Mapping covers
// the handful of sequences Git emits; fall back to octal handling when needed.
const GIT_ESCAPE_SEQUENCES: Record<string, string> = {
  '"': '"',
  "'": "'",
  " ": " ",
  "t": "\t",
  "n": "\n",
  "r": "\r",
  "\\": "\\",
};

function stripEnclosingQuotes(value: string): string {
  if (value.length >= 2) {
    const startsWithDouble = value.startsWith('"') && value.endsWith('"');
    const startsWithSingle = value.startsWith("'") && value.endsWith("'");
    if (startsWithDouble || startsWithSingle) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Convert Git's escaped path segments back into raw UTF-8 strings.
export function unescapeGitPath(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      const mapped = GIT_ESCAPE_SEQUENCES[next];
      if (mapped !== undefined) {
        result += mapped;
        i += 1;
        continue;
      }

      if (/[0-7]/.test(next)) {
        // Git encodes arbitrary bytes using up to three octal digits. Consume as
        // many digits as available (max three) before converting back.
        let octal = next;
        let offset = 1;
        while (offset < 3 && i + 1 + offset < value.length) {
          const candidate = value[i + 1 + offset];
          if (!/[0-7]/.test(candidate)) {
            break;
          }
          octal += candidate;
          offset += 1;
        }
        result += String.fromCharCode(parseInt(octal, 8));
        i += offset;
        continue;
      }
    }

    result += char;
  }

  return result;
}

export function normalizeGitPath(rawPath: string): string {
  const withoutQuotes = stripEnclosingQuotes(rawPath);
  const unescaped = unescapeGitPath(withoutQuotes);
  if (unescaped === "/dev/null") {
    return unescaped;
  }

  if (unescaped.startsWith("a/")) {
    return unescaped.slice(2);
  }

  if (unescaped.startsWith("b/")) {
    return unescaped.slice(2);
  }

  return unescaped;
}

// Split the `diff --git` suffix into the `a/...` and `b/...` tokens. We emulate
// Git's parsing rules: spaces outside of quotes separate tokens, but quoted
// strings and backslash escapes are preserved verbatim.
function tokenizeDiffGitPaths(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
      continue;
    }

    if (char === " " && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }

      while (i + 1 < input.length && input[i + 1] === " ") {
        i += 1;
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function splitDiffGitHeaderPaths(headerRemainder: string): {
  rawOldPath: string;
  rawNewPath: string;
} | null {
  if (!headerRemainder) {
    return null;
  }

  const tokens = tokenizeDiffGitPaths(headerRemainder);
  if (tokens.length !== 2) {
    return null;
  }

  const [rawOldPath, rawNewPath] = tokens;
  const unquotedOld = stripEnclosingQuotes(rawOldPath);
  const unquotedNew = stripEnclosingQuotes(rawNewPath);

  const isValidOld = unquotedOld === "/dev/null" || unquotedOld.startsWith("a/");
  const isValidNew = unquotedNew === "/dev/null" || unquotedNew.startsWith("b/");

  if (!isValidOld || !isValidNew) {
    return null;
  }

  return { rawOldPath, rawNewPath };
}
