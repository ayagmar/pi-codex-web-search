import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { executeCodexWebSearch } from "./codex.js";
import {
  MAX_ALLOWED_SOURCES,
  MAX_QUERY_BUDGET,
  MAX_TIMEOUT_MS,
  MIN_QUERY_BUDGET,
  MIN_TIMEOUT_MS,
  SETTINGS_COMMAND,
  TOOL_NAME,
} from "./constants.js";
import { createSearchGate } from "./search-gate.js";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  formatSettings,
  loadSettings,
  saveSettings,
} from "./settings.js";
import {
  type CodexFailureDetails,
  type CodexWebSearchDetails,
  type DefuddleMode,
  type ExecuteCodexWebSearchOptions,
  type RetryProvenance,
  type SearchFreshness,
  type SearchMode,
  type WebSearchProgressDetails,
  type WebSearchSettings,
  type WebSearchTurnState,
} from "./types.js";

const SETTINGS_ARGUMENT_OPTIONS = [
  "status",
  "reset",
  "default-mode fast",
  "default-mode deep",
  "fast-freshness cached",
  "fast-freshness indexed",
  "fast-freshness live",
  "deep-freshness cached",
  "deep-freshness indexed",
  "deep-freshness live",
  "fast-max-sources 5",
  "deep-max-sources 5",
  "default-max-sources 5",
  "defuddle-mode off",
  "defuddle-mode direct",
  "defuddle-mode fallback",
  "defuddle-mode both",
  "fast-timeout-ms 90000",
  "deep-timeout-ms 240000",
  "defuddle-timeout-ms 45000",
  "fast-query-budget 10",
  "deep-query-budget 24",
] as const;

interface SearchRunContext {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: ExecuteCodexWebSearchOptions["onUpdate"];
}

