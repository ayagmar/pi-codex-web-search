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
import { fileURLToPath } from "node:url";
import { MAX_ALLOWED_SOURCES } from "./constants.js";
import {
  buildDefuddleSnippet,
  buildDefuddleSummary,
  extractUrlsFromText,
  getDirectUrlQuery,
  runDefuddleCommand,
} from "./defuddle.js";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "./settings.js";
import type {
  CodexWebSearchDetails,
  CodexWebSearchOutput,
  DefuddleParseResult,
  ExecuteCodexWebSearchOptions,
  RetryProvenance,
  RunCodexCommand,
  RunCodexCommandOptions,
  RunCodexCommandResult,
  SearchFreshness,
  SearchMode,
  WebSearchInput,
  WebSearchProgressDetails,
  WebSearchSettings,
  WebSearchSource,
  WebSearchTurnState,
} from "./types.js";

const SEARCH_OUTPUT_SCHEMA_PATH = fileURLToPath(
  new URL("./search-output-schema.json", import.meta.url)
);

const LIVE_FRESHNESS_QUERY_PATTERN =
  /\b(today|latest|current|now|weather|price|breaking|urgent)\b/iu;

interface ResolvedWebSearchInput {
  query: string;
  maxSources: number;
  mode: SearchMode;
  freshness: SearchFreshness;
}

