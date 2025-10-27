export type FindingKind = "summary" | "file" | "line" | "range";

export type Finding = {
  path: string;
  kind: FindingKind;
  body: string;
  suggestion?: string;
  line?: number;
  start_line?: number;
  side?: "RIGHT" | "LEFT";
};

export type Findings = Finding[];
