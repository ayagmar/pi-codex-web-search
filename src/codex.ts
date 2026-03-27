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
import { runCodexCommand } from "./codex-command.js";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "./settings.js";
import type {
  CodexFailureDetails,
  CodexFailureKind,
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

interface LooseWebSearchSource {
  title?: string;
  url: string;
  snippet?: string;
}

interface LooseCodexWebSearchOutput {
  summary: string;
  sources: LooseWebSearchSource[];
}

interface CodexJsonlSummary {
  finalAgentMessage?: string;
  turnFailedMessage?: string;
  errorMessages: string[];
}

export { findBundledCodexExecutable, runCodexCommand } from "./codex-command.js";

class CodexWebSearchFailure extends Error {
  readonly failure: CodexFailureDetails;
  readonly progress: WebSearchProgressDetails;

  constructor(failure: CodexFailureDetails, progress: WebSearchProgressDetails) {
    super(failure.message);
    this.name = "CodexWebSearchFailure";
    this.failure = failure;
    this.progress = progress;
  }
}

export function normalizeMaxSources(
  maxSources?: number,
  fallback = DEFAULT_WEB_SEARCH_SETTINGS.fastMaxSources
): number {
  if (maxSources === undefined || Number.isNaN(maxSources)) {
    return clampMaxSources(fallback);
  }

  return clampMaxSources(maxSources);
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
  const parsed = parseJsonObjectText(raw, "Codex returned invalid JSON");

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
    const exhaustedProgress = createSearchProgress(
      resolvedInput.query,
      resolvedInput.mode,
      resolvedInput.freshness
    );
    const exhaustedFailure = createCodexFailure(
      "budget",
      "Fast search already failed earlier in this turn. Use deep or live search if you still need broader or fresher results.",
      true
    );

    const exhaustedDefuddleFallback = await maybeRunDefuddleSearch(
      resolvedInput,
      options,
      settings,
      {
        directUrlQuery: false,
        reason: exhaustedFailure.message,
      }
    );

    if (exhaustedDefuddleFallback) {
      return exhaustedDefuddleFallback;
    }

    return buildSoftFailureResult(resolvedInput, exhaustedProgress, exhaustedFailure);
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
    const failure = getCodexFailure(error);
    const progress = getFailureProgress(error, resolvedInput);

    if (shouldRetryWithDeepLiveSearch(input, resolvedInput, failure)) {
      const retry: RetryProvenance = {
        retriedFromFast: true,
        originalMode: "fast",
        originalFreshness: resolvedInput.freshness,
        fallbackReason: failure.message,
      };

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
          retry
        );
      } catch (retryFailure) {
        const retryFailureDetails = getCodexFailure(retryFailure);
        const retryProgress = getFailureProgress(retryFailure, {
          ...resolvedInput,
          mode: "deep",
          freshness: "live",
        });

        if (shouldExhaustFastModeInTurn(failure)) {
          markFastModeExhausted(options.turnState);
        }

        if (shouldThrowCodexFailure(retryFailureDetails)) {
          throw asError(retryFailureDetails, retryProgress);
        }

        const defuddleRetryFallback = await maybeRunDefuddleSearch(
          {
            ...resolvedInput,
            mode: "deep",
            freshness: "live",
          },
          options,
          settings,
          {
            directUrlQuery: false,
            reason: retryFailureDetails.message,
            retry,
          }
        );

        if (defuddleRetryFallback) {
          return defuddleRetryFallback;
        }

        return buildSoftFailureResult(
          {
            ...resolvedInput,
            mode: "deep",
            freshness: "live",
          },
          retryProgress,
          retryFailureDetails,
          retry
        );
      }
    }

    if (shouldThrowCodexFailure(failure)) {
      throw asError(failure, progress);
    }

    const defuddleFallback = await maybeRunDefuddleSearch(resolvedInput, options, settings, {
      directUrlQuery: false,
      reason: failure.message,
    });

    if (defuddleFallback) {
      return defuddleFallback;
    }

    return buildSoftFailureResult(resolvedInput, progress, failure);
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
        const previousSearchCount = progress.searchCount;
        const updates = collectProgressUpdates(progress, line);
        for (const addedQuery of updates.queries) {
          emitProgressUpdate(options, progress, `Search #${progress.searchCount}: ${addedQuery}`);
        }
        for (const status of updates.statuses) {
          emitProgressUpdate(options, progress, status);
        }

        if (
          mode === "fast" &&
          previousSearchCount < policy.queryBudget &&
          progress.searchCount >= policy.queryBudget &&
          !warnedAtFastBudget
        ) {
          warnedAtFastBudget = true;
          emitProgressUpdate(
            options,
            progress,
            buildFastBudgetWarning(
              progress.searchCount,
              policy.queryBudget,
              allowFastAutoEscalation
            )
          );
        }

        if (progress.searchCount > policy.queryBudget && !abortController.signal.aborted) {
          if (mode === "fast") {
            if (!allowFastAutoEscalation) {
              markFastModeExhausted(options.turnState);
            }
            abortController.abort(
              new Error(
                buildFastBudgetFailure(
                  progress.searchCount,
                  policy.queryBudget,
                  allowFastAutoEscalation
                )
              )
            );
            return;
          }

          abortController.abort(
            new Error(
              `Codex exceeded the deep search budget (${progress.searchCount}/${policy.queryBudget} queries). Narrow the request or make the query more specific.`
            )
          );
        }
      },
    };

    let runResult: RunCodexCommandResult;

    try {
      runResult = await runner(runnerOptions);
    } catch (error) {
      const failure = getCodexFailure(error);
      if (mode === "fast" && !allowFastAutoEscalation && shouldExhaustFastModeInTurn(failure)) {
        markFastModeExhausted(options.turnState);
      }
      throw asError(failure, progress);
    }

    if (runResult.code !== 0) {
      const failure = buildCodexFailure(runResult);
      if (mode === "fast" && !allowFastAutoEscalation && shouldExhaustFastModeInTurn(failure)) {
        markFastModeExhausted(options.turnState);
      }
      throw asError(failure, progress);
    }

    let rawOutput: string;
    try {
      rawOutput = await readFinalCodexOutput(outputPath, runResult.stdout);
    } catch (error) {
      const failure = getCodexFailure(error);
      if (mode === "fast" && !allowFastAutoEscalation && shouldExhaustFastModeInTurn(failure)) {
        markFastModeExhausted(options.turnState);
      }
      throw asError(failure, progress);
    }

    let parsed: CodexWebSearchOutput;
    try {
      parsed = parseCodexWebSearchOutput(rawOutput, maxSources);
    } catch (error) {
      const failure = getCodexFailure(error);
      if (mode === "fast" && !allowFastAutoEscalation && shouldExhaustFastModeInTurn(failure)) {
        markFastModeExhausted(options.turnState);
      }
      throw asError(failure, progress);
    }

    const formattedResult = formatWebSearchResult(parsed);
    const renderedResult = await renderToolResult(formattedResult);

    const details: CodexWebSearchDetails = {
      query,
      mode,
      freshness,
      searchCount: progress.searchCount,
      searchQueries: [...progress.searchQueries],
      statusEvents: [...progress.statusEvents],
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

async function buildSoftFailureResult(
  input: ResolvedWebSearchInput,
  progress: WebSearchProgressDetails,
  failure: CodexFailureDetails,
  retry?: RetryProvenance
): Promise<{
  content: { type: "text"; text: string }[];
  details: CodexWebSearchDetails;
}> {
  const summary = buildSoftFailureSummary(failure, retry);
  const renderedResult = await renderToolResult(buildSoftFailureBody(summary, failure));

  const details: CodexWebSearchDetails = {
    query: input.query,
    mode: input.mode,
    freshness: input.freshness,
    searchCount: progress.searchCount,
    searchQueries: [...progress.searchQueries],
    statusEvents: [...progress.statusEvents],
    sourceCount: 0,
    summary,
    sources: [],
    truncated: renderedResult.truncated,
    failure,
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
}

function buildSoftFailureSummary(
  failure: CodexFailureDetails,
  retry: RetryProvenance | undefined
): string {
  const attempt = retry
    ? `Codex web search could not produce a usable result after retrying as deep/live.`
    : `Codex web search could not produce a usable result.`;
  const guidance = failure.recoverable
    ? "No verified web summary is available from this run."
    : "This run needs manual intervention before web search can succeed.";
  return `${attempt} ${guidance}`;
}

function buildSoftFailureBody(summary: string, failure: CodexFailureDetails): string {
  return [summary, "", `Failure kind: ${failure.kind}`, `Reason: ${failure.message}`].join("\n");
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

function buildFastBudgetWarning(
  searchCount: number,
  queryBudget: number,
  allowFastAutoEscalation: boolean
): string {
  if (allowFastAutoEscalation) {
    return `Fast mode has used its full query budget (${searchCount}/${queryBudget}). If Codex needs another search, it will auto-escalate once to deep/live.`;
  }

  return `Fast mode has used its full query budget (${searchCount}/${queryBudget}). If Codex needs another search, this run will fail. Rerun with mode=deep or freshness=live for a broader search.`;
}

function buildFastBudgetFailure(
  searchCount: number,
  queryBudget: number,
  allowFastAutoEscalation: boolean
): string {
  if (allowFastAutoEscalation) {
    return `Fast mode exhausted its query budget (${searchCount}/${queryBudget} queries). Auto-escalating once to deep/live.`;
  }

  return `Codex exceeded the fast search budget (${searchCount}/${queryBudget} queries). Do not retry fast mode again in this turn; rerun with mode=deep or freshness=live if you need broader or fresher results.`;
}

async function maybeRunDefuddleSearch(
  input: ResolvedWebSearchInput,
  options: ExecuteCodexWebSearchOptions,
  settings: WebSearchSettings,
  defuddle: {
    directUrlQuery: boolean;
    reason: string;
    urls?: string[];
    retry?: RetryProvenance;
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
    } catch (error) {
      if (options.signal?.aborted || isAbortLikeError(error)) {
        throw error;
      }
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
    statusEvents: [...progress.statusEvents],
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

  if (defuddle.retry) {
    details.retry = defuddle.retry;
  }

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

  const summary = summarizeCodexStdout(stdout);
  if (rawOutput.trim()) {
    return extractJsonObjectCandidate(rawOutput) ?? summary.finalAgentMessage ?? rawOutput;
  }

  if (summary.finalAgentMessage) {
    return summary.finalAgentMessage;
  }

  if (summary.turnFailedMessage || summary.errorMessages.length > 0) {
    throw new Error(
      summary.turnFailedMessage ??
        summary.errorMessages.at(-1) ??
        "Codex did not return a usable response."
    );
  }

  throw new Error("Codex did not write a final response to the output file or stdout events.");
}

function summarizeCodexStdout(stdout: string): CodexJsonlSummary {
  const errorMessages: string[] = [];
  let finalAgentMessage: string | undefined;
  let turnFailedMessage: string | undefined;

  for (const line of stdout.split(/\r?\n/u)) {
    const event = parseJsonObject(line);
    if (!event) continue;

    const agentMessage = extractFinalAgentMessageFromEvent(event);
    if (agentMessage) {
      finalAgentMessage = agentMessage;
    }

    const errorMessage = extractErrorMessageFromEvent(event);
    if (errorMessage) {
      errorMessages.push(errorMessage);
      if (typeof event.type === "string" && /(?:^|\.)failed$/u.test(event.type)) {
        turnFailedMessage = errorMessage;
      }
    }
  }

  return {
    ...(finalAgentMessage ? { finalAgentMessage } : {}),
    ...(turnFailedMessage ? { turnFailedMessage } : {}),
    errorMessages,
  };
}

function extractFinalAgentMessageFromEvent(event: Record<string, unknown>): string | undefined {
  const item = extractEventItem(event);
  if (item) {
    const directMessage = extractAssistantMessageTextFromItem(item);
    if (directMessage) {
      return directMessage;
    }
  }

  const response = event.response;
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return undefined;
  }

  const items = output as unknown[];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== "object") {
      continue;
    }

    const message = extractAssistantMessageTextFromItem(item as Record<string, unknown>);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function extractErrorMessageFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "error" && typeof event.message === "string") {
    return event.message.trim() || undefined;
  }

  if (typeof event.type === "string" && /(?:^|\.)failed$/u.test(event.type)) {
    const failedMessage = extractMessageField(event.error);
    if (failedMessage) {
      return failedMessage;
    }
  }

  const item = extractEventItem(event);
  if (!item) {
    return undefined;
  }

  if (item.type === "error" && typeof item.message === "string") {
    return item.message.trim() || undefined;
  }

  return extractMessageField((item as { error?: unknown }).error);
}

function extractEventItem(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (
    !event.item ||
    typeof event.item !== "object" ||
    typeof event.type !== "string" ||
    (!event.type.startsWith("item.") && !event.type.startsWith("response.output_item."))
  ) {
    return undefined;
  }

  return event.item as Record<string, unknown>;
}

function extractAssistantMessageTextFromItem(item: Record<string, unknown>): string | undefined {
  if (item.type === "agent_message" && typeof item.text === "string") {
    return item.text.trim() || undefined;
  }

  if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
    return undefined;
  }

  const text = item.content.map(extractAssistantContentText).join("");
  return text.trim() || undefined;
}

