import { type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export type SearchMode = "fast" | "deep";
export type SearchFreshness = "cached" | "indexed" | "live";
export type DefuddleMode = "off" | "direct" | "fallback" | "both";
export type CodexFailureKind =
  | "transport"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "budget"
  | "schema"
  | "empty_result"
  | "cancelled"
  | "missing_cli"
  | "local_config"
  | "unknown";

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

export interface CodexFailureDetails {
  kind: CodexFailureKind;
  message: string;
  recoverable: boolean;
}

export interface WebSearchProgressDetails {
  query: string;
  mode: SearchMode;
  freshness: SearchFreshness;
  /** Individual query strings issued, including batches within one web_search call. */
  searchCount: number;
  /** Number of web_search tool calls. Budgets apply to this count, not batched query strings. */
  searchCallCount: number;
  searchQueries: string[];
  pageActions?: string[];
  latestQuery?: string;
  statusText?: string;
  /** Milliseconds since the current Codex attempt started. */
  elapsedMs?: number;
  /** Maximum number of web_search tool calls allowed for this attempt. */
  queryBudget?: number;
  /** Number of Codex subprocess attempts, including retries. */
  attempt?: number;
  /** Number of JSONL events observed from Codex. */
  eventCount?: number;
  /** Internal wall-clock start marker, omitted from rendered details. */
  startedAt?: number;
  /** Internal wall-clock marker of the most recent JSONL event. */
  lastEventAt?: number;
  /** Internal IDs used to avoid counting both started and completed events for one call. */
  searchCallIds?: string[];
  statusEvents: string[];
}

export interface RetryProvenance {
  retriedFromFast: true;
  originalMode: "fast";
  originalFreshness: SearchFreshness;
  fallbackReason: string;
}

export interface DefuddleProvenance {
  directUrlQuery: boolean;
  reason: string;
  urls: string[];
}

export interface CodexWebSearchDetails extends WebSearchProgressDetails {
  sourceCount: number;
  summary: string;
  sources: WebSearchSource[];
  truncated: boolean;
  fullOutputPath?: string;
  retry?: RetryProvenance;
  defuddle?: DefuddleProvenance;
  failure?: CodexFailureDetails;
}

export interface WebSearchSettings {
  defaultMode: SearchMode;
  fastFreshness: SearchFreshness;
  deepFreshness: SearchFreshness;
  fastMaxSources: number;
  deepMaxSources: number;
  defuddleMode: DefuddleMode;
  fastTimeoutMs: number;
  deepTimeoutMs: number;
  defuddleTimeoutMs: number;
  fastQueryBudget: number;
  deepQueryBudget: number;
}

export interface RunCodexCommandOptions {
  args: string[];
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface RunCodexCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCodexCommand = (options: RunCodexCommandOptions) => Promise<RunCodexCommandResult>;

export interface RunDefuddleCommandOptions {
  url: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DefuddleParseResult {
  url: string;
  title: string;
  description: string;
  domain: string;
  author: string;
  published: string;
  wordCount: number;
  content: string;
}

export type RunDefuddleCommand = (
  options: RunDefuddleCommandOptions
) => Promise<DefuddleParseResult>;

export interface WebSearchTurnState {
  fastModeExhausted: boolean;
}

export interface ExecuteCodexWebSearchOptions {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  runner?: RunCodexCommand;
  defuddleRunner?: RunDefuddleCommand;
  settings?: WebSearchSettings;
  turnState?: WebSearchTurnState;
}
