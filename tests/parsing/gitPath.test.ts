import { describe, expect, it } from "bun:test";

import { normalizeGitPath, splitDiffGitHeaderPaths } from "../../src/parsing/gitPath";

describe("git path helpers", () => {
  it("normalizes prefixed paths", () => {
    expect(normalizeGitPath("a/src/app.ts")).toBe("src/app.ts");
    expect(normalizeGitPath("b/src/app.ts")).toBe("src/app.ts");
  });

  it("normalizes quoted paths with spaces", () => {
    expect(normalizeGitPath('"a/docs/file with spaces.md"')).toBe("docs/file with spaces.md");
  });

  it("normalizes paths with trailing escaped spaces", () => {
    expect(normalizeGitPath("a/docs/foo\\ ")).toBe("docs/foo ");
  });

  it("normalizes escaped octal sequences", () => {
    expect(normalizeGitPath("a/dir\\040name/file.txt")).toBe("dir name/file.txt");
  });

  it("leaves /dev/null untouched", () => {
    expect(normalizeGitPath("/dev/null")).toBe("/dev/null");
  });

  it("splits diff headers with escaped spaces", () => {
    const header = "a/docs/file\\ with\\ spaces.md b/docs/file\\ with\\ spaces.md";
    const paths = splitDiffGitHeaderPaths(header);
    expect(paths).toEqual({
      rawOldPath: "a/docs/file\\ with\\ spaces.md",
      rawNewPath: "b/docs/file\\ with\\ spaces.md",
    });
  });

  it("splits diff headers with trailing escaped spaces", () => {
    const header = "a/docs/foo\\  b/docs/foo\\ ";
    const paths = splitDiffGitHeaderPaths(header);
    expect(paths).toEqual({
      rawOldPath: "a/docs/foo\\ ",
      rawNewPath: "b/docs/foo\\ ",
    });
  });

  it("splits diff headers with quoted paths", () => {
    const header = '"a/docs/file with spaces.md" "b/docs/file with spaces.md"';
    const paths = splitDiffGitHeaderPaths(header);
    expect(paths).toEqual({
      rawOldPath: '"a/docs/file with spaces.md"',
      rawNewPath: '"b/docs/file with spaces.md"',
    });
  });

  it("returns null for malformed headers", () => {
    expect(splitDiffGitHeaderPaths("invalid header")).toBeNull();
  });
});
