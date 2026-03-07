import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_LABEL,
  EXTENSION_COMMAND,
  EXTENSION_NAME,
  STATE_ENTRY_TYPE,
  TOOL_NAME,
} from "./constants.js";
import { buildHelpText, parseSubcommand } from "./commands.js";
import { buildEchoText } from "./tool.js";
import type { ExtensionState } from "./types.js";

export default function extensionTemplate(pi: ExtensionAPI) {
  let state: ExtensionState = { label: DEFAULT_LABEL };

  function syncState(ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">): void {
    state = restoreFromContext(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXTENSION_COMMAND, `${EXTENSION_NAME}: ${state.label}`);
    }
  }

  pi.on("session_start", (_event, ctx) => syncState(ctx));
  pi.on("session_switch", (_event, ctx) => syncState(ctx));
  pi.on("session_tree", (_event, ctx) => syncState(ctx));
  pi.on("session_fork", (_event, ctx) => syncState(ctx));

  pi.registerCommand(EXTENSION_COMMAND, {
    description: "Starter command for your extension",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "set-label", "help"];
      const safePrefix = prefix.toLowerCase();
      const matches = options.filter((option) => option.startsWith(safePrefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: (args, ctx): Promise<void> => {
      const { name, rest } = parseSubcommand(args);

      switch (name) {
        case "status":
          notify(ctx, `Label: ${state.label}`);
          return Promise.resolve();

        case "set-label": {
          if (!rest) {
            notify(ctx, buildHelpText());
            return Promise.resolve();
          }
          state = { label: rest };
          pi.appendEntry(STATE_ENTRY_TYPE, state);
          if (ctx.hasUI) {
            ctx.ui.setStatus(EXTENSION_COMMAND, `${EXTENSION_NAME}: ${state.label}`);
          }
          notify(ctx, `Label updated to: ${state.label}`);
          return Promise.resolve();
        }

        default:
          notify(ctx, buildHelpText());
          return Promise.resolve();
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Echo",
    description: "Echo text back to the model. Safe default tool for template projects.",
    parameters: Type.Object({
      message: Type.String({ description: "Text to echo back" }),
      uppercase: Type.Optional(Type.Boolean({ description: "Return the message in upper case" })),
    }),
    execute(_toolCallId, params) {
      const text = buildEchoText(params);
      return Promise.resolve({
        content: [{ type: "text", text }],
        details: { length: text.length },
      });
    },
  });
}

/** Notify via TUI when available, otherwise console. */
function notify(
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info") => void } },
  message: string
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "info");
  } else {
    console.log(message);
  }
}

function restoreFromContext(ctx: Pick<ExtensionContext, "sessionManager">): ExtensionState {
  return restoreState(ctx.sessionManager.getBranch()) ?? { label: DEFAULT_LABEL };
}

function restoreState(
  entries: { type?: string; customType?: string; data?: unknown }[]
): ExtensionState | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    if (isExtensionState(entry.data)) return entry.data;
  }
  return undefined;
}

function isExtensionState(value: unknown): value is ExtensionState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { label?: unknown }).label === "string"
  );
}