function extractAssistantContentText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const typedValue = value as { type?: unknown; text?: unknown };
  if (
    (typedValue.type === "output_text" || typedValue.type === "text") &&
    typeof typedValue.text === "string"
  ) {
    return typedValue.text;
  }

  return "";
}

function extractMessageField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const typedValue = value as { message?: unknown };
  return typeof typedValue.message === "string"
    ? typedValue.message.trim() || undefined
    : undefined;
}

function shouldRetryWithDeepLiveSearch(
  originalInput: WebSearchInput,
  resolvedInput: ResolvedWebSearchInput,
  failure: CodexFailureDetails
): boolean {
  if (resolvedInput.mode !== "fast") {
    return false;
  }

  if (originalInput.mode !== undefined || originalInput.freshness !== undefined) {
    return false;
  }

  return failure.recoverable;
}

function createCodexFailure(
  kind: CodexFailureKind,
  message: string,
  recoverable: boolean
): CodexFailureDetails {
  return {
    kind,
    message,
    recoverable,
  };
}

function getCodexFailure(error: unknown): CodexFailureDetails {
  if (error instanceof CodexWebSearchFailure) {
    return error.failure;
  }

  const message = error instanceof Error ? error.message : String(error);
  return classifyFailureText(message);
}

function getFailureProgress(
  error: unknown,
  input: ResolvedWebSearchInput
): WebSearchProgressDetails {
  if (error instanceof CodexWebSearchFailure) {
    return error.progress;
  }

  return createSearchProgress(input.query, input.mode, input.freshness);
}

