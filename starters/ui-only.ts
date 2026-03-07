import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "myext";

export default function uiOnlyExtension(pi: ExtensionAPI) {
  let turnCount = 0;

  // Status line: persistent text in the footer bar
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, "Ready");

    // Widget: a line above (or below) the editor
    ctx.ui.setWidget("myext-hint", ["Tip: use /myext to open the dashboard"]);
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    turnCount++;
    ctx.ui.setStatus(STATUS_KEY, `Turn ${turnCount}…`);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, `Turn ${turnCount} ✓`);
  });

  // Command that opens a custom UI component via ctx.ui.custom().
  // custom() replaces the editor with your component until done() is called.
  pi.registerCommand("myext", {
    description: "Open a small dashboard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, `Turns: ${turnCount}`);
        return;
      }

      // ctx.ui.custom<T> returns the value passed to done(value).
      // The callback receives (tui, theme, keybindings, done).
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        // Return any object with render(), invalidate(), and optionally handleInput().
        const lines = [
          "",
          theme.fg("accent", theme.bold("  Extension Dashboard")),
          "",
          `  Turns completed: ${theme.fg("success", String(turnCount))}`,
          "",
          theme.fg("dim", "  Press Escape to close"),
          "",
        ];

        return {
          render(_width: number) {
            return lines;
          },
          invalidate() {
            // nothing to invalidate — content is static
          },
          handleInput(data: string) {
            if (data === "\x1b") done(); // Escape key
          },
        };
      });
    },
  });

  // Shortcut to quickly check turn count
  pi.registerShortcut("ctrl+shift+m", {
    description: "Show turn count",
    handler: (ctx) => {
      notify(ctx, `Turns: ${turnCount}`);
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
