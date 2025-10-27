import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { parseUnifiedDiff } from "../../src/parsing/unifiedDiff";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("parseUnifiedDiff", () => {
  it("parses standard hunks with line metadata", () => {
    const diff = fixture("basic.diff");
    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(1);

    const file = files[0];
    expect(file.oldPath).toBe("src/app.ts");
    expect(file.newPath).toBe("src/app.ts");
    expect(file.rawOldPath).toBe("a/src/app.ts");
    expect(file.rawNewPath).toBe("b/src/app.ts");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);

    const [hunk] = file.hunks;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toHaveLength(6);

    const [context, removeA, removeB, addA, addB, addC] = hunk.lines;

    expect(context).toMatchObject({
      type: "context",
      content: 'import { hello } from "./hello";',
      oldLineNumber: 1,
      newLineNumber: 1,
    });

    expect(removeA.type).toBe("remove");
    expect(removeA.content).toBe("const message = hello();");
    expect(removeA.oldLineNumber).toBe(2);
    expect(removeA.newLineNumber).toBeUndefined();

    expect(removeB.type).toBe("remove");
    expect(removeB.content).toBe("console.log(message);");
    expect(removeB.oldLineNumber).toBe(3);
    expect(removeB.newLineNumber).toBeUndefined();

    expect(addA).toMatchObject({
      type: "add",
      content: 'const message = hello("world");',
      newLineNumber: 2,
    });

    expect(addB).toMatchObject({
      type: "add",
      content: "console.log(message);",
      newLineNumber: 3,
    });

    expect(addC.noNewlineAtEndOfFile).toBe(true);
  });

  it("captures rename metadata", () => {
    const diff = fixture("rename.diff");
    const [file] = parseUnifiedDiff(diff);

    expect(file.rename).toMatchObject({ from: "src/old.ts", to: "src/new.ts" });
    expect(file.rename?.rawFrom).toBe("src/old.ts");
    expect(file.rename?.rawTo).toBe("src/new.ts");
    expect(file.oldPath).toBe("src/old.ts");
    expect(file.newPath).toBe("src/new.ts");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);
  });

  it("preserves trailing spaces in paths", () => {
    const diff = fixture("trailing-space.diff");
    const [file] = parseUnifiedDiff(diff);

    expect(file.rawOldPath).toBe("a/docs/foo\\ ");
    expect(file.rawNewPath).toBe("b/docs/foo\\ ");
    expect(file.oldPath).toBe("docs/foo ");
    expect(file.newPath).toBe("docs/foo ");
    expect(file.rename).toMatchObject({
      from: "docs/foo ",
      to: "docs/foo ",
      rawFrom: "docs/foo\\ ",
      rawTo: "docs/foo\\ ",
    });
    expect(file.hunks).toHaveLength(1);
  });

  it("marks binary patches without hunks", () => {
    const diff = fixture("binary.diff");
    const [file] = parseUnifiedDiff(diff);

    expect(file.isBinary).toBe(true);
    expect(file.hunks).toHaveLength(0);
    expect(file.isNewFile).toBe(true);
    expect(file.newPath).toBe("assets/logo.png");
    expect(file.rawOldPath).toBe("a/assets/logo.png");
    expect(file.rawNewPath).toBe("b/assets/logo.png");
  });

  it("collects mode changes", () => {
    const diff = fixture("mode-change.diff");
    const [file] = parseUnifiedDiff(diff);

    expect(file.modeChange).toEqual({ oldMode: "100644", newMode: "100755" });
    expect(file.isNewFile).toBe(false);
    expect(file.isDeletedFile).toBe(false);
    expect(file.hunks[0].lines[0]).toMatchObject({
      type: "remove",
      oldLineNumber: 1,
    });
    expect(file.hunks[0].lines[2]).toMatchObject({
      type: "add",
      newLineNumber: 1,
    });
  });

  it("handles file paths containing spaces", () => {
    const diff = fixture("space-in-path.diff");
    const [file] = parseUnifiedDiff(diff);

    expect(file.oldPath).toBe("docs/file with spaces.md");
    expect(file.newPath).toBe("docs/file with spaces.md");
    expect(file.rawOldPath).toBe("a/docs/file\\ with\\ spaces.md");
    expect(file.rawNewPath).toBe("b/docs/file\\ with\\ spaces.md");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.lines).toHaveLength(4);

    expect(hunk.lines[0]).toMatchObject({
      type: "context",
      content: 'import { helper } from "../helper";',
      oldLineNumber: 1,
      newLineNumber: 1,
    });

    expect(hunk.lines[1]).toMatchObject({
      type: "remove",
      content: 'console.log("old value");',
      oldLineNumber: 2,
    });

    expect(hunk.lines[2]).toMatchObject({
      type: "add",
      content: 'console.log("old value");',
      newLineNumber: 2,
    });

    expect(hunk.lines[3]).toMatchObject({
      type: "add",
      content: 'console.log("new value");',
      newLineNumber: 3,
    });
  });
});
