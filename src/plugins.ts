import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

export type PluginDiscoveryResult = {
  configs: SdkPluginConfig[];
  warnings: string[];
};

export async function discoverLocalPluginConfigs(
  repoRoot: string,
): Promise<PluginDiscoveryResult> {
  const configs: SdkPluginConfig[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const repoPluginsDir = path.resolve(repoRoot, "plugins");
  await collectPluginsUnder(repoPluginsDir, configs, seen, warnings);

  const envHomePlugins = process.env.CLAUDE_PLUGINS_HOME;
  if (envHomePlugins && envHomePlugins.trim().length > 0) {
    await collectPluginsUnder(path.resolve(envHomePlugins), configs, seen, warnings);
  } else {
    const homeDir = homedir();
    if (homeDir) {
      await collectPluginsUnder(
        path.resolve(homeDir, ".claude", "plugins"),
        configs,
        seen,
        warnings,
      );
    }
  }

  return { configs, warnings };
}

async function addPluginConfig(
  pluginRoot: string,
  configs: SdkPluginConfig[],
  seen: Set<string>,
  warnings: string[],
): Promise<void> {
  const resolvedRoot = path.resolve(pluginRoot);

  if (seen.has(resolvedRoot)) {
    return;
  }

  const manifestPath = path.join(resolvedRoot, ".claude-plugin", "plugin.json");
  let manifestInfo: import("node:fs").Stats;

  try {
    manifestInfo = await stat(manifestPath);
  } catch (error) {
    if (isSystemError(error, "ENOENT")) {
      return;
    }
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    warnings.push(
      `Failed to read plugin manifest at ${manifestPath}: ${message}`,
    );
    return;
  }

  if (!manifestInfo.isFile()) {
    return;
  }

  seen.add(resolvedRoot);
  configs.push({
    type: "local",
    path: resolvedRoot,
  });
}

async function collectPluginsUnder(
  baseDir: string,
  configs: SdkPluginConfig[],
  seen: Set<string>,
  warnings: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if (isSystemError(error, "ENOENT")) {
      return;
    }
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    warnings.push(`Unable to read plugin directory ${baseDir}: ${message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    const pluginRoot = path.join(baseDir, entry.name);
    await addPluginConfig(pluginRoot, configs, seen, warnings);
  }
}

function isSystemError(
  value: unknown,
  code: string,
): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    typeof (value as NodeJS.ErrnoException).code === "string" &&
    (value as NodeJS.ErrnoException).code === code
  );
}