function asError(
  failure: CodexFailureDetails,
  progress: WebSearchProgressDetails
): CodexWebSearchFailure {
  return new CodexWebSearchFailure(failure, cloneProgress(progress));
}

function shouldThrowCodexFailure(failure: CodexFailureDetails): boolean {
  return (
    failure.kind === "auth" ||
    failure.kind === "missing_cli" ||
    failure.kind === "local_config" ||
    failure.kind === "cancelled"
  );
}

function buildCodexFailure(result: RunCodexCommandResult): CodexFailureDetails {
  const stdoutSummary = summarizeCodexStdout(result.stdout);
  const details = [
    stdoutSummary.turnFailedMessage,
    stdoutSummary.errorMessages.at(-1),
    result.stderr.trim(),
    tailLines(result.stdout, 12),
  ]
    .filter(Boolean)
    .join("\n\n");
  const message = details
    ? `codex exec failed with exit code ${result.code}.\n\n${details}`
    : `codex exec failed with exit code ${result.code}.`;
  const classified = classifyFailureText(message);

  if (classified.kind === "auth") {
    return createCodexFailure(
      classified.kind,
      `${message}\n\nCodex authentication appears to be missing or expired. Run \`codex login status\` and \`codex login\` if needed.`,
      false
    );
  }

  return createCodexFailure(classified.kind, message, classified.recoverable);
}

