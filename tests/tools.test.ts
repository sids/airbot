import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createToolRegistry } from "../src/tools";

describe("ToolRegistry", () => {
  const fixtureRoot = fileURLToPath(
    new URL("./fixtures/tooling", import.meta.url),
  );
  const registry = createToolRegistry({ repoRoot: fixtureRoot });
  const symlinkPath = path.join(fixtureRoot, "src", "symlink-index.ts");

  beforeAll(() => {
    if (!existsSync(symlinkPath)) {
      symlinkSync(path.join(fixtureRoot, "src", "index.ts"), symlinkPath);
    }
  });

  afterAll(() => {
    if (existsSync(symlinkPath)) {
      unlinkSync(symlinkPath);
    }
  });

  test("Read returns file contents within the repository", async () => {
    const result = await registry.Read.invoke({ path: "README.md" });
    expect(result.path).toBe("README.md");
    expect(result.content).toContain("Tooling Fixture");
  });

  test("Read accepts absolute paths within the repository root", async () => {
    const absolutePath = path.join(fixtureRoot, "README.md");
    const result = await registry.Read.invoke({ path: absolutePath });
    expect(result.path).toBe("README.md");
    expect(result.content.startsWith("# Tooling Fixture")).toBe(true);
  });

  test("Read rejects paths that traverse outside the repository root", async () => {
    await expect(
      registry.Read.invoke({ path: "../README.md" }),
    ).rejects.toThrow(/escapes the repository root/);
  });

  test("Read enforces maxBytes limits for oversized files", async () => {
    const relativePath = path.join("src", "data", "oversized.txt");
    const target = path.join(fixtureRoot, relativePath);
    writeFileSync(target, "x".repeat(1024));

    try {
      await expect(
        registry.Read.invoke({ path: relativePath, maxBytes: 128 }),
      ).rejects.toThrow(/maximum allowed size/i);
    } finally {
      if (existsSync(target)) {
        unlinkSync(target);
      }
    }
  });

  test("Read supports alternate encodings", async () => {
    const result = await registry.Read.invoke({
      path: "src/latin1.txt",
      encoding: "latin1",
    });
    expect(result.content).toBe("café\n");
  });

  test("Glob returns sorted matches relative to repo root", async () => {
    const result = await registry.Glob.invoke({ pattern: "src/**/*.ts" });
    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([
      "src/index.ts",
      "src/nested/keep.ts",
      "src/utils/logger.ts",
    ]);
    expect(result.matches.some((match) => match.includes("node_modules"))).toBe(
      false,
    );
  });

  test("Glob rejects patterns that escape the repo root", async () => {
    const result = await registry.Glob.invoke({ pattern: "../*.md" });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("Glob validates cwd paths", async () => {
    await expect(
      registry.Glob.invoke({ pattern: "*.md", cwd: "src/index.ts" }),
    ).rejects.toThrow(/is not a directory/);
  });

  test("Grep returns match context and line numbers", async () => {
    const result = await registry.Grep.invoke({
      pattern: "console\\.log",
      path: ["src"],
    });

    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(2);

    const [first, second] = result.matches;
    expect(first?.path).toBe("src/index.ts");
    expect(second?.path).toBe("src/utils/logger.ts");
    expect(first?.line).toBe(3);
    expect(first?.column).toBe(3);
    expect(first?.offset).toBeGreaterThanOrEqual(0);
    expect(first?.byteOffset).toBeGreaterThanOrEqual(0);
    expect(first?.context).toContain("console.log");
    expect(second?.offset).toBeGreaterThanOrEqual(0);
    expect(second?.byteOffset).toBeGreaterThanOrEqual(0);
  });

  test("Grep honors maxResults and sets truncated flag", async () => {
    const result = await registry.Grep.invoke({
      pattern: "console\\.log",
      path: "src",
      maxResults: 1,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test("Grep skips symlinked paths to avoid escapes", async () => {
    const result = await registry.Grep.invoke({
      pattern: "console\\.log",
      path: ".",
    });

    expect(result.matches.some((match) => match.path.includes("symlink"))).toBe(
      false,
    );
  });

  test("Grep supports multiline patterns via full scan fallback", async () => {
    const result = await registry.Grep.invoke({
      pattern: "first line\\nsecond line",
      path: "src/multiline.txt",
    });

    expect(result.truncated).toBe(false);
    expect(result.matches).toHaveLength(1);

    const match = result.matches[0];
    expect(match?.path).toBe("src/multiline.txt");
    expect(match?.line).toBe(1);
    expect(match?.column).toBe(1);
    expect(match?.match).toBe("first line\nsecond line");
    expect(match?.offset).toBe(0);
    expect(match?.byteOffset).toBe(0);
    expect(match?.context).toContain("first line");
  });

  test("Grep rejects invalid flag combinations", async () => {
    await expect(
      registry.Grep.invoke({ pattern: "console", flags: "z" }),
    ).rejects.toThrow(/flags must be valid/);
  });
});
