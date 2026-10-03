import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SETTINGS_COMMAND, TOOL_NAME } from "../src/constants.js";
import codexWebSearchExtension from "../src/index.js";

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
  handlers?: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
}

async function emit(captured: CapturedExtension, event: string, payload: object): Promise<void> {
  for (const handler of captured.handlers?.get(event) ?? []) {
    await handler({ type: event, ...payload }, {});
  }
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  return {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      captured.handlers ??= new Map();
      const handlers = captured.handlers.get(event) ?? [];
      handlers.push(handler);
      captured.handlers.set(event, handlers);
      return () => undefined;
    },
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

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A stand-in `codex` that never answers, so a search stays in flight until it
// is aborted.
async function installHangingCodex(): Promise<{ dir: string; restore: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-fake-codex-"));
  const command = join(dir, "codex");
  await writeFile(command, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const previous = process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
  process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = command;
  return {
    dir,
    restore: async () => {
      if (previous === undefined) delete process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
      else process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

void test("a skipped sibling call does not steal the running search's signal or progress", {
  skip: process.platform === "win32",
}, async (t) => {
  const fake = await installHangingCodex();
  t.after(fake.restore);

  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));
  assert.ok(captured.toolExecute);

  const context = { cwd: fake.dir };
  const firstController = new AbortController();
  const firstUpdates: unknown[] = [];
  const siblingUpdates: unknown[] = [];

  const first = captured.toolExecute(
    "search-1",
    { query: "first question" },
    firstController.signal,
    (update) => firstUpdates.push(update),
    context
  );
  const sibling = await captured.toolExecute(
    "search-2",
    { query: "a different question" },
    new AbortController().signal,
    (update) => siblingUpdates.push(update),
    context
  );
  assert.equal(
    (sibling.details as { concurrentSearchSkipped?: boolean }).concurrentSearchSkipped,
    true
  );

  await waitFor(() => firstUpdates.length > 0);
  firstController.abort(new Error("user cancelled the first search"));

  await assert.rejects(first, /cancelled/);
  assert.equal(siblingUpdates.length, 0);
});

void test("session_shutdown cancels an in-flight search", {
  skip: process.platform === "win32",
}, async (t) => {
  const fake = await installHangingCodex();
  t.after(fake.restore);

  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));
  assert.ok(captured.toolExecute);

  const updates: unknown[] = [];
  const search = captured.toolExecute(
    "search-1",
    { query: "long running question" },
    new AbortController().signal,
    (update) => updates.push(update),
    { cwd: fake.dir }
  );

  await waitFor(() => updates.length > 0);
  await emit(captured, "session_shutdown", { reason: "quit" });
  // Shutdown handlers must be idempotent.
  await emit(captured, "session_shutdown", { reason: "quit" });

  await assert.rejects(search, /session ended/);
});
