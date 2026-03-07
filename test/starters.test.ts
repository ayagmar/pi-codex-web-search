import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import eventOnly from "../starters/event-only.js";
import toolOnly from "../starters/tool-only.js";
import commandOnly from "../starters/command-only.js";
import hybrid from "../starters/hybrid.js";
import uiOnly from "../starters/ui-only.js";

interface RegisteredCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface RegisteredShortcut {
  handler: (ctx: unknown) => Promise<void>;
}

interface Harness {
  pi: ExtensionAPI;
  eventHandlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
  commands: Map<string, RegisteredCommand>;
  tools: Map<string, RegisteredTool>;
  shortcuts: Map<string, RegisteredShortcut>;
}

void test("event-only starter blocks dangerous bash and redacts tool results", async () => {
  const harness = createHarness();
  eventOnly(harness.pi);

  const toolCall = harness.eventHandlers.get("tool_call")?.[0];
  const toolResult = harness.eventHandlers.get("tool_result")?.[0];

  assert.ok(toolCall);
  assert.ok(toolResult);

  const blocked = await toolCall?.(
    { toolName: "bash", input: { command: "rm -rf /tmp/demo" } },
    createContext(false)
  );

  assert.deepEqual(blocked, { block: true, reason: "Blocked by starter safety policy" });

  const redacted = toolResult?.(
    {
      toolName: "bash",
      content: [{ type: "text", text: "API_KEY=supersecret" }],
      details: {},
    },
    createContext(false)
  ) as { content: { type: string; text: string }[] };

  assert.match(redacted.content[0]?.text ?? "", /API_KEY=\*\*\*/);
});

void test("tool-only starter registers tool and truncates long tool result", async () => {
  const harness = createHarness();
  toolOnly(harness.pi);

  const tool = harness.tools.get("myext_echo");
  const toolResult = harness.eventHandlers.get("tool_result")?.[0];

  assert.ok(tool);
  assert.ok(toolResult);

  const result = (await tool?.execute("call-1", { message: "hello", uppercase: true })) as {
    content: { type: string; text: string }[];
  };
  assert.equal(result.content[0]?.text, "HELLO");

  const longText = "x".repeat(300);
  const truncated = toolResult?.(
    {
      toolName: "myext_echo",
      content: [{ type: "text", text: longText }],
      details: {},
    },
    createContext(false)
  ) as { content: { type: string; text: string }[]; details: { truncated: boolean } };

  assert.equal(truncated.details.truncated, true);
  assert.equal((truncated.content[0]?.text ?? "").length, 200);
});

void test("command-only starter command updates status and supports UI mode picker", async () => {
  const harness = createHarness();
  commandOnly(harness.pi);

  const command = harness.commands.get("myext");
  assert.ok(command);

  const ctx = createContext(true, "enabled");
  await command?.handler("disable", ctx);
  await command?.handler("status", ctx);
  await command?.handler("mode", ctx);
  await command?.handler("status", ctx);

  assert.ok(ctx.notifications.some((line) => line.includes("Extension disabled")));
  assert.ok(ctx.notifications.some((line) => line.includes("Enabled: false")));
  assert.ok(ctx.notifications.some((line) => line.includes("Mode set to: enabled")));
  assert.ok(ctx.notifications.some((line) => line.includes("Enabled: true")));
});

void test("hybrid starter registers command/tool/shortcut and command affects tool output", async () => {
  const harness = createHarness();
  hybrid(harness.pi);

  const command = harness.commands.get("myext");
  const tool = harness.tools.get("myext_echo");
  const shortcut = harness.shortcuts.get("ctrl+shift+m");

  assert.ok(command);
  assert.ok(tool);
  assert.ok(shortcut);

  const ctx = createContext(true);
  await command?.handler("toggle", ctx);
  const result = (await tool?.execute("call-2", { message: "hello" })) as {
    content: { type: string; text: string }[];
  };

  assert.match(result.content[0]?.text ?? "", /extension inactive/);

  await shortcut?.handler(ctx);
  assert.ok(ctx.notifications.some((line) => line.includes("Hybrid starter active=false")));
});

void test("ui-only starter registers command/shortcut and tracks events", () => {
  const harness = createHarness();
  uiOnly(harness.pi);

  const command = harness.commands.get("myext");
  const shortcut = harness.shortcuts.get("ctrl+shift+m");
  const sessionStart = harness.eventHandlers.get("session_start");
  const turnStart = harness.eventHandlers.get("turn_start");
  const turnEnd = harness.eventHandlers.get("turn_end");

  assert.ok(command);
  assert.ok(shortcut);
  assert.ok(sessionStart);
  assert.ok(turnStart);
  assert.ok(turnEnd);
});

function createHarness(): Harness {
  const eventHandlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const shortcuts = new Map<string, RegisteredShortcut>();

  const pi = {
    on: (eventName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = eventHandlers.get(eventName) ?? [];
      list.push(handler);
      eventHandlers.set(eventName, list);
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    registerShortcut: (name: string, shortcut: RegisteredShortcut) => {
      shortcuts.set(name, shortcut);
    },
  } as unknown as ExtensionAPI;

  return { pi, eventHandlers, commands, tools, shortcuts };
}

function createContext(hasUI: boolean, selectValue?: string) {
  const notifications: string[] = [];

  return {
    hasUI,
    notifications,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      confirm: () => Promise.resolve(false),
      select: () => Promise.resolve(selectValue),
    },
  };
}
