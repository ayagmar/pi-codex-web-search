import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

type CapturedCommandHandler = (args: string, ctx: unknown) => Promise<void>;

interface CapturedExtension {
  toolName?: string;
  toolDescription?: string;
  toolPromptSnippet?: string;
  toolPromptGuidelines?: string[];
  toolExecute?: CapturedToolExecute;
  commandName?: string;
  commandDescription?: string;
  commandHandler?: CapturedCommandHandler;
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
    registerTool: (tool: {
      name: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      execute: CapturedToolExecute;
    }) => {
      captured.toolName = tool.name;
      captured.toolDescription = tool.description;
      if (tool.promptSnippet !== undefined) captured.toolPromptSnippet = tool.promptSnippet;
      if (tool.promptGuidelines !== undefined)
        captured.toolPromptGuidelines = tool.promptGuidelines;
      captured.toolExecute = tool.execute;
    },
    registerCommand: (
      name: string,
      command: { description: string; handler: CapturedCommandHandler }
    ) => {
      captured.commandName = name;
      captured.commandDescription = command.description;
      captured.commandHandler = command.handler;
    },
  } as unknown as ExtensionAPI;
}

void test("extension registers the web_search tool and settings command", () => {
  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));

  assert.equal(captured.toolName, TOOL_NAME);
  assert.match(captured.toolDescription ?? "", /Codex CLI/);
  assert.match(captured.toolDescription ?? "", /Never issue multiple web_search calls in parallel/);
  // Without a snippet pi 1.0 leaves the tool out of the system prompt's tool list.
  assert.match(captured.toolPromptSnippet ?? "", /Codex CLI/);
  assert.ok(
    captured.toolPromptGuidelines?.some((line) => /one web_search call at a time/.test(line))
  );
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
  const overrides = {
    PI_CODEX_WEB_SEARCH_CODEX_PATH: command,
    // Keep the user's real web search settings out of the test.
    PI_CODING_AGENT_DIR: dir,
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]] as const)
  );
  Object.assign(process.env, overrides);
  return {
    dir,
    restore: async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

async function captureOutput(
  run: () => Promise<void>
): Promise<{ stdout: string; stderr: string }> {
  const output = { stdout: "", stderr: "" };
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return output;
}

void test("settings command output without a UI goes to stderr, never stdout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));
  const handler = captured.commandHandler;
  assert.ok(handler);
  const noUi = { notify: () => assert.fail("no UI is available") };

  const json = await captureOutput(() =>
    handler("status", { hasUI: false, mode: "json", ui: noUi, cwd: dir })
  );
  assert.equal(json.stdout, "");
  assert.match(json.stderr, /Current web search settings/);

  const print = await captureOutput(() =>
    handler("status", { hasUI: false, mode: "print", ui: noUi, cwd: dir })
  );
  assert.equal(print.stdout, "");
  assert.match(print.stderr, /Current web search settings/);

  const printError = await captureOutput(() =>
    handler("default-mode turbo", { hasUI: false, mode: "print", ui: noUi, cwd: dir })
  );
  assert.equal(printError.stdout, "");
  assert.match(printError.stderr, /Invalid mode: turbo/);
});

void test("settings commands refuse to overwrite a settings file with invalid JSON", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const settingsPath = join(dir, "pi-codex-web-search.settings.json");
  const broken = '{ "fastMaxSources": 9, "deepMaxSources": 8 ';
  await writeFile(settingsPath, broken, "utf-8");

  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));
  const handler = captured.commandHandler;
  assert.ok(handler);
  const notifications: { message: string; level: string }[] = [];
  const ctx = {
    hasUI: true,
    cwd: dir,
    ui: {
      notify: (message: string, level = "info") => notifications.push({ message, level }),
    },
  };

  await handler("default-mode deep", ctx);
  assert.equal(await readFile(settingsPath, "utf-8"), broken);
  assert.equal(notifications.at(-1)?.level, "error");
  assert.match(notifications.at(-1)?.message ?? "", /not valid JSON[\s\S]*reset/);

  await handler("status", ctx);
  assert.equal(notifications.at(-1)?.level, "error");

  await handler("reset", ctx);
  assert.equal(notifications.at(-1)?.level, "info");
  assert.equal(JSON.parse(await readFile(settingsPath, "utf-8")).fastMaxSources, 5);
});