function classifyFailureText(message: string): CodexFailureDetails {
  if (/could not find `codex` in path|common install locations/i.test(message)) {
    return createCodexFailure("missing_cli", message, false);
  }

  if (/failed to start codex cli|invalid .*config|config error/i.test(message)) {
    return createCodexFailure("local_config", message, false);
  }

  if (needsCodexAuthHelp(message)) {
    return createCodexFailure("auth", message, false);
  }

  if (/\bcancel(?:led|ed)?\b|abort(?:ed)?/i.test(message)) {
    return createCodexFailure("cancelled", message, false);
  }

  if (/rate limit|too many requests|\b429\b|quota|capacity/i.test(message)) {
    return createCodexFailure("rate_limit", message, true);
  }

  if (/timed out|timeout waiting/i.test(message)) {
    return createCodexFailure("timeout", message, true);
  }

  if (/query budget|search budget|failed earlier in this turn/i.test(message)) {
    return createCodexFailure("budget", message, true);
  }

  if (/invalid JSON|does not match the expected web search schema/i.test(message)) {
    return createCodexFailure("schema", message, true);
  }

  if (
    /empty summary|did not write a final response|no result provided|no usable response/i.test(
      message
    )
  ) {
    return createCodexFailure("empty_result", message, true);
  }

  if (
    /stream disconnected before completion|error sending request|transport failed|disconnected|reconnect|reconnecting|websocket|https transport|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|\b5\d\d\b|tls|ssl|certificate|dns|eai_again|enotfound|econnreset|econnrefused|connection reset|connection refused|connection aborted|socket hang up|network error|failed to connect|connect error|connection closed/i.test(
      message
    )
  ) {
    return createCodexFailure("transport", message, true);
  }

  return createCodexFailure("unknown", message, false);
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

function shouldExhaustFastModeInTurn(failure: CodexFailureDetails): boolean {
  return failure.kind === "budget" || failure.kind === "timeout";
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
    statusEvents: [],
  };
}

