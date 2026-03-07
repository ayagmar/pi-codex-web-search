import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

export default function hybridExtension(pi: ExtensionAPI) {
  let active = true;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("myext", "hybrid starter loaded");
    }
  });

  pi.registerCommand("myext", {
    description: "Show starter status or toggle active mode",
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase()) {
        case "toggle":
          active = !active;
          notify(ctx, `Hybrid active: ${active}`);
          return;

        case "reset": {
          if (ctx.hasUI) {
            const ok = await ctx.ui.confirm("Reset state", "Set active mode back to true?");
            if (!ok) return;
          }
          active = true;
          notify(ctx, "Hybrid state reset");
          return;
        }

        default:
          notify(ctx, "Usage: /myext toggle | reset");
      }
    },
  });

  pi.registerTool({
    name: "myext_echo",
    label: "Echo",
    description: "Echo text back to the model.",
    parameters: Type.Object({
      message: Type.String(),
      // Use StringEnum for string enums — required for Google compatibility.
      // Type.Union / Type.Literal won't work with Google's API.
      format: Type.Optional(
        StringEnum(["plain", "json"] as const, { description: "Output format" })
      ),
    }),
    execute(_toolCallId, params) {
      const suffix = active ? "" : " (extension inactive)";
      const body = `${params.message}${suffix}`;
      const text = params.format === "json" ? JSON.stringify({ echo: body }) : body;
      return Promise.resolve({
        content: [{ type: "text", text }],
        details: { active, format: params.format ?? "plain" },
      });
    },
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "Show hybrid starter status",
    handler: (ctx) => {
      notify(ctx, `Hybrid starter active=${active}`);
      return Promise.resolve();
    },
  });
}

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
