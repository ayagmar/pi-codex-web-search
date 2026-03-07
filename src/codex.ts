import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEEP_SEARCH_QUERY_BUDGET,
  DEEP_SEARCH_TIMEOUT_MS,
  DEFAULT_MAX_SOURCES,
  FAST_SEARCH_QUERY_BUDGET,
  FAST_SEARCH_TIMEOUT_MS,
  MAX_ALLOWED_SOURCES,
} from "./constants.js";
import type {
  CodexWebSearchDetails,
  CodexWebSearchOutput,
  ExecuteCodexWebSearchOptions,
  RunCodexCommandOptions,
  RunCodexCommandResult,
  SearchFreshness,
  SearchMode,
  WebSearchInput,
  WebSearchProgressDetails,
  WebSearchSource,
} from "./types.js";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "./settings.js";

const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["title", "url", "snippet"],
      },
    },
  },
  required: ["summary", "sources"],
} as const;

export function normalizeMaxSources(maxSources?: number): number {
  if (maxSources === undefined) return DEFAULT_MAX_SOURCES;
  const rounded = Math.trunc(maxSources);
  return Math.min(Math.max(rounded, 1), MAX_ALLOWED_SOURCES);
}

export function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error("web_search requires a non-empty query.");
  }
  return normalized;
}

export function resolveSearchMode(
  input: WebSearchInput,
  defaultMode = DEFAULT_WEB_SEARCH_SETTINGS.defaultMode
): SearchMode {
  return input.mode ?? defaultMode;
}

export function resolveSearchFreshness(
  mode: SearchMode,
  fastFreshness = DEFAULT_WEB_SEARCH_SETTINGS.fastFreshness,
  deepFreshness = DEFAULT_WEB_SEARCH_SETTINGS.deepFreshness
): SearchFreshness {
  return mode === "deep" ? deepFreshness : fastFreshness;
}

export function buildCodexPrompt(input: WebSearchInput): string {
  const maxSources = normalizeMaxSources(input.maxSources);
  const query = normalizeQuery(input.query);
  const mode = resolveSearchMode(input);

  const modeInstructions =
    mode === "deep"
      ? [
          "This is a deeper research task.",
          "Cross-check sources, refine queries when needed, and compare results before answering.",
        ]
      : [
          "This is a quick lookup.",
          "Use as few web searches as possible and stop once you have enough information to answer.",
          "Do not do exhaustive query reformulations for simple factual questions.",
        ];

  return [
    "You are performing web research for another coding agent.",
    "Search the public web and answer the user's query using current online sources.",
    ...modeInstructions,
    "Return only a JSON object that matches the provided schema.",
    "Do not wrap the JSON in markdown fences or add any extra commentary.",
    `Keep the summary concise and useful for another agent. Limit the source list to at most ${maxSources} items.`,
    "Prefer primary or official sources when available.",
    "Each source snippet should be short and directly relevant.",
    "",
    `User query: ${query}`,
  ].join("\n");
}

export function buildCodexExecArgs(
  paths: { schemaPath: string; outputPath: string },
  freshness: SearchFreshness
): string[] {
  return [
    "exec",
    "--json",
    "-c",
    `web_search="${freshness}"`,
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--ephemeral",
    "--output-schema",
    paths.schemaPath,
    "--output-last-message",
    paths.outputPath,
    "-",
  ];
}

