import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { discoverLocalPluginConfigs } from "../src/plugins.js";

async function createPluginDir(baseDir: string, relativeDir: string): Promise<string> {
  const pluginRoot = path.join(baseDir, relativeDir);
  await mkdir(pluginRoot, { recursive: true });
  return pluginRoot;
}

async function createPlugin(
  baseDir: string,
  relativeDir: string,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const pluginRoot = await createPluginDir(baseDir, relativeDir);
  const manifestDir = path.join(pluginRoot, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "plugin.json");
  const pluginName = relativeDir.split(/[\\/]+/).filter(Boolean).pop() ?? "plugin";
  const contents =
    Object.keys(manifest).length > 0
      ? manifest
      : {
          schema_version: "1.0",
          name: pluginName,
          title: pluginName,
          version: "0.0.1",
        };
  await writeFile(manifestPath, JSON.stringify(contents, null, 2), "utf8");
  return pluginRoot;
}

describe("discoverLocalPluginConfigs", () => {
  test("collects plugins from home plugin directories", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "airbot-home-"));
    const homePluginsBase = path.join(homeRoot, ".claude", "plugins");
    const originalEnvPluginHome = process.env.CLAUDE_PLUGINS_HOME;
    process.env.CLAUDE_PLUGINS_HOME = homePluginsBase;

    try {
      const homePlugin = await createPlugin(homeRoot, path.join(".claude", "plugins", "security-reviewer"));

      const result = await discoverLocalPluginConfigs("/tmp/irrelevant");

      const discoveredPaths = result.configs.map((config) => config.path).sort();

      expect(discoveredPaths).toEqual(
        [homePlugin].map((pluginPath) => path.resolve(pluginPath)).sort(),
      );
      expect(result.warnings).toHaveLength(0);
    } finally {
      process.env.CLAUDE_PLUGINS_HOME = originalEnvPluginHome;
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("ignores directories missing plugin manifests", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "airbot-home-"));
    const homePluginsBase = path.join(homeRoot, ".claude", "plugins");
    const originalEnvPluginHome = process.env.CLAUDE_PLUGINS_HOME;
    process.env.CLAUDE_PLUGINS_HOME = homePluginsBase;

    try {
      const goodPlugin = await createPlugin(
        homeRoot,
        path.join(".claude", "plugins", "good-reviewer"),
      );
      await createPluginDir(homeRoot, path.join(".claude", "plugins", "missing-manifest"));

      const result = await discoverLocalPluginConfigs("/tmp/irrelevant");

      expect(result.configs).toHaveLength(1);
      expect(result.configs[0]?.path).toBe(path.resolve(goodPlugin));
      expect(result.warnings).toHaveLength(0);
    } finally {
      process.env.CLAUDE_PLUGINS_HOME = originalEnvPluginHome;
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("returns empty results when no plugins are present", async () => {
    try {
      const result = await discoverLocalPluginConfigs("/tmp/irrelevant");
      expect(result.configs).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    } finally {
      // nothing to cleanup
    }
  });
});
