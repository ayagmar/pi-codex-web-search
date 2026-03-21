import { StringEnum } from "@mariozechner/pi-ai";
import {
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { executeCodexWebSearch } from "./codex.js";
import { SETTINGS_COMMAND, TOOL_NAME } from "./constants.js";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  formatSettings,
  loadSettings,
  saveSettings,
} from "./settings.js";
import type {
  CodexWebSearchDetails,
  ExecuteCodexWebSearchOptions,
  SearchFreshness,
  SearchMode,
  WebSearchProgressDetails,
  WebSearchSettings,
  WebSearchTurnState,
} from "./types.js";

const SETTINGS_ARGUMENT_OPTIONS = [
  "status",
  "reset",
  "default-mode fast",
  "default-mode deep",
  "fast-freshness cached",
  "fast-freshness live",
  "deep-freshness cached",
  "deep-freshness live",
] as const;

export default function codexWebSearchExtension(pi: ExtensionAPI) {
  const turnState: WebSearchTurnState = { fastModeExhausted: false };
  const resetTurnState = (): void => {
    turnState.fastModeExhausted = false;
  };

  pi.on("turn_start", resetTurnState);
  pi.on("turn_end", resetTurnState);
  pi.on("agent_end", resetTurnState);

  pi.registerTool({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      "Search the public web through the locally installed Codex CLI and return a concise summary with sources. Use fast mode for quick factual lookups and deep mode only when the user explicitly wants broader research. Freshness can be cached or live, with live preferred for clearly time-sensitive requests. The tool can automatically recover one retryable default fast search by rerunning it as deep/live and records that retry in the tool details. Defaults are configurable via /web-search-settings. Output is truncated to Pi's standard limits when needed. Requires `codex` to be installed and authenticated on this machine.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for on the web" }),
      maxSources: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: "Maximum number of sources to include in the result (default: 5)",
        })
      ),
      mode: Type.Optional(
        StringEnum(["fast", "deep"] as const, {
          description:
            "Search depth. Use fast for simple lookups. Use deep only when the user explicitly asks for broader research.",
        })
      ),
      freshness: Type.Optional(
        StringEnum(["cached", "live"] as const, {
          description:
            "Freshness override. Use live for time-sensitive questions like today, latest, score, result, or weather.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const options: ExecuteCodexWebSearchOptions = {
        cwd: ctx.cwd,
        settings: await loadSettings(),
        turnState,
      };

      if (signal) options.signal = signal;
      if (onUpdate) options.onUpdate = onUpdate;

      return executeCodexWebSearch(params, options);
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

      const details = result.details as Partial<CodexWebSearchDetails> | undefined;
      if (!hasRenderableResultDetails(details)) {
        const content = result.content.find((part) => part.type === "text");
        if (content?.type === "text" && expanded) {
          return new Text(
            `${theme.fg("success", "✓ Web search finished")}\n\n${formatToolOutput(content.text, theme)}`,
            0,
            0
          );
        }
        return new Text(theme.fg("success", "✓ Web search finished"), 0, 0);
      }

      let text = theme.fg(
        "success",
        `✓ ${details.sourceCount} source${details.sourceCount === 1 ? "" : "s"}`
      );
      text += theme.fg(
        "muted",
        ` from ${details.searchCount} search${details.searchCount === 1 ? "" : "es"} [${details.mode}/${details.freshness}]`
      );

      if (details.truncated) {
        text += theme.fg("warning", " (truncated)");
      }

      if (details.retry) {
        text += theme.fg("warning", " (retried)");
      }

      if (!expanded) {
        text += theme.fg("dim", ` (${keyHint("expandTools", "to expand")})`);
        if (details.latestQuery) {
          text += `\n${theme.fg("dim", `Last query: ${formatInlineQuery(details.latestQuery, 110)}`)}`;
        }
        return new Text(text, 0, 0);
      }

      text += `\n${theme.fg("muted", `Original request: ${details.query}`)}`;
      if (details.retry) {
        text += `\n${theme.fg("warning", `Retried after ${details.retry.originalMode}/${details.retry.originalFreshness} failed`)}`;
        text += `\n${theme.fg("dim", details.retry.fallbackReason)}`;
      }
      if (details.searchQueries.length > 0) {
        text += `\n${theme.fg("muted", `Queries (${details.searchQueries.length}):`)}`;
        for (const [index, query] of details.searchQueries.entries()) {
          text += `\n${theme.fg("dim", `  ${index + 1}. ${query}`)}`;
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
    description: "Configure default mode and freshness for the web_search tool",
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

      default:
        notify(ctx, buildSettingsHelp(settings));
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function openSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  const settings = await loadSettings();
  const choice = await ctx.ui.select("Web search settings", [
    "Show current settings",
    `Default mode: ${settings.defaultMode}`,
    `Fast freshness: ${settings.fastFreshness}`,
    `Deep freshness: ${settings.deepFreshness}`,
    "Reset to defaults",
  ]);

  if (!choice) return;

  switch (choice) {
    case "Show current settings":
      await handleSettingsCommand("status", ctx);
      return;

    case `Default mode: ${settings.defaultMode}`: {
      const mode = await ctx.ui.select("Choose the default mode", ["fast", "deep"]);
      if (!mode) return;
      await handleSettingsCommand(`default-mode ${mode}`, ctx);
      return;
    }

    case `Fast freshness: ${settings.fastFreshness}`: {
      const freshness = await ctx.ui.select("Choose fast-mode freshness", ["cached", "live"]);
      if (!freshness) return;
      await handleSettingsCommand(`fast-freshness ${freshness}`, ctx);
      return;
    }

    case `Deep freshness: ${settings.deepFreshness}`: {
      const freshness = await ctx.ui.select("Choose deep-mode freshness", ["cached", "live"]);
      if (!freshness) return;
      await handleSettingsCommand(`deep-freshness ${freshness}`, ctx);
      return;
    }

    case "Reset to defaults":
      await handleSettingsCommand("reset", ctx);
      return;
  }
}

function buildSettingsHelp(settings: WebSearchSettings): string {
  return [
    "Current web search settings:",
    formatSettings(settings),
    "",
    `Commands:`,
    `/${SETTINGS_COMMAND} status`,
    `/${SETTINGS_COMMAND} default-mode <fast|deep>`,
    `/${SETTINGS_COMMAND} fast-freshness <cached|live>`,
    `/${SETTINGS_COMMAND} deep-freshness <cached|live>`,
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
  if (value === "cached" || value === "live") {
    return value;
  }
  throw new Error(`Invalid freshness: ${value}. Expected cached or live.`);
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

function hasRenderableResultDetails(
  details: Partial<CodexWebSearchDetails> | undefined
): details is CodexWebSearchDetails {
  return (
    !!details &&
    (details.mode === "fast" || details.mode === "deep") &&
    (details.freshness === "cached" || details.freshness === "live") &&
    typeof details.query === "string" &&
    typeof details.sourceCount === "number" &&
    typeof details.searchCount === "number" &&
    Array.isArray(details.searchQueries) &&
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
  const mode = details?.mode ?? "fast";
  const freshness = details?.freshness ?? "cached";
  let text = theme.fg(
    "warning",
    `Searching the web [${mode}/${freshness}] · ${searchCount} ${searchCount === 1 ? "query" : "queries"} so far`
  );

  if (!expanded) {
    text += theme.fg("dim", ` (${keyHint("expandTools", "to expand")})`);
    if (details?.latestQuery) {
      text += `\n${theme.fg("dim", `Latest: ${formatInlineQuery(details.latestQuery, 110)}`)}`;
    }
    return text;
  }

  if (!details || details.searchQueries.length === 0) {
    text += `\n${theme.fg("dim", "Waiting for Codex to emit search queries...")}`;
    return text;
  }

  text += `\n${theme.fg("muted", "Queries:")}`;
  for (const [index, query] of details.searchQueries.entries()) {
    text += `\n${theme.fg("dim", `  ${index + 1}. ${query}`)}`;
  }
  return text;
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

function formatInlineQuery(query: unknown, maxLength = 90): string {
  const text = typeof query === "string" ? query.trim() : "";
  if (!text) return "…";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