function cloneProgress(progress: WebSearchProgressDetails): WebSearchProgressDetails {
  return {
    query: progress.query,
    mode: progress.mode,
    freshness: progress.freshness,
    searchCount: progress.searchCount,
    searchQueries: [...progress.searchQueries],
    statusEvents: [...progress.statusEvents],
    ...(progress.latestQuery ? { latestQuery: progress.latestQuery } : {}),
    ...(progress.statusText ? { statusText: progress.statusText } : {}),
  };
}

function emitProgressUpdate(
  options: ExecuteCodexWebSearchOptions,
  progress: WebSearchProgressDetails,
  text: string
): void {
  progress.statusText = text;

  const details = cloneProgress(progress);

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

function collectProgressUpdates(
  progress: WebSearchProgressDetails,
  line: string
): { queries: string[]; statuses: string[] } {
  const event = parseJsonObject(line);
  if (!event) {
    return { queries: [], statuses: [] };
  }

  const queries = collectSearchQueries(progress, event);
  const statuses = collectStatusEvents(progress, event);
  return { queries, statuses };
}

function collectSearchQueries(
  progress: WebSearchProgressDetails,
  event: Record<string, unknown>
): string[] {
  const queries = extractSearchQueries(event);
  if (queries.length === 0) return [];

  const addedQueries: string[] = [];
  for (const query of queries) {
    const normalized = query.trim();
    if (!normalized) continue;

    progress.searchCount += 1;
    progress.latestQuery = normalized;

    if (progress.searchQueries.includes(normalized)) {
      continue;
    }

    progress.searchQueries.push(normalized);
    addedQueries.push(normalized);
  }

  return addedQueries;
}

function collectStatusEvents(
  progress: WebSearchProgressDetails,
  event: Record<string, unknown>
): string[] {
  const message = extractErrorMessageFromEvent(event);
  if (!message) {
    return [];
  }

  if (progress.statusEvents.at(-1) === message) {
    return [];
  }

  progress.statusEvents.push(message);
  if (progress.statusEvents.length > 8) {
    progress.statusEvents.splice(0, progress.statusEvents.length - 8);
  }

  return [message];
}

function clampMaxSources(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  const rounded = Math.trunc(value);
  return Math.min(Math.max(rounded, 1), MAX_ALLOWED_SOURCES);
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }

  return error instanceof Error && error.name === "AbortError";
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

function parseJsonObjectText(raw: string, errorPrefix: string): Record<string, unknown> {
  const candidate = extractJsonObjectCandidate(raw) ?? raw.trim();

  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorPrefix}: ${message}`);
  }

  throw new Error(`${errorPrefix}: expected a JSON object.`);
}

function extractJsonObjectCandidate(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const fenced = fencedMatch?.[1]?.trim();
  if (fenced) {
    return extractJsonObjectCandidate(fenced) ?? fenced;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = firstBrace; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (!character) {
      continue;
    }

    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(firstBrace, index + 1);
      }
    }
  }

  return undefined;
}

function extractSearchQueries(event: Record<string, unknown>): string[] {
  const item = extractEventItem(event);
  if (!item) {
    return [];
  }

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

  return dedupeQueries(queries);
}

function extractSearchActionQueries(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const typedValue = value as {
    type?: unknown;
    query?: unknown;
    queries?: unknown;
    url?: unknown;
    pattern?: unknown;
  };

  if (typedValue.type === undefined || typedValue.type === "search") {
    return [...extractQueryValues(typedValue.queries), ...extractQueryValues(typedValue.query)];
  }

  if (typedValue.type === "open_page") {
    return extractQueryValues(typedValue.url);
  }

  if (typedValue.type === "find_in_page") {
    const url = extractQueryValues(typedValue.url)[0];
    const pattern = extractQueryValues(typedValue.pattern)[0];
    if (url && pattern) {
      return [`${pattern} in ${url}`];
    }
    return [url, pattern].filter((query): query is string => !!query);
  }

  return [];
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

function dedupeQueries(queries: string[]): string[] {
  const uniqueQueries: string[] = [];

  for (const query of queries) {
    const normalized = query.trim();
    if (!normalized || uniqueQueries.includes(normalized)) {
      continue;
    }
    uniqueQueries.push(normalized);
  }

  return uniqueQueries;
}

function isCodexWebSearchOutput(value: unknown): value is LooseCodexWebSearchOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { summary?: unknown; sources?: unknown };
  return (
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.sources) &&
    candidate.sources.every(isWebSearchSource)
  );
}

function isWebSearchSource(value: unknown): value is LooseWebSearchSource {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { title?: unknown; url?: unknown; snippet?: unknown };
  return (
    typeof candidate.url === "string" &&
    (typeof candidate.title === "string" || candidate.title === undefined) &&
    (typeof candidate.snippet === "string" || candidate.snippet === undefined)
  );
}

function hasUsableSource(source: WebSearchSource): boolean {
  return source.title.length > 0 && source.url.length > 0;
}

function normalizeSource(source: LooseWebSearchSource): WebSearchSource {
  const url = source.url.trim();
  const title = source.title === undefined ? url : source.title.trim();

  return {
    title,
    url,
    snippet: source.snippet?.trim() ?? "",
  };
}
