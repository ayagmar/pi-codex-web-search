import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "myext";

export default function eventOnlyExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, "event-only extension loaded");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") {
      return;
    }

    const command = String((event.input as { command?: string }).command ?? "");
    const dangerous = command.includes("rm -rf") || command.includes("sudo rm");
    if (!dangerous) {
      return;
    }

    if (!ctx.hasUI) {
      return { block: true, reason: "Blocked by starter safety policy" };
    }

    const approved = await ctx.ui.confirm("Dangerous command", `Allow:\n${command}`);
    if (!approved) {
      return { block: true, reason: "Rejected by user" };
    }

    return;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") {
      return;
    }

    const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

    if (!text.includes("API_KEY=")) {
      return;
    }

    return {
      content: [{ type: "text", text: text.replace(/API_KEY=[^\s]+/g, "API_KEY=***") }],
    };
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "Show event-only starter status",
    handler: (ctx) => {
      notify(ctx, "Event-only starter active");
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