export function normalizeMaxSources(
  maxSources?: number,
  fallback = DEFAULT_WEB_SEARCH_SETTINGS.fastMaxSources
): number {
  if (maxSources === undefined || Number.isNaN(maxSources)) {
    return fallback;
  }

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

export function isLiveFreshnessQuery(query: string): boolean {
  return LIVE_FRESHNESS_QUERY_PATTERN.test(normalizeQuery(query));
}

export function resolveSearchFreshness(
  input: WebSearchInput,
  mode: SearchMode,
  fastFreshness = DEFAULT_WEB_SEARCH_SETTINGS.fastFreshness,
  deepFreshness = DEFAULT_WEB_SEARCH_SETTINGS.deepFreshness
): SearchFreshness {
  if (input.freshness) {
    return input.freshness;
  }

  if (mode === "fast" && isLiveFreshnessQuery(input.query)) {
    return "live";
  }

  return mode === "deep" ? deepFreshness : fastFreshness;
}

function resolveDefaultMaxSources(mode: SearchMode, settings: WebSearchSettings): number {
  return mode === "deep" ? settings.deepMaxSources : settings.fastMaxSources;
}

function resolveWebSearchInput(
  input: WebSearchInput,
  settings = DEFAULT_WEB_SEARCH_SETTINGS
): ResolvedWebSearchInput {
  const query = normalizeQuery(input.query);
  const mode = resolveSearchMode(input, settings.defaultMode);
  return {
    query,
    maxSources: normalizeMaxSources(input.maxSources, resolveDefaultMaxSources(mode, settings)),
    mode,
    freshness: resolveSearchFreshness(
      { ...input, query },
      mode,
      settings.fastFreshness,
      settings.deepFreshness
    ),
  };
}

function shouldUseDefuddleForDirectUrl(settings: WebSearchSettings): boolean {
  return settings.defuddleMode === "direct" || settings.defuddleMode === "both";
}

function shouldUseDefuddleFallback(
  settings: WebSearchSettings,
  query: string,
  directUrlQuery: boolean
): boolean {
  if (directUrlQuery) {
    return shouldUseDefuddleForDirectUrl(settings);
  }

  if (settings.defuddleMode !== "fallback" && settings.defuddleMode !== "both") {
    return false;
  }

  return getDefuddleFallbackUrls(query).length > 0;
}

function getDefuddleFallbackUrls(query: string): string[] {
  const urls = extractUrlsFromText(query);
  if (urls.length !== 1) {
    return [];
  }

  return hasDefuddleExtractionIntent(query) ? urls : [];
}

function hasDefuddleExtractionIntent(query: string): boolean {
  return /\b(defuddle|extract|clean|strip|markdown|summari[sz]e)\b/iu.test(query);
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
    `web_search=\"${freshness}\"`,
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
  const resolvedInput = resolveWebSearchInput(input, settings);
  const allowFastAutoEscalation = canAutoEscalateDefaultFastSearch(input, resolvedInput);

  const directUrl = shouldUseDefuddleForDirectUrl(settings)
    ? getDirectUrlQuery(resolvedInput.query)
    : undefined;

  if (directUrl) {
    const directResult = await maybeRunDefuddleSearch(resolvedInput, options, settings, {
      directUrlQuery: true,
      reason: `Direct URL query: ${directUrl}`,
      urls: [directUrl],
    });

    if (directResult) {
      return directResult;
    }
  }

  if (resolvedInput.mode === "fast" && options.turnState?.fastModeExhausted) {
    throw new Error(
      "Fast search already failed earlier in this turn. Do not retry fast mode in the same turn; rerun with mode=deep or freshness=live if you need broader or fresher results."
    );
  }

  try {
    return await runResolvedCodexWebSearch(
      resolvedInput,
      options,
      settings,
      runner,
      undefined,
      allowFastAutoEscalation
    );
  } catch (error) {
    if (shouldRetryWithDeepLiveSearch(input, resolvedInput, error)) {
      const retryReason = errorMessage(error);

      try {
        return await runResolvedCodexWebSearch(
          {
            ...resolvedInput,
            mode: "deep",
            freshness: "live",
          },
          options,
          settings,
          runner,
          {
            retriedFromFast: true,
            originalMode: "fast",
            originalFreshness: resolvedInput.freshness,
            fallbackReason: retryReason,
          }
        );
      } catch (retryFailure) {
        const defuddleRetryFallback = await maybeRunDefuddleSearch(
          resolvedInput,
          options,
          settings,
          {
            directUrlQuery: false,
            reason: errorMessage(retryFailure),
          }
        );

        if (defuddleRetryFallback) {
          return defuddleRetryFallback;
        }

        throw retryFailure;
      }
    }

    const defuddleFallback = await maybeRunDefuddleSearch(resolvedInput, options, settings, {
      directUrlQuery: false,
      reason: errorMessage(error),
    });

    if (defuddleFallback) {
      return defuddleFallback;
    }

    throw error;
  }
}

function canAutoEscalateDefaultFastSearch(
  originalInput: WebSearchInput,
  resolvedInput: ResolvedWebSearchInput
): boolean {
  if (resolvedInput.mode !== "fast") {
    return false;
  }

  return originalInput.mode === undefined && originalInput.freshness === undefined;
}

async function runResolvedCodexWebSearch(
  input: ResolvedWebSearchInput,
  options: ExecuteCodexWebSearchOptions,
  settings: WebSearchSettings,
  runner: RunCodexCommand,
  retry: RetryProvenance | undefined = undefined,
  allowFastAutoEscalation = false
): Promise<{
  content: { type: "text"; text: string }[];
  details: CodexWebSearchDetails;
}> {
  const { query, maxSources, mode, freshness } = input;
  const policy = getSearchPolicy(mode, settings);
  const progress = createSearchProgress(query, mode, freshness);
  const tempDir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-"));
  const outputPath = join(tempDir, "result.json");
  let warnedAtFastBudget = false;

  if (retry) {
    emitProgressUpdate(
      options,
      progress,
      buildFastRetryStatus(mode, freshness, retry.fallbackReason)
    );
  }

  emitProgressUpdate(options, progress, `Running ${mode} Codex web search for: ${query}`);

  const abortController = new AbortController();
  const signal = mergeAbortSignals(options.signal, abortController);

  try {
    const runnerOptions: RunCodexCommandOptions = {
      args: buildCodexExecArgs({ schemaPath: SEARCH_OUTPUT_SCHEMA_PATH, outputPath }, freshness),
      cwd: options.cwd,
      stdin: buildCodexPrompt({ query, maxSources, mode }),
      timeoutMs: policy.timeoutMs,
      signal,
      onStdoutLine: (line) => {
        const updates = collectSearchQueries(progress, line);
        for (const addedQuery of updates) {
          emitProgressUpdate(options, progress, `Search #${progress.searchCount}: ${addedQuery}`);
        }

        if (mode === "fast" && progress.searchCount === policy.queryBudget && !warnedAtFastBudget) {
          warnedAtFastBudget = true;
          emitProgressUpdate(
            options,
            progress,
            buildFastBudgetWarning(policy.queryBudget, allowFastAutoEscalation)
          );
        }

        if (progress.searchCount > policy.queryBudget && !abortController.signal.aborted) {
          if (mode === "fast") {
            markFastModeExhausted(options.turnState);
            abortController.abort(
              new Error(buildFastBudgetFailure(policy.queryBudget, allowFastAutoEscalation))
            );
            return;
          }

          abortController.abort(
            new Error(
              `Codex exceeded the deep search budget (${policy.queryBudget} queries). Narrow the request or make the query more specific.`
            )
          );
        }
      },
    };

    let runResult: RunCodexCommandResult;

    try {
      runResult = await runner(runnerOptions);
    } catch (error) {
      if (mode === "fast" && shouldBlockFurtherFastRetries(error)) {
        markFastModeExhausted(options.turnState);
      }
      throw error;
    }

    if (runResult.code !== 0) {
      throw new Error(buildCodexFailureMessage(runResult));
    }

    const rawOutput = await readFinalCodexOutput(outputPath, runResult.stdout);
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

    if (retry) {
      details.retry = retry;
    }

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

function buildFastRetryStatus(
  mode: SearchMode,
  freshness: SearchFreshness,
  reason: string
): string {
  const action = /budget/i.test(reason)
    ? `Auto-escalating to ${mode}/${freshness} after fast mode hit its query budget.`
    : `Retrying as ${mode}/${freshness} after fast mode failed.`;
  return `${action} ${reason}`;
}

function buildFastBudgetWarning(queryBudget: number, allowFastAutoEscalation: boolean): string {
  if (allowFastAutoEscalation) {
    return `Fast mode has used its full query budget (${queryBudget}/${queryBudget}). If Codex needs another search, it will auto-escalate once to deep/live.`;
  }

  return `Fast mode has used its full query budget (${queryBudget}/${queryBudget}). If Codex needs another search, this run will fail. Rerun with mode=deep or freshness=live for a broader search.`;
}

function buildFastBudgetFailure(queryBudget: number, allowFastAutoEscalation: boolean): string {
  if (allowFastAutoEscalation) {
    return `Fast mode exhausted its query budget (${queryBudget} queries). Auto-escalating once to deep/live.`;
  }

  return `Codex exceeded the fast search budget (${queryBudget} queries). Do not retry fast mode again in this turn; rerun with mode=deep or freshness=live if you need broader or fresher results.`;
}

async function maybeRunDefuddleSearch(
  input: ResolvedWebSearchInput,
  options: ExecuteCodexWebSearchOptions,
  settings: WebSearchSettings,
  defuddle: {
    directUrlQuery: boolean;
    reason: string;
    urls?: string[];
  }
): Promise<
  | {
      content: { type: "text"; text: string }[];
      details: CodexWebSearchDetails;
    }
  | undefined
> {
  if (!shouldUseDefuddleFallback(settings, input.query, defuddle.directUrlQuery)) {
    return undefined;
  }

  const defuddleRunner = options.defuddleRunner ?? runDefuddleCommand;
  const urls = (defuddle.urls ?? getDefuddleFallbackUrls(input.query)).slice(0, input.maxSources);
  if (urls.length === 0) {
    return undefined;
  }

  const progress = createSearchProgress(input.query, input.mode, input.freshness);
  const results: DefuddleParseResult[] = [];

  for (const url of urls) {
    emitProgressUpdate(options, progress, `Extracting clean page content with Defuddle: ${url}`);

    try {
      const runnerOptions = {
        url,
        cwd: options.cwd,
      } as const;

      const parsed = options.signal
        ? await defuddleRunner({
            ...runnerOptions,
            signal: options.signal,
            timeoutMs: settings.defuddleTimeoutMs,
          })
        : await defuddleRunner({ ...runnerOptions, timeoutMs: settings.defuddleTimeoutMs });
      results.push(parsed);
    } catch {
      continue;
    }
  }

  if (results.length === 0) {
    return undefined;
  }

  const sources = results.map((result) => ({
    title: result.title.trim() || result.url,
    url: result.url,
    snippet: buildDefuddleSnippet(result),
  }));
  const summary = buildDefuddleSummary(results, defuddle);
  const renderedResult = await renderToolResult(formatWebSearchResult({ summary, sources }));
  const details: CodexWebSearchDetails = {
    query: input.query,
    mode: input.mode,
    freshness: input.freshness,
    searchCount: 0,
    searchQueries: [],
    sourceCount: sources.length,
    summary,
    sources,
    truncated: renderedResult.truncated,
    defuddle: {
      directUrlQuery: defuddle.directUrlQuery,
      reason: defuddle.reason,
      urls: results.map((result) => result.url),
    },
  };

  if (renderedResult.fullOutputPath) {
    details.fullOutputPath = renderedResult.fullOutputPath;
  }

  return {
    content: [{ type: "text", text: renderedResult.text }],
    details,
  };
}

async function readFinalCodexOutput(outputPath: string, stdout: string): Promise<string> {
  let rawOutput = "";

  try {
    rawOutput = await readFile(outputPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (rawOutput.trim()) {
    return rawOutput;
  }

  const fallbackOutput = extractFinalAgentMessage(stdout);
  if (fallbackOutput) {
    return fallbackOutput;
  }

  throw new Error("Codex did not write a final response to the output file or stdout events.");
}

function extractFinalAgentMessage(stdout: string): string | undefined {
  let latestAgentMessage: string | undefined;

  for (const line of stdout.split(/\r?\n/u)) {
    const event = parseJsonObject(line);
    if (!event || event.type !== "item.completed") continue;

    const item = event.item;
    if (!item || typeof item !== "object") continue;

    const typedItem = item as { type?: unknown; text?: unknown };
    if (typedItem.type === "agent_message" && typeof typedItem.text === "string") {
      latestAgentMessage = typedItem.text;
    }
  }

  return latestAgentMessage?.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldRetryWithDeepLiveSearch(
  originalInput: WebSearchInput,
  resolvedInput: ResolvedWebSearchInput,
  error: unknown
): boolean {
  if (resolvedInput.mode !== "fast") {
    return false;
  }

  if (originalInput.mode !== undefined || originalInput.freshness !== undefined) {
    return false;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /timed out|query budget|search budget|did not write a final response|invalid JSON|empty summary|does not match the expected web search schema|no result provided/i.test(
    error.message
  );
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
          ? "Could not find `codex` in PATH. Install Codex CLI, then run `codex login status` or `codex login`."
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
  const authHelp = needsCodexAuthHelp(details)
    ? "\n\nCodex authentication appears to be missing or expired. Run `codex login status` and `codex login` if needed."
    : "";
  return `codex exec failed with exit code ${result.code}.${suffix}${authHelp}`;
}

function tailLines(text: string, count: number): string {
  const lines = text
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines.slice(-count).join("\n");
}

function needsCodexAuthHelp(text: string): boolean {
  return /\bauth(?:entication)?\b|login|unauthorized|forbidden|expired session|api key|access token/i.test(
    text
  );
}

function markFastModeExhausted(turnState: WebSearchTurnState | undefined): void {
  if (turnState) {
    turnState.fastModeExhausted = true;
  }
}

function shouldBlockFurtherFastRetries(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /query budget|search budget|timed out/i.test(error.message);
}

function getSearchPolicy(
  mode: SearchMode,
  settings: WebSearchSettings
): { timeoutMs: number; queryBudget: number } {
  if (mode === "deep") {
    return {
      timeoutMs: settings.deepTimeoutMs,
      queryBudget: settings.deepQueryBudget,
    };
  }

  return {
    timeoutMs: settings.fastTimeoutMs,
    queryBudget: settings.fastQueryBudget,
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
  progress.statusText = text;

  const details: WebSearchProgressDetails = {
    query: progress.query,
    mode: progress.mode,
    freshness: progress.freshness,
    searchCount: progress.searchCount,
    searchQueries: [...progress.searchQueries],
    statusText: progress.statusText,
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

  const queries = extractSearchQueries(event);
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

function extractSearchQueries(event: Record<string, unknown>): string[] {
  if (typeof event.type !== "string" || !event.type.startsWith("item.")) {
    return [];
  }

  const item = event.item;
  if (!item || typeof item !== "object") return [];

  const typedItem = item as {
    type?: unknown;
    action?: unknown;
    output?: unknown;
    query?: unknown;
    queries?: unknown;
  };

  if (typedItem.type !== "web_search" && typedItem.type !== "web_search_call") {
    return [];
  }

  const queries = [
    ...extractQueryValues(typedItem.queries),
    ...extractQueryValues(typedItem.query),
    ...extractSearchActionQueries(typedItem.action),
    ...extractSearchActionQueries(typedItem.output),
  ];

  return queries;
}

function extractSearchActionQueries(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const typedValue = value as { type?: unknown; query?: unknown; queries?: unknown };
  if (typedValue.type !== undefined && typedValue.type !== "search") {
    return [];
  }

  return [...extractQueryValues(typedValue.queries), ...extractQueryValues(typedValue.query)];
}

function extractQueryValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((query): query is string => typeof query === "string");
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
