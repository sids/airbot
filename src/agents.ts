import type { ToolRegistry } from "./tools";

export type AgentIdentifier =
  | "style-reviewer"
  | "security-reviewer"
  | "test-reviewer";

export type AgentDefinition = {
  description: string;
  prompt: string;
  tools: (keyof ToolRegistry)[];
  model: string;
};

export type AgentMap = Record<AgentIdentifier, AgentDefinition>;

export const agents: AgentMap = {
  "style-reviewer": {
    description: "Checks TS style & idioms",
    prompt: "TODO: provide style reviewer prompt",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet"
  },
  "security-reviewer": {
    description: "Scans for security risks in Node/TS",
    prompt: "TODO: provide security reviewer prompt",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet"
  },
  "test-reviewer": {
    description: "Assesses tests touched by PR",
    prompt: "TODO: provide test reviewer prompt",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet"
  }
};