export default function codexWebSearchExtension(pi: ExtensionAPI) {
  const turnState: WebSearchTurnState = { fastModeExhausted: false };
  // Aborted on session_shutdown. Codex runs in its own process group, so an
  // in-flight search would otherwise outlive a quit, reload or session switch.
  const lifecycle = new AbortController();

  // Per-call state is passed through the gate instead of shared closure
  // variables: a skipped or coalesced sibling call must not replace the abort
  // signal or progress callback of the call that is actually running.
  const searchGate = createSearchGate<SearchRunContext>(async (_toolCallId, params, run) => {
    const options: ExecuteCodexWebSearchOptions = {
      cwd: run.cwd,
      settings: await loadSettings(),
      turnState,
    };

    options.signal = run.signal
      ? AbortSignal.any([run.signal, lifecycle.signal])
      : lifecycle.signal;
    if (run.onUpdate) options.onUpdate = run.onUpdate;

    return executeCodexWebSearch(params, options);
  });

  const resetTurnState = (): void => {
    turnState.fastModeExhausted = false;
    searchGate.reset();
  };

  pi.on("turn_start", resetTurnState);
  pi.on("turn_end", resetTurnState);
  pi.on("agent_end", resetTurnState);
  pi.on("session_shutdown", () => {
    if (!lifecycle.signal.aborted) {
      lifecycle.abort(new Error("Codex web search was cancelled because the Pi session ended."));
    }
    resetTurnState();
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      "Search the public web through the locally installed Codex CLI and return a concise, source-backed answer. Use fast mode for normal lookups and deep mode for comparisons or broader research. Never issue multiple web_search calls in parallel; combine related subquestions into one precise request, wait for its result, then search again only if needed. Indexed search is the low-latency default; live search is used for clearly time-sensitive requests. Preserve the user's exact scope, constraints, dates, and named sites. Defuddle can extract direct URLs and optionally recover URL-based requests. Progress exposes the active phase, query count, budget, elapsed time, page inspections, retries, and failure cause. Timeouts, budgets, Defuddle behavior, and per-mode defaults are configurable via /web-search-settings. Output is truncated to Pi's standard limits when needed. Requires `codex` to be installed and authenticated on this machine.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for on the web" }),
      maxSources: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description:
            "Maximum number of sources to include in the result. If omitted, the saved fast/deep default is used.",
        })
      ),
      mode: Type.Optional(
        StringEnum(["fast", "deep"] as const, {
          description:
            "Search depth. Use fast for simple lookups. Use deep only when the user explicitly asks for broader research.",
        })
      ),
      freshness: Type.Optional(
        StringEnum(["cached", "indexed", "live"] as const, {
          description:
            "Search backend override. Indexed is fast and broadly useful, cached is fastest but may be stale, and live is for time-sensitive questions like today, latest, score, result, or weather.",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const run: SearchRunContext = { cwd: ctx.cwd };
      if (signal) run.signal = signal;
      if (onUpdate) run.onUpdate = onUpdate;

      return searchGate.execute(toolCallId, params, run) as ReturnType<
        typeof executeCodexWebSearch
      >;
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("accent", formatInlineQuery(args.query));
      text += theme.fg("dim", ` [${args.mode ?? "default"}/${args.freshness ?? "auto"}]`);
      if (args.maxSources) {
        text += theme.fg("dim", ` (${args.maxSources} sources max)`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const details = result.details as WebSearchProgressDetails | undefined;
        return new Text(renderProgress(details, expanded, theme), 0, 0);
      }

      const details = result.details as
        | (Partial<CodexWebSearchDetails> & {
            servedFromTurnCache?: boolean;
            coalescedWithToolCallId?: string;
          })
        | undefined;
      if (!hasRenderableResultDetails(details)) {
        const content = result.content.find((part) => part.type === "text");
        const text = content?.type === "text" ? content.text : "";
        const failed = looksLikeFailureText(text);
        const statusLine = failed
          ? theme.fg("warning", "⚠ Web search failed")
          : theme.fg("success", "✓ Web search finished");

        if (text && expanded) {
          return new Text(`${statusLine}\n\n${formatToolOutput(text, theme)}`, 0, 0);
        }
        return new Text(statusLine, 0, 0);
      }

      const pageActions = Array.isArray(details.pageActions) ? details.pageActions : [];
      const failure = details.failure;
      let text = theme.fg(
        failure ? "warning" : "success",
        failure
          ? `⚠ ${formatFailureLabel(failure)}`
          : `✓ ${details.sourceCount} source${details.sourceCount === 1 ? "" : "s"}`
      );
      const searchCallCount =
        typeof details.searchCallCount === "number" ? details.searchCallCount : details.searchCount;
      text += theme.fg(
        "muted",
        ` from ${details.searchCount} quer${details.searchCount === 1 ? "y" : "ies"} in ${searchCallCount} call${searchCallCount === 1 ? "" : "s"} [${details.mode}/${details.freshness}]`
      );
      if (details.elapsedMs !== undefined) {
        text += theme.fg("dim", ` · ${formatElapsed(details.elapsedMs)}`);
      }
      if (details.queryBudget !== undefined) {
        text += theme.fg("dim", ` · call budget ${searchCallCount}/${details.queryBudget}`);
      }

      if (details.truncated) {
        text += theme.fg("warning", " (truncated)");
      }

      if (details.retry) {
        text += theme.fg("warning", " (retried)");
      }

      if (details.defuddle) {
        text += theme.fg("warning", " (defuddle)");
      }

      if (details.servedFromTurnCache) {
        text += theme.fg("dim", " (cached this turn)");
      } else if (details.coalescedWithToolCallId) {
        text += theme.fg("dim", " (coalesced)");
      }

      if (!expanded) {
        text += theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`);
        if (details.failure) {
          text += `\n${theme.fg("dim", formatInlineQuery(details.failure.message, 110))}`;
        } else if (details.latestQuery) {
          text += `\n${theme.fg("dim", `Last query: ${formatInlineQuery(details.latestQuery, 110)}`)}`;
        } else if (pageActions.length > 0) {
          text += `\n${theme.fg("dim", formatInlineQuery(pageActions[pageActions.length - 1], 110))}`;
        }
        if (details.defuddle?.urls[0]) {
          text += `\n${theme.fg("dim", `Page: ${formatInlineQuery(details.defuddle.urls[0], 110)}`)}`;
        }
        return new Text(text, 0, 0);
      }

      text += `\n${theme.fg("muted", `Original request: ${details.query}`)}`;
      if (
        details.elapsedMs !== undefined ||
        details.attempt !== undefined ||
        details.eventCount !== undefined
      ) {
        const diagnostics = [
          details.elapsedMs !== undefined
            ? `elapsed ${formatElapsed(details.elapsedMs)}`
            : undefined,
          details.attempt !== undefined ? `attempt ${details.attempt}` : undefined,
          details.eventCount !== undefined ? `${details.eventCount} Codex events` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        text += `\n${theme.fg("dim", `Run diagnostics: ${diagnostics}`)}`;
      }
      if (details.retry) {
        text += `\n${theme.fg("warning", formatRetrySummary(details.retry))}`;
        text += `\n${theme.fg("dim", details.retry.fallbackReason)}`;
      }
      if (details.failure) {
        text += `\n${theme.fg("warning", `Failure kind: ${details.failure.kind}`)}`;
        text += `\n${theme.fg("dim", details.failure.message)}`;
      }
      if (details.defuddle) {
        text += `\n${theme.fg("warning", details.defuddle.directUrlQuery ? "Used Defuddle for direct URL extraction" : "Used Defuddle after Codex failed")}`;
        text += `\n${theme.fg("dim", details.defuddle.reason)}`;
      }
      if (details.statusEvents.length > 0) {
        text += `\n${theme.fg("muted", `Codex events (${details.statusEvents.length}):`)}`;
        for (const [index, status] of details.statusEvents.entries()) {
          text += `\n${theme.fg("dim", `  ${index + 1}. ${status}`)}`;
        }
      }
      if (details.searchQueries.length > 0) {
        text += `\n${theme.fg("muted", `Queries (${details.searchQueries.length}):`)}`;
        for (const [index, query] of details.searchQueries.entries()) {
          text += `\n${theme.fg("dim", `  ${index + 1}. ${query}`)}`;
        }
      }
      if (pageActions.length > 0) {
        text += `\n${theme.fg("muted", `Page actions (${pageActions.length}):`)}`;
        for (const [index, pageAction] of pageActions.entries()) {
          text += `\n${theme.fg("dim", `  ${index + 1}. ${pageAction}`)}`;
        }
      }

      const content = result.content.find((part) => part.type === "text");
      if (content?.type === "text") {
        text += `\n\n${formatToolOutput(content.text, theme)}`;
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand(SETTINGS_COMMAND, {
    description:
      "Configure defaults, budgets, timeouts, and Defuddle behavior for the web_search tool",
    getArgumentCompletions: (prefix) => {
      const lowerPrefix = prefix.toLowerCase();
      const matches = SETTINGS_ARGUMENT_OPTIONS.filter((option) => option.startsWith(lowerPrefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();

      if (!trimmedArgs) {
        if (ctx.hasUI) {
          await openSettingsDialog(ctx);
          return;
        }
        notify(ctx, buildSettingsHelp(await loadSettings()));
        return;
      }

      await handleSettingsCommand(trimmedArgs, ctx);
    },
  });
}

async function handleSettingsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const settings = await loadSettings();
  const [command, value] = splitArgs(args);

  try {
    switch (command) {
      case "status":
        notify(ctx, buildSettingsHelp(settings));
        return;

      case "reset": {
        const saved = await saveSettings(DEFAULT_WEB_SEARCH_SETTINGS);
        notify(ctx, `Web search settings reset.\n\n${formatSettings(saved)}`);
        return;
      }

      case "default-mode": {
        const mode = parseMode(value);
        const saved = await saveSettings({ ...settings, defaultMode: mode });
        notify(ctx, `Default mode updated to ${saved.defaultMode}.`);
        return;
      }

      case "fast-freshness": {
        const freshness = parseFreshness(value);
        const saved = await saveSettings({ ...settings, fastFreshness: freshness });
        notify(ctx, `Fast freshness updated to ${saved.fastFreshness}.`);
        return;
      }

      case "deep-freshness": {
        const freshness = parseFreshness(value);
        const saved = await saveSettings({ ...settings, deepFreshness: freshness });
        notify(ctx, `Deep freshness updated to ${saved.deepFreshness}.`);
        return;
      }

      case "fast-max-sources": {
        const fastMaxSources = parseInteger(value, 1, MAX_ALLOWED_SOURCES, "fast max sources");
        const saved = await saveSettings({ ...settings, fastMaxSources });
        notify(ctx, `Fast max sources updated to ${saved.fastMaxSources}.`);
        return;
      }

      case "deep-max-sources": {
        const deepMaxSources = parseInteger(value, 1, MAX_ALLOWED_SOURCES, "deep max sources");
        const saved = await saveSettings({ ...settings, deepMaxSources });
        notify(ctx, `Deep max sources updated to ${saved.deepMaxSources}.`);
        return;
      }

      case "default-max-sources": {
        const maxSources = parseInteger(value, 1, MAX_ALLOWED_SOURCES, "default max sources");
        const saved = await saveSettings({
          ...settings,
          fastMaxSources: maxSources,
          deepMaxSources: maxSources,
        });
        notify(ctx, `Fast and deep max sources updated to ${saved.fastMaxSources}.`);
        return;
      }

      case "defuddle-mode": {
        const defuddleMode = parseDefuddleMode(value);
        const saved = await saveSettings({ ...settings, defuddleMode });
        notify(ctx, `Defuddle mode updated to ${saved.defuddleMode}.`);
        return;
      }

      case "fast-timeout-ms": {
        const fastTimeoutMs = parseTimeoutMs(value, "fast timeout");
        const saved = await saveSettings({ ...settings, fastTimeoutMs });
        notify(ctx, `Fast timeout updated to ${saved.fastTimeoutMs} ms.`);
        return;
      }

      case "deep-timeout-ms": {
        const deepTimeoutMs = parseTimeoutMs(value, "deep timeout");
        const saved = await saveSettings({ ...settings, deepTimeoutMs });
        notify(ctx, `Deep timeout updated to ${saved.deepTimeoutMs} ms.`);
        return;
      }

      case "defuddle-timeout-ms": {
        const defuddleTimeoutMs = parseTimeoutMs(value, "Defuddle timeout");
        const saved = await saveSettings({ ...settings, defuddleTimeoutMs });
        notify(ctx, `Defuddle timeout updated to ${saved.defuddleTimeoutMs} ms.`);
        return;
      }

      case "fast-query-budget": {
        const fastQueryBudget = parseQueryBudget(value, "fast query budget");
        const saved = await saveSettings({ ...settings, fastQueryBudget });
        notify(ctx, `Fast search-call budget updated to ${saved.fastQueryBudget}.`);
        return;
      }

      case "deep-query-budget": {
        const deepQueryBudget = parseQueryBudget(value, "deep query budget");
        const saved = await saveSettings({ ...settings, deepQueryBudget });
        notify(ctx, `Deep search-call budget updated to ${saved.deepQueryBudget}.`);
        return;
      }

      default:
        notify(ctx, buildSettingsHelp(settings));
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function openSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const settings = await loadSettings();
    const choice = await ctx.ui.select(
      "Web search settings\nChoose a group. Saved values apply when the tool call omits overrides.",
      [
        "Show current settings",
        `Search defaults → mode ${settings.defaultMode}, fast ${settings.fastFreshness}/${settings.fastMaxSources}, deep ${settings.deepFreshness}/${settings.deepMaxSources}`,
        `Defuddle behavior → ${settings.defuddleMode}`,
        `Timeouts → fast ${settings.fastTimeoutMs} ms, deep ${settings.deepTimeoutMs} ms, Defuddle ${settings.defuddleTimeoutMs} ms`,
        `Search-call budgets → fast ${settings.fastQueryBudget}, deep ${settings.deepQueryBudget}`,
        "Reset to defaults",
      ]
    );

    if (!choice) return;

    if (choice === "Show current settings") {
      await handleSettingsCommand("status", ctx);
      continue;
    }

    if (choice.startsWith("Search defaults")) {
      await openSearchDefaultsDialog(ctx);
      continue;
    }

    if (choice.startsWith("Defuddle behavior")) {
      await openDefuddleSettingsDialog(ctx);
      continue;
    }

    if (choice.startsWith("Timeouts")) {
      await openTimeoutSettingsDialog(ctx);
      continue;
    }

    if (choice.startsWith("Search-call budgets")) {
      await openQueryBudgetSettingsDialog(ctx);
      continue;
    }

    if (choice === "Reset to defaults") {
      await handleSettingsCommand("reset", ctx);
    }
  }
}

async function openSearchDefaultsDialog(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const settings = await loadSettings();
    const choice = await ctx.ui.select(
      "Search defaults\nUsed when the tool call omits mode, freshness, or maxSources.",
      [
        `Default mode → ${settings.defaultMode}`,
        `Fast freshness → ${settings.fastFreshness}`,
        `Deep freshness → ${settings.deepFreshness}`,
        `Fast max sources → ${settings.fastMaxSources}`,
        `Deep max sources → ${settings.deepMaxSources}`,
        "Back",
      ]
    );

    if (!choice || choice === "Back") return;

    if (choice.startsWith("Default mode")) {
      const mode = await ctx.ui.select("Default mode\nUsed when the tool call does not set mode.", [
        "fast — quick lookup",
        "deep — broader research",
      ]);
      if (!mode) continue;
      await handleSettingsCommand(`default-mode ${mode.startsWith("deep") ? "deep" : "fast"}`, ctx);
      continue;
    }

    if (choice.startsWith("Fast freshness")) {
      const freshness = await ctx.ui.select(
        "Fast freshness\nDefault freshness for fast searches when the tool call does not override it.",
        [
          "indexed — fast hosted index; recommended default",
          "cached — fastest, but may be stale",
          "live — freshest results for time-sensitive lookups",
        ]
      );
      if (!freshness) continue;
      await handleSettingsCommand(`fast-freshness ${parseFreshnessChoice(freshness)}`, ctx);
      continue;
    }

    if (choice.startsWith("Deep freshness")) {
      const freshness = await ctx.ui.select(
        "Deep freshness\nDefault freshness for deep research when the tool call does not override it.",
        [
          "indexed — use the hosted index",
          "cached — use cached search results",
          "live — prefer the freshest search results",
        ]
      );
      if (!freshness) continue;
      await handleSettingsCommand(`deep-freshness ${parseFreshnessChoice(freshness)}`, ctx);
      continue;
    }

    if (choice.startsWith("Fast max sources")) {
      const value = await ctx.ui.input(
        "Fast max sources\nDefault source cap for fast mode when the tool call omits maxSources.",
        String(settings.fastMaxSources)
      );
      if (!value) continue;
      await handleSettingsCommand(`fast-max-sources ${value}`, ctx);
      continue;
    }

    if (choice.startsWith("Deep max sources")) {
      const value = await ctx.ui.input(
        "Deep max sources\nDefault source cap for deep mode when the tool call omits maxSources.",
        String(settings.deepMaxSources)
      );
      if (!value) continue;
      await handleSettingsCommand(`deep-max-sources ${value}`, ctx);
    }
  }
}

async function openDefuddleSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const settings = await loadSettings();
    const choice = await ctx.ui.select(
      "Defuddle behavior\nControls direct URL extraction and optional single-URL fallback after Codex fails.",
      [`Mode → ${settings.defuddleMode}`, "Back"]
    );

    if (!choice || choice === "Back") return;

    const mode = await ctx.ui.select(
      "Choose the Defuddle mode\nDirect only affects URL-only queries. Fallback stays restricted to single-URL extraction-style requests.",
      [
        "off — never use Defuddle",
        "direct — use Defuddle immediately for URL-only queries",
        "fallback — only try Defuddle after Codex fails on supported extraction requests",
        "both — allow direct URL extraction and supported fallback",
      ]
    );

    if (!mode) continue;

    const nextMode = mode.startsWith("off")
      ? "off"
      : mode.startsWith("direct")
        ? "direct"
        : mode.startsWith("fallback")
          ? "fallback"
          : "both";
    await handleSettingsCommand(`defuddle-mode ${nextMode}`, ctx);
  }
}

async function openTimeoutSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const settings = await loadSettings();
    const choice = await ctx.ui.select(
      "Timeouts\nHow long each backend gets before the run is cancelled.",
      [
        `Fast timeout → ${settings.fastTimeoutMs} ms`,
        `Deep timeout → ${settings.deepTimeoutMs} ms`,
        `Defuddle timeout → ${settings.defuddleTimeoutMs} ms`,
        "Back",
      ]
    );

    if (!choice || choice === "Back") return;

    if (choice.startsWith("Fast timeout")) {
      const value = await ctx.ui.input(
        "Fast timeout (ms)\nShorter limits keep quick lookups snappy.",
        String(settings.fastTimeoutMs)
      );
      if (!value) continue;
      await handleSettingsCommand(`fast-timeout-ms ${value}`, ctx);
      continue;
    }

    if (choice.startsWith("Deep timeout")) {
      const value = await ctx.ui.input(
        "Deep timeout (ms)\nLonger limits give Codex more room for broader research.",
        String(settings.deepTimeoutMs)
      );
      if (!value) continue;
      await handleSettingsCommand(`deep-timeout-ms ${value}`, ctx);
      continue;
    }

    const value = await ctx.ui.input(
      "Defuddle timeout (ms)\nApplies only when Defuddle is used.",
      String(settings.defuddleTimeoutMs)
    );
    if (!value) continue;
    await handleSettingsCommand(`defuddle-timeout-ms ${value}`, ctx);
  }
}

async function openQueryBudgetSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const settings = await loadSettings();
    const choice = await ctx.ui.select(
      "Search-call budgets\nLimits how many web_search tool calls Codex can issue per run. Batched query strings count as one call.",
      [
        `Fast search-call budget → ${settings.fastQueryBudget}`,
        `Deep search-call budget → ${settings.deepQueryBudget}`,
        "Back",
      ]
    );

    if (!choice || choice === "Back") return;

    if (choice.startsWith("Fast search-call budget")) {
      const value = await ctx.ui.input(
        "Fast search-call budget\nCounts web_search tool calls, not query strings batched inside a call. Exceeding it fails the fast run for the rest of the turn.",
        String(settings.fastQueryBudget)
      );
      if (!value) continue;
      await handleSettingsCommand(`fast-query-budget ${value}`, ctx);
      continue;
    }

    const value = await ctx.ui.input(
      "Deep search-call budget\nCounts web_search tool calls, not batched query strings. Increase this only for deeper research loops.",
      String(settings.deepQueryBudget)
    );
    if (!value) continue;
    await handleSettingsCommand(`deep-query-budget ${value}`, ctx);
  }
}

function buildSettingsHelp(settings: WebSearchSettings): string {
  return [
    "Current web search settings:",
    formatSettings(settings),
    "",
    "Commands:",
    "Search defaults:",
    `/${SETTINGS_COMMAND} default-mode <fast|deep>`,
    `/${SETTINGS_COMMAND} fast-freshness <cached|indexed|live>`,
    `/${SETTINGS_COMMAND} deep-freshness <cached|indexed|live>`,
    `/${SETTINGS_COMMAND} fast-max-sources <1-${MAX_ALLOWED_SOURCES}>`,
    `/${SETTINGS_COMMAND} deep-max-sources <1-${MAX_ALLOWED_SOURCES}>`,
    `/${SETTINGS_COMMAND} default-max-sources <1-${MAX_ALLOWED_SOURCES}>  (legacy alias: sets both)`,
    "",
    "Defuddle behavior:",
    `/${SETTINGS_COMMAND} defuddle-mode <off|direct|fallback|both>`,
    "",
    "Timeouts:",
    `/${SETTINGS_COMMAND} fast-timeout-ms <${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}>`,
    `/${SETTINGS_COMMAND} deep-timeout-ms <${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}>`,
    `/${SETTINGS_COMMAND} defuddle-timeout-ms <${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}>`,
    "",
    "Search-call budgets (command names retained for compatibility):",
    `/${SETTINGS_COMMAND} fast-query-budget <${MIN_QUERY_BUDGET}-${MAX_QUERY_BUDGET}>`,
    `/${SETTINGS_COMMAND} deep-query-budget <${MIN_QUERY_BUDGET}-${MAX_QUERY_BUDGET}>`,
    "",
    `/${SETTINGS_COMMAND} status`,
    `/${SETTINGS_COMMAND} reset`,
  ].join("\n");
}

function splitArgs(args: string): [string, string] {
  const trimmed = args.trim();
  const separatorIndex = trimmed.indexOf(" ");
  if (separatorIndex === -1) {
    return [trimmed, ""];
  }
  return [trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1).trim()];
}

function parseMode(value: string): SearchMode {
  if (value === "fast" || value === "deep") {
    return value;
  }
  throw new Error(`Invalid mode: ${value}. Expected fast or deep.`);
}

function parseFreshness(value: string): SearchFreshness {
  if (value === "cached" || value === "indexed" || value === "live") {
    return value;
  }
  throw new Error(`Invalid freshness: ${value}. Expected cached, indexed, or live.`);
}

function parseFreshnessChoice(choice: string): SearchFreshness {
  return parseFreshness(choice.split(" ", 1)[0] ?? "");
}

function parseDefuddleMode(value: string): DefuddleMode {
  if (value === "off" || value === "direct" || value === "fallback" || value === "both") {
    return value;
  }
  throw new Error(`Invalid Defuddle mode: ${value}. Expected off, direct, fallback, or both.`);
}

function parseTimeoutMs(value: string, label: string): number {
  return parseInteger(value, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, label);
}

function parseQueryBudget(value: string, label: string): number {
  return parseInteger(value, MIN_QUERY_BUDGET, MAX_QUERY_BUDGET, label);
}

function parseInteger(value: string, min: number, max: number, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`Invalid ${label}: ${value}. Expected an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${label}: ${value}. Expected ${min}-${max}.`);
  }
  return parsed;
}

function notify(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warning" | "error" = "info"
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  console.log(message);
}

function hasRenderableResultDetails<T extends Partial<CodexWebSearchDetails>>(
  details: T | undefined
): details is T & CodexWebSearchDetails {
  return (
    !!details &&
    (details.mode === "fast" || details.mode === "deep") &&
    (details.freshness === "cached" ||
      details.freshness === "indexed" ||
      details.freshness === "live") &&
    typeof details.query === "string" &&
    typeof details.sourceCount === "number" &&
    typeof details.searchCount === "number" &&
    Array.isArray(details.searchQueries) &&
    (details.pageActions === undefined || Array.isArray(details.pageActions)) &&
    Array.isArray(details.statusEvents) &&
    Array.isArray(details.sources) &&
    typeof details.summary === "string" &&
    typeof details.truncated === "boolean"
  );
}

function renderProgress(
  details: WebSearchProgressDetails | undefined,
  expanded: boolean,
  theme: {
    fg: (color: "warning" | "dim" | "muted", text: string) => string;
  }
): string {
  const searchCount = details?.searchCount ?? 0;
  const searchCallCount = details?.searchCallCount ?? 0;
  const mode = details?.mode ?? "fast";
  const freshness = details?.freshness ?? "indexed";
  const statusText = details?.statusText ?? "Searching the web";
  const statusEvents = details?.statusEvents ?? [];
  const pageActions = details?.pageActions ?? [];

  let text = theme.fg("warning", statusText);
  const callBudget = details?.queryBudget !== undefined ? `/${details.queryBudget}` : "";
  const elapsed = details?.elapsedMs !== undefined ? ` · ${formatElapsed(details.elapsedMs)}` : "";
  text += theme.fg(
    "muted",
    ` [${mode}/${freshness}] · ${searchCount} ${searchCount === 1 ? "query" : "queries"} · ${searchCallCount}${callBudget} ${searchCallCount === 1 ? "call" : "calls"}${elapsed}`
  );

  if (!expanded) {
    text += theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`);
    if (statusEvents.length > 0) {
      text += `\n${theme.fg("dim", formatInlineQuery(statusEvents[statusEvents.length - 1], 110))}`;
    } else if (details?.latestQuery) {
      text += `\n${theme.fg("dim", `Latest: ${formatInlineQuery(details.latestQuery, 110)}`)}`;
    } else if (pageActions.length > 0) {
      text += `\n${theme.fg("dim", formatInlineQuery(pageActions[pageActions.length - 1], 110))}`;
    }
    return text;
  }

  if (statusEvents.length > 0) {
    text += `\n${theme.fg("muted", `Codex events (${statusEvents.length}):`)}`;
    for (const [index, status] of statusEvents.entries()) {
      text += `\n${theme.fg("dim", `  ${index + 1}. ${status}`)}`;
    }
  }

  if (details?.searchQueries.length) {
    text += `\n${theme.fg("muted", `Queries (${details.searchQueries.length}):`)}`;
    for (const [index, query] of details.searchQueries.entries()) {
      text += `\n${theme.fg("dim", `  ${index + 1}. ${query}`)}`;
    }
  }

  if (pageActions.length > 0) {
    text += `\n${theme.fg("muted", `Page actions (${pageActions.length}):`)}`;
    for (const [index, pageAction] of pageActions.entries()) {
      text += `\n${theme.fg("dim", `  ${index + 1}. ${pageAction}`)}`;
    }
  }

  if (
    !details ||
    (details.searchQueries.length === 0 && pageActions.length === 0 && statusEvents.length === 0)
  ) {
    text += `\n${theme.fg("dim", "Waiting for Codex to emit search activity...")}`;
  }

  return text;
}

function formatFailureLabel(failure: CodexFailureDetails): string {
  switch (failure.kind) {
    case "transport":
      return "Web search transport issue";
    case "rate_limit":
      return "Web search rate-limited";
    case "timeout":
      return "Web search timed out";
    case "budget":
      return "Web search budget exhausted";
    case "schema":
    case "empty_result":
      return "Web search returned no usable result";
    case "auth":
      return "Web search authentication issue";
    default:
      return "Web search degraded";
  }
}

function formatRetrySummary(retry: RetryProvenance): string {
  if (
    /reconnect|reconnecting|websocket|transport|stream disconnected|connection|network|\b5\d\d\b/i.test(
      retry.fallbackReason
    )
  ) {
    return `Retried as deep/live after fast/${retry.originalFreshness} lost its Codex transport`;
  }

  return `Retried as deep/live after fast/${retry.originalFreshness} hit a transient failure`;
}

function looksLikeFailureText(text: string): boolean {
  return /\b(failed|timed out|exceeded|error|could not|invalid|missing|cancelled|authentication|skipped)\b/i.test(
    text
  );
}

function formatToolOutput(
  text: string,
  theme: {
    fg: (color: "toolOutput", text: string) => string;
  }
): string {
  return text
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatInlineQuery(query: unknown, maxLength = 90): string {
  const text = typeof query === "string" ? query.trim() : "";
  if (!text) return "…";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
