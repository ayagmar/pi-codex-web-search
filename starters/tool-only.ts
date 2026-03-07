import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

export default function toolOnlyExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "myext_echo",
    label: "Echo",
    description: "Echo text back to the model.",
    parameters: Type.Object({
      message: Type.String({ description: "Text to echo" }),
      uppercase: Type.Optional(Type.Boolean({ description: "Uppercase output" })),
      // Use StringEnum for string enums — required for Google compatibility.
      // Type.Union / Type.Literal won't work with Google's API.
      style: Type.Optional(
        StringEnum(["plain", "quoted", "bracketed"] as const, {
          description: "Output style",
        })
      ),
    }),

    execute(_toolCallId, params) {
      let text = params.uppercase ? params.message.toUpperCase() : params.message;

      if (params.style === "quoted") {
        text = `"${text}"`;
      } else if (params.style === "bracketed") {
        text = `[${text}]`;
      }

      return Promise.resolve({
        content: [{ type: "text", text }],
        details: { length: text.length, style: params.style ?? "plain" },
      });
    },

    // Custom rendering — controls how the tool appears in the TUI.
    // Return a Text component with (0, 0) padding; the outer Box handles padding.
    renderCall(args, theme) {
      let line = theme.fg("toolTitle", theme.bold("Echo "));
      line += theme.fg("muted", args.message ?? "");
      if (args.uppercase) {
        line += theme.fg("dim", " (uppercase)");
      }
      if (args.style && args.style !== "plain") {
        line += theme.fg("dim", ` [${args.style}]`);
      }
      return new Text(line, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      let line = theme.fg("success", "✓ ") + text;

      if (expanded && result.details) {
        line += "\n" + theme.fg("dim", `  length=${result.details.length}`);
        line += theme.fg("dim", ` style=${result.details.style}`);
      }

      return new Text(line, 0, 0);
    },
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "myext_echo") {
      return;
    }

    const joined = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

    if (joined.length <= 200) {
      return;
    }

    return {
      content: [{ type: "text", text: `${joined.slice(0, 199)}…` }],
      details: {
        truncated: true,
      },
    };
  });
}