export function parseCodexWebSearchOutput(raw: string, maxSources: number): CodexWebSearchOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex returned invalid JSON: ${message}`);
  }

  if (!isCodexWebSearchOutput(parsed)) {
    throw new Error("Codex returned JSON that does not match the expected web search schema.");
  }

  const summary = parsed.summary.trim();
  const sources = parsed.sources.map(normalizeSource).filter(hasUsableSource).slice(0, maxSources);

  if (!summary) {
    throw new Error("Codex returned an empty summary.");
  }

  return { summary, sources };
}

export function formatWebSearchResult(result: CodexWebSearchOutput): string {
  const lines = [result.summary.trim()];

  if (result.sources.length === 0) {
    lines.push("", "Sources: none provided by Codex.");
    return lines.join("\n");
  }

  lines.push("", "Sources:");
  for (const [index, source] of result.sources.entries()) {
    lines.push(`${index + 1}. ${source.title}`);
    lines.push(`   ${source.url}`);
    if (source.snippet) {
      lines.push(`   ${source.snippet}`);
    }
  }

  return lines.join("\n");
}

export async function executeCodexWebSearch(
  input: WebSearchInput,
  options: ExecuteCodexWebSearchOptions
): Promise<{
  content: { type: "text"; text: string }[];
  details: CodexWebSearchDetails;
}> {
  const runner = options.runner ?? runCodexCommand;
  const settings = options.settings ?? DEFAULT_WEB_SEARCH_SETTINGS;
  const query = normalizeQuery(input.query);
  const mode = resolveSearchMode(input, settings.defaultMode);
  const freshness = resolveSearchFreshness(mode, settings.fastFreshness, settings.deepFreshness);
  const maxSources = normalizeMaxSources(input.maxSources);
  const policy = getSearchPolicy(mode);
  const progress = createSearchProgress(query, mode, freshness);
  const tempDir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-"));
  const schemaPath = join(tempDir, "schema.json");
  const outputPath = join(tempDir, "result.json");

  await writeFile(schemaPath, `${JSON.stringify(SEARCH_OUTPUT_SCHEMA, null, 2)}\n`, "utf-8");

  emitProgressUpdate(options, progress, `Running ${mode} Codex web search for: ${query}`);

  const abortController = new AbortController();
  const signal = mergeAbortSignals(options.signal, abortController);

  try {
    const runnerOptions: RunCodexCommandOptions = {
      args: buildCodexExecArgs({ schemaPath, outputPath }, freshness),
      cwd: options.cwd,
      stdin: buildCodexPrompt({ query, maxSources, mode }),
      timeoutMs: policy.timeoutMs,
      signal,
      onStdoutLine: (line) => {
        const updates = collectSearchQueries(progress, line);
        for (const addedQuery of updates) {
          emitProgressUpdate(options, progress, `Search #${progress.searchCount}: ${addedQuery}`);
        }

        if (progress.searchCount > policy.queryBudget && !abortController.signal.aborted) {
          abortController.abort(
            new Error(
              `Codex exceeded the ${mode} search budget (${policy.queryBudget} queries). Ask for a deep search only when you want broader research.`
            )
          );
        }
      },
    };

    const runResult = await runner(runnerOptions);

    if (runResult.code !== 0) {
      throw new Error(buildCodexFailureMessage(runResult));
    }

    const rawOutput = await readFile(outputPath, "utf-8");
    if (!rawOutput.trim()) {
      throw new Error("Codex did not write a final response to the output file.");
    }

    const parsed = parseCodexWebSearchOutput(rawOutput, maxSources);
    const formattedResult = formatWebSearchResult(parsed);
    const renderedResult = await renderToolResult(formattedResult);

    const details: CodexWebSearchDetails = {
      query,
      mode,
      freshness,
      searchCount: progress.searchCount,
      searchQueries: [...progress.searchQueries],
      sourceCount: parsed.sources.length,
      summary: parsed.summary,
      sources: parsed.sources,
      truncated: renderedResult.truncated,
    };

    if (progress.latestQuery) {
      details.latestQuery = progress.latestQuery;
    }

    if (renderedResult.fullOutputPath) {
      details.fullOutputPath = renderedResult.fullOutputPath;
    }

    return {
      content: [{ type: "text", text: renderedResult.text }],
      details,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runCodexCommand(
  options: RunCodexCommandOptions
): Promise<RunCodexCommandResult> {
  return new Promise<RunCodexCommandResult>((resolve, reject) => {
    const child = spawn("codex", options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      const reason: unknown = options.signal?.reason;
      const error =
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "Codex web search was cancelled.");
      finish(() => reject(error));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => {
          reject(
            new Error(`Codex web search timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)
          );
        });
      }, timeoutMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      const message =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "Could not find `codex` in PATH. Install Codex CLI and run `codex login` first."
          : `Failed to start Codex CLI: ${error.message}`;
      finish(() => reject(new Error(message)));
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutLineBuffer += chunk;

      let newlineIndex = stdoutLineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutLineBuffer.slice(0, newlineIndex);
        options.onStdoutLine?.(line);
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutLineBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (stdoutLineBuffer) {
        options.onStdoutLine?.(stdoutLineBuffer);
      }
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function buildCodexFailureMessage(result: RunCodexCommandResult): string {
  const stderr = result.stderr.trim();
  const stdoutTail = tailLines(result.stdout, 12);
  const details = [stderr, stdoutTail].filter(Boolean).join("\n\n");
  const suffix = details ? `\n\n${details}` : "";
  return `codex exec failed with exit code ${result.code}.${suffix}`;
}

function tailLines(text: string, count: number): string {
  const lines = text
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines.slice(-count).join("\n");
}

function getSearchPolicy(mode: SearchMode): { timeoutMs: number; queryBudget: number } {
  if (mode === "deep") {
    return {
      timeoutMs: DEEP_SEARCH_TIMEOUT_MS,
      queryBudget: DEEP_SEARCH_QUERY_BUDGET,
    };
  }

  return {
    timeoutMs: FAST_SEARCH_TIMEOUT_MS,
    queryBudget: FAST_SEARCH_QUERY_BUDGET,
  };
}

function createSearchProgress(
  query: string,
  mode: SearchMode,
  freshness: SearchFreshness
): WebSearchProgressDetails {
  return {
    query,
    mode,
    freshness,
    searchCount: 0,
    searchQueries: [],
  };
}

function emitProgressUpdate(
  options: ExecuteCodexWebSearchOptions,
  progress: WebSearchProgressDetails,
  text: string
): void {
  const details: WebSearchProgressDetails = {
    query: progress.query,
    mode: progress.mode,
    freshness: progress.freshness,
    searchCount: progress.searchCount,
    searchQueries: [...progress.searchQueries],
  };

  if (progress.latestQuery) {
    details.latestQuery = progress.latestQuery;
  }

  options.onUpdate?.({
    content: [{ type: "text", text }],
    details,
  });
}

function mergeAbortSignals(
  externalSignal: AbortSignal | undefined,
  localController: AbortController
): AbortSignal {
  if (!externalSignal) {
    return localController.signal;
  }

  if (externalSignal.aborted) {
    localController.abort(externalSignal.reason);
    return localController.signal;
  }

  externalSignal.addEventListener("abort", () => localController.abort(externalSignal.reason), {
    once: true,
  });
  return localController.signal;
}

function collectSearchQueries(progress: WebSearchProgressDetails, line: string): string[] {
  const event = parseJsonObject(line);
  if (!event) return [];

  const queries = extractCompletedSearchQueries(event);
  if (queries.length === 0) return [];

  const addedQueries: string[] = [];
  for (const query of queries) {
    const normalized = query.trim();
    if (!normalized || progress.searchQueries.includes(normalized)) continue;
    progress.searchQueries.push(normalized);
    progress.searchCount = progress.searchQueries.length;
    progress.latestQuery = normalized;
    addedQueries.push(normalized);
  }

  return addedQueries;
}

async function renderToolResult(text: string): Promise<{
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, truncated: false };
  }

  const fullOutputDir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-result-"));
  const fullOutputPath = join(fullOutputDir, "output.txt");
  await writeFile(fullOutputPath, text, "utf-8");

  const notice = [
    "",
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`,
  ].join("\n");

  return {
    text: `${truncation.content}${notice}`,
    truncated: true,
    fullOutputPath,
  };
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function extractCompletedSearchQueries(event: Record<string, unknown>): string[] {
  if (event.type !== "item.completed") return [];

  const item = event.item;
  if (!item || typeof item !== "object") return [];

  const typedItem = item as { type?: unknown; action?: unknown; query?: unknown };
  if (typedItem.type !== "web_search") return [];

  const action = typedItem.action;
  if (!action || typeof action !== "object") return [];

  const typedAction = action as { type?: unknown; query?: unknown; queries?: unknown };
  if (typedAction.type !== "search") return [];

  if (Array.isArray(typedAction.queries)) {
    return typedAction.queries.filter((query): query is string => typeof query === "string");
  }

  if (typeof typedAction.query === "string") {
    return [typedAction.query];
  }

  if (typeof typedItem.query === "string") {
    return [typedItem.query];
  }

  return [];
}

function isCodexWebSearchOutput(value: unknown): value is CodexWebSearchOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { summary?: unknown; sources?: unknown };
  return (
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.sources) &&
    candidate.sources.every(isWebSearchSource)
  );
}

function isWebSearchSource(value: unknown): value is WebSearchSource {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { title?: unknown; url?: unknown; snippet?: unknown };
  return (
    typeof candidate.title === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.snippet === "string"
  );
}

function hasUsableSource(source: WebSearchSource): boolean {
  return source.title.length > 0 && source.url.length > 0;
}

function normalizeSource(source: WebSearchSource): WebSearchSource {
  return {
    title: source.title.trim(),
    url: source.url.trim(),
    snippet: source.snippet.trim(),
  };
}
