import type { AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";

export type SearchMode = "fast" | "deep";
export type SearchFreshness = "cached" | "live";

export interface WebSearchInput {
  query: string;
  maxSources?: number;
  mode?: SearchMode;
  freshness?: SearchFreshness;
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface CodexWebSearchOutput {
  summary: string;
  sources: WebSearchSource[];
}

export interface WebSearchProgressDetails {
  query: string;
  mode: SearchMode;
  freshness: SearchFreshness;
  searchCount: number;
  searchQueries: string[];
  latestQuery?: string;
}

export interface CodexWebSearchDetails extends WebSearchProgressDetails {
  sourceCount: number;
  summary: string;
  sources: WebSearchSource[];
  truncated: boolean;
  fullOutputPath?: string;
}

export interface WebSearchSettings {
  defaultMode: SearchMode;
  fastFreshness: SearchFreshness;
  deepFreshness: SearchFreshness;
}

export interface RunCodexCommandOptions {
  args: string[];
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}

export interface RunCodexCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCodexCommand = (options: RunCodexCommandOptions) => Promise<RunCodexCommandResult>;

export interface WebSearchTurnState {
  fastModeExhausted: boolean;
}

export interface ExecuteCodexWebSearchOptions {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  runner?: RunCodexCommand;
  settings?: WebSearchSettings;
  turnState?: WebSearchTurnState;
}
