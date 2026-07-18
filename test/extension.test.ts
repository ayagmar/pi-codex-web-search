import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexWebSearchExtension from "../src/index.js";
import { SETTINGS_COMMAND, TOOL_NAME } from "../src/constants.js";

interface CapturedToolResult {
  content: { type: "text"; text: string }[];
  details?: unknown;
}

type CapturedToolExecute = (
  toolCallId: string,
  params: { query: string },
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  context: { cwd: string }
) => Promise<CapturedToolResult>;

interface CapturedExtension {
  toolName?: string;
  toolDescription?: string;
  toolExecute?: CapturedToolExecute;
  commandName?: string;
  commandDescription?: string;
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  return {
    on: () => undefined,
    registerTool: (tool: { name: string; description: string; execute: CapturedToolExecute }) => {
      captured.toolName = tool.name;
      captured.toolDescription = tool.description;
      captured.toolExecute = tool.execute;
    },
    registerCommand: (name: string, command: { description: string }) => {
      captured.commandName = name;
      captured.commandDescription = command.description;
    },
  } as unknown as ExtensionAPI;
}

void test("extension registers the web_search tool and settings command", () => {
  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));

  assert.equal(captured.toolName, TOOL_NAME);
  assert.match(captured.toolDescription ?? "", /Codex CLI/);
  assert.match(captured.toolDescription ?? "", /Never issue multiple web_search calls in parallel/);
  assert.equal(captured.commandName, SETTINGS_COMMAND);
  assert.match(
    captured.commandDescription ?? "",
    /defaults, budgets, timeouts, and Defuddle behavior/
  );
});

void test("extension skips differing sibling web searches while one is active", async () => {
  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));
  assert.ok(captured.toolExecute);

  const context = { cwd: process.cwd() };
  const firstSearch = captured.toolExecute(
    "search-1",
    { query: "   " },
    undefined,
    undefined,
    context
  );
  const siblingResult = await captured.toolExecute(
    "search-2",
    { query: "related follow-up search" },
    undefined,
    undefined,
    context
  );

  const siblingDetails = siblingResult.details as {
    concurrentSearchSkipped?: boolean;
  };
  assert.equal(siblingDetails.concurrentSearchSkipped, true);
  assert.match(siblingResult.content[0]?.text ?? "", /Skipped this concurrent web search/);
  await assert.rejects(firstSearch, /non-empty query/);
});

void test("extension coalesces identical concurrent web searches onto one run", async () => {
  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));
  assert.ok(captured.toolExecute);

  const context = { cwd: process.cwd() };
  // Blank queries reject inside executeCodexWebSearch; identical siblings
  // must share that same rejection instead of being skipped.
  const first = captured.toolExecute("search-1", { query: "   " }, undefined, undefined, context);
  const second = captured.toolExecute("search-2", { query: "   " }, undefined, undefined, context);

  await assert.rejects(first, /non-empty query/);
  await assert.rejects(second, /non-empty query/);
});
