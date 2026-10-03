import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  executeCodexWebSearch,
  formatWebSearchResult,
  getInactivityFailure,
  isLiveFreshnessQuery,
  normalizeMaxSources,
  normalizeQuery,
  parseCodexWebSearchOutput,
  resolveSearchFreshness,
  resolveSearchMode,
} from "../src/codex.js";
import {
  appendBounded,
  findBundledCodexExecutable,
  MAX_CAPTURED_STDERR_BYTES,
  MAX_CAPTURED_STDOUT_BYTES,
  runCodexCommand,
} from "../src/codex-command.js";
import { DEFAULT_FAST_MAX_SOURCES, MAX_ALLOWED_SOURCES } from "../src/constants.js";
import {
  extractUrlsFromText,
  getDirectUrlQuery,
  getScriptRuntimeEnv,
  runDefuddleCommand,
} from "../src/defuddle.js";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../src/settings.js";
import { type RunCodexCommand, type RunDefuddleCommand } from "../src/types.js";

void test("normalizeMaxSources clamps values into the supported range", () => {
  assert.equal(normalizeMaxSources(undefined), DEFAULT_FAST_MAX_SOURCES);
  assert.equal(normalizeMaxSources(Number.NaN), DEFAULT_FAST_MAX_SOURCES);
  assert.equal(normalizeMaxSources(undefined, 999), MAX_ALLOWED_SOURCES);
  assert.equal(normalizeMaxSources(undefined, 0), 1);
  assert.equal(normalizeMaxSources(0), 1);
  assert.equal(normalizeMaxSources(3.9), 3);
  assert.equal(normalizeMaxSources(999), MAX_ALLOWED_SOURCES);
});

void test("normalizeQuery trims input and rejects blank queries", () => {
  assert.equal(normalizeQuery("  latest codex cli release  "), "latest codex cli release");
  assert.throws(() => normalizeQuery("   \n\t  "), /non-empty query/);
});

void test("extractUrlsFromText unwraps defuddle mirror URLs and deduplicates matches", () => {
  assert.deepEqual(
    extractUrlsFromText(
      "See https://defuddle.md/https://developers.openai.com/codex/cli/features and https://developers.openai.com/codex/cli/features"
    ),
    ["https://developers.openai.com/codex/cli/features"]
  );
});

void test("extractUrlsFromText preserves balanced parentheses and strips angle brackets", () => {
  assert.deepEqual(
    extractUrlsFromText(
      "Read <https://en.wikipedia.org/wiki/Function_(mathematics)> and https://example.com/test)."
    ),
    ["https://en.wikipedia.org/wiki/Function_(mathematics)", "https://example.com/test"]
  );
});

void test("getDirectUrlQuery only matches URL-only requests", () => {
  assert.equal(
    getDirectUrlQuery("https://developers.openai.com/codex/cli/features"),
    "https://developers.openai.com/codex/cli/features"
  );
  assert.equal(
    getDirectUrlQuery("https://defuddle.md/https://developers.openai.com/codex/cli/features"),
    "https://developers.openai.com/codex/cli/features"
  );
  assert.equal(getDirectUrlQuery("<https://example.com/test>"), "https://example.com/test");
  assert.equal(
    getDirectUrlQuery("summarize https://developers.openai.com/codex/cli/features"),
    undefined
  );
});

void test("resolveSearchMode defaults to fast and honors explicit mode overrides", () => {
  assert.equal(resolveSearchMode({ query: "weather in Tokyo" }), "fast");
  assert.equal(resolveSearchMode({ query: "weather in Tokyo" }, "deep"), "deep");
  assert.equal(resolveSearchMode({ query: "weather in Tokyo", mode: "deep" }), "deep");
  assert.equal(
    resolveSearchMode({ query: "deep comparison of top ANC headphones", mode: "fast" }),
    "fast"
  );
});

void test("isLiveFreshnessQuery detects strong recency signals", () => {
  assert.equal(isLiveFreshnessQuery("did sentinels win today"), true);
  assert.equal(isLiveFreshnessQuery("current tokyo weather"), true);
  assert.equal(isLiveFreshnessQuery("team standings and schedule"), false);
  assert.equal(
    isLiveFreshnessQuery("did sentinels win or lose their valorant game on february 7th"),
    false
  );
  assert.equal(isLiveFreshnessQuery("typescript decorators guide"), false);
});

void test("resolveSearchFreshness honors explicit overrides and auto-live hints", () => {
  assert.equal(resolveSearchFreshness({ query: "typescript decorators guide" }, "fast"), "indexed");
  assert.equal(resolveSearchFreshness({ query: "did sentinels win today" }, "fast"), "live");
  assert.equal(
    resolveSearchFreshness(
      { query: "did sentinels win or lose their valorant game on february 7th" },
      "fast"
    ),
    "indexed"
  );
  assert.equal(
    resolveSearchFreshness({ query: "weather now", freshness: "cached" }, "fast"),
    "cached"
  );
  assert.equal(resolveSearchFreshness({ query: "deep repo comparison" }, "deep"), "live");
  assert.equal(
    resolveSearchFreshness({ query: "typescript decorators guide" }, "fast", "live", "cached"),
    "live"
  );
  assert.equal(
    resolveSearchFreshness({ query: "deep repo comparison" }, "deep", "cached", "cached"),
    "cached"
  );
});

void test("buildCodexPrompt produces a JSON-only research prompt", () => {
  const defaultFastPrompt = buildCodexPrompt({ query: "latest codex cli release" });
  const defaultDeepPrompt = buildCodexPrompt({
    query: "site:wiki.archlinux.org Niri xdg-desktop-portal wayland session",
    mode: "deep",
  });
  const fastPrompt = buildCodexPrompt({ query: "latest codex cli release", maxSources: 3 });
  const deepPrompt = buildCodexPrompt(
    {
      query: "site:wiki.archlinux.org Niri xdg-desktop-portal wayland session",
      maxSources: 3,
      mode: "deep",
    },
    { queryBudget: 24 }
  );

  assert.match(fastPrompt, /Return only a JSON object/i);
  assert.match(fastPrompt, /at most 3 items/i);
  assert.match(fastPrompt, /User query: latest codex cli release/);
  assert.match(fastPrompt, /quick lookup/i);
  assert.match(fastPrompt, /exactly one web_search tool call/i);
  assert.match(fastPrompt, /answer immediately from the best evidence/i);
  assert.match(
    defaultFastPrompt,
    new RegExp(`at most ${DEFAULT_WEB_SEARCH_SETTINGS.fastMaxSources} items`, "i")
  );
  assert.match(
    defaultDeepPrompt,
    new RegExp(`at most ${DEFAULT_WEB_SEARCH_SETTINGS.deepMaxSources} items`, "i")
  );
  assert.match(deepPrompt, /deeper research task/i);
  assert.match(deepPrompt, /hard safety limit of 24 web_search tool calls/i);
  assert.match(deepPrompt, /supplied search operators or site constraints/i);
  assert.match(deepPrompt, /documentation or reference lookup/i);
});

void test("buildCodexExecArgs configures the requested web-search freshness", () => {
  const args = buildCodexExecArgs(
    {
      schemaPath: "/tmp/schema.json",
      outputPath: "/tmp/output.json",
    },
    "cached"
  );

  assert.deepEqual(args, [
    "exec",
    "--json",
    "-c",
    'web_search="cached"',
    "-c",
    'model_reasoning_effort="low"',
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--ephemeral",
    "--output-schema",
    "/tmp/schema.json",
    "--output-last-message",
    "/tmp/output.json",
    "-",
  ]);

  const deepArgs = buildCodexExecArgs(
    { schemaPath: "/tmp/schema.json", outputPath: "/tmp/output.json" },
    "live",
    "deep"
  );
  assert.ok(deepArgs.includes('model_reasoning_effort="medium"'));
});

void test("getInactivityFailure distinguishes dead connections from mid-run stalls", () => {
  const now = Date.now();
  const base = {
    query: "q",
    mode: "fast" as const,
    freshness: "indexed" as const,
    searchCount: 0,
    searchCallCount: 0,
    searchQueries: [],
    statusEvents: [],
  };

  // No events yet, within the startup window: no failure.
  assert.equal(
    getInactivityFailure({ ...base, eventCount: 0, startedAt: now - 10_000 }, 90_000),
    undefined
  );

  // No events past the startup window: dead connection.
  assert.match(
    getInactivityFailure({ ...base, eventCount: 0, startedAt: now - 31_000 }, 90_000) ?? "",
    /no backend events within 30s/
  );

  // Events flowing recently: no failure even if the run started long ago.
  assert.equal(
    getInactivityFailure(
      { ...base, eventCount: 5, startedAt: now - 80_000, lastEventAt: now - 5_000 },
      90_000
    ),
    undefined
  );

  // Events stopped for longer than the stall window: stalled.
  assert.match(
    getInactivityFailure(
      { ...base, eventCount: 5, startedAt: now - 120_000, lastEventAt: now - 61_000 },
      240_000
    ) ?? "",
    /appears stalled/
  );

  // Inactivity limits never exceed the wall-clock timeout.
  assert.match(
    getInactivityFailure({ ...base, eventCount: 0, startedAt: now - 6_000 }, 5_000) ?? "",
    /no backend events within 5s/
  );
});

void test("appendBounded keeps the tail of oversized subprocess output", () => {
  assert.equal(appendBounded("abc", "def", 100), "abcdef");
  assert.equal(appendBounded("abc", "def", 4), "cdef");
  assert.equal(appendBounded("", "x".repeat(10), 4), "xxxx");
  assert.ok(MAX_CAPTURED_STDOUT_BYTES > MAX_CAPTURED_STDERR_BYTES);
});

void test("runCodexCommand caps captured stdout while still emitting every line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-cap-"));
  const script = join(dir, "codex");
  // Emit ~9MB of stdout lines: beyond MAX_CAPTURED_STDOUT_BYTES (8MB).
  await writeFile(
    script,
    [
      "#!/usr/bin/env node",
      "const line = 'y'.repeat(1024);",
      "for (let i = 0; i < 9 * 1024; i++) process.stdout.write(line + '\\n');",
      "process.stdout.write('FINAL-MARKER\\n');",
    ].join("\n"),
    { mode: 0o755 }
  );

  const previousEnv = process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
  process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = script;
  try {
    let lineCount = 0;
    let sawFinal = false;
    const result = await runCodexCommand({
      args: [],
      cwd: dir,
      onStdoutLine: (line) => {
        lineCount += 1;
        if (line === "FINAL-MARKER") sawFinal = true;
      },
    });

    assert.equal(result.code, 0);
    assert.equal(lineCount, 9 * 1024 + 1);
    assert.equal(sawFinal, true);
    assert.ok(result.stdout.length <= MAX_CAPTURED_STDOUT_BYTES);
    assert.ok(result.stdout.endsWith("FINAL-MARKER\n"));
  } finally {
    if (previousEnv === undefined) {
      delete process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
    } else {
      process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = previousEnv;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

void test("findBundledCodexExecutable locates npm-installed vendor binaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-codex-bin-"));
  const binary = join(
    dir,
    "node_modules",
    "@openai",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "codex",
    process.platform === "win32" ? "codex.cmd" : "codex"
  );

  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  await chmod(binary, 0o755);

  const found = await findBundledCodexExecutable([join(dir, "node_modules", "@openai")]);
  assert.equal(found, binary);

  await rm(dir, { recursive: true, force: true });
});

async function writeFakeCodex(path: string, marker: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho ${marker}\n`, { mode: 0o755 });
}

async function withCodexLookupEnv(pathDir: string, run: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH;
  const previousOverrides = [
    "PI_CODEX_WEB_SEARCH_CODEX_PATH",
    "PI_CODEX_WEB_SEARCH_CODEX",
    "CODEX_PATH",
  ].map((key) => [key, process.env[key]] as const);
  process.env.PATH = pathDir;
  for (const [key] of previousOverrides) delete process.env[key];
  try {
    await run();
  } finally {
    process.env.PATH = previousPath;
    for (const [key, value] of previousOverrides) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

void test("runCodexCommand prefers PATH codex and never runs a workspace-local binary", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-lookup-"));
  const pathDir = join(dir, "path-bin");
  const projectA = join(dir, "project-a");
  const projectB = join(dir, "project-b");
  await writeFakeCodex(join(pathDir, "codex"), "PATH_CODEX");
  await writeFakeCodex(
    join(projectA, "node_modules", "@openai", "codex", "bin", "codex"),
    "PROJECT_LOCAL"
  );
  await mkdir(projectB, { recursive: true });

  try {
    await withCodexLookupEnv(pathDir, async () => {
      for (const cwd of [projectA, projectA, projectB]) {
        const result = await runCodexCommand({ args: [], cwd });
        assert.equal(result.stdout.trim(), "PATH_CODEX");
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runCodexCommand does not fall back to a workspace-local binary when PATH has no codex", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-lookup-"));
  const emptyPathDir = join(dir, "empty-bin");
  const project = join(dir, "project");
  await mkdir(emptyPathDir, { recursive: true });
  await writeFakeCodex(
    join(project, "node_modules", "@openai", "codex", "bin", "codex"),
    "PROJECT_LOCAL"
  );

  try {
    await withCodexLookupEnv(emptyPathDir, async () => {
      // A Codex installed globally on this machine may still be found; the
      // project's own binary must never be.
      const result = await runCodexCommand({ args: ["--version"], cwd: project }).catch(
        (error: unknown) => {
          assert.match(String(error), /Could not find `codex`/);
          return undefined;
        }
      );
      assert.doesNotMatch(result?.stdout ?? "", /PROJECT_LOCAL/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("parseCodexWebSearchOutput validates and trims sources", () => {
  const parsed = parseCodexWebSearchOutput(
    JSON.stringify({
      summary: "  Codex CLI docs are published on developers.openai.com.  ",
      sources: [
        {
          title: "   ",
          url: "https://example.com/ignored-1",
          snippet: "Dropped because the title is blank after trimming.",
        },
        {
          title: "Command line options",
          url: " https://developers.openai.com/codex/cli/reference ",
          snippet: " Official reference for commands and flags. ",
        },
        {
          title: "   ",
          url: "https://example.com/ignored-2",
          snippet: "Dropped because the title is blank after trimming.",
        },
        {
          title: "Extra",
          url: "https://example.com",
          snippet: "Kept because it is still within the source limit.",
        },
      ],
    }),
    2
  );

  assert.equal(parsed.summary, "Codex CLI docs are published on developers.openai.com.");
  assert.deepEqual(parsed.sources, [
    {
      title: "Command line options",
      url: "https://developers.openai.com/codex/cli/reference",
      snippet: "Official reference for commands and flags.",
    },
    {
      title: "Extra",
      url: "https://example.com",
      snippet: "Kept because it is still within the source limit.",
    },
  ]);
});

void test("parseCodexWebSearchOutput drops invalid and duplicate sources", () => {
  const parsed = parseCodexWebSearchOutput(
    JSON.stringify({
      summary: "Validated source filtering.",
      sources: [
        { title: "Official", url: "https://example.com/docs", snippet: "Useful." },
        { title: "Duplicate", url: "https://EXAMPLE.com/docs", snippet: "Same page." },
        { title: "Local", url: "file:///tmp/not-web", snippet: "Not a web source." },
        { title: "Malformed", url: "not a URL", snippet: "Not a web source." },
      ],
    }),
    10
  );

  assert.deepEqual(parsed.sources, [
    { title: "Official", url: "https://example.com/docs", snippet: "Useful." },
  ]);
});

void test("parseCodexWebSearchOutput extracts fenced JSON and tolerates missing snippets", () => {
  const parsed = parseCodexWebSearchOutput(
    [
      "Here is the structured result:",
      "```json",
      JSON.stringify({
        summary: "Recovered JSON body.",
        sources: [
          {
            url: "https://example.com/source",
          },
        ],
      }),
      "```",
    ].join("\n"),
    2
  );

  assert.equal(parsed.summary, "Recovered JSON body.");
  assert.deepEqual(parsed.sources, [
    {
      title: "https://example.com/source",
      url: "https://example.com/source",
      snippet: "",
    },
  ]);
});

void test("formatWebSearchResult renders summary followed by numbered sources", () => {
  const text = formatWebSearchResult({
    summary: "Codex CLI docs exist.",
    sources: [
      {
        title: "Command line options",
        url: "https://developers.openai.com/codex/cli/reference",
        snippet: "Flags and subcommands.",
      },
    ],
  });

  assert.match(text, /^Codex CLI docs exist\./);
  assert.match(text, /Sources:/);
  assert.match(text, /1\. Command line options/);
  assert.match(text, /https:\/\/developers\.openai\.com\/codex\/cli\/reference/);
});

void test("executeCodexWebSearch returns formatted content from codex output", async () => {
  const updates: string[] = [];
  const statusTexts: string[] = [];

  const runner: RunCodexCommand = ({ args, stdin, onStdoutLine }) => {
    assert.ok(stdin?.includes("User query: pi extension web search"));

    onStdoutLine?.(
      JSON.stringify({
        type: "item.started",
        item: {
          type: "web_search_call",
          query: "developers.openai.com codex cli reference ...",
          action: {
            type: "search",
            query: "developers.openai.com codex cli reference",
            queries: ["developers.openai.com codex cli reference"],
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          query: "codex exec reference official docs ...",
          action: {
            type: "search",
            query: "codex exec reference official docs",
            queries: ["codex exec reference official docs"],
          },
        },
      })
    );

    const outputIndex = args.indexOf("--output-last-message");
    assert.notEqual(outputIndex, -1);
    const outputPath = args[outputIndex + 1];
    assert.ok(outputPath);

    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Codex CLI can be wrapped by a Pi tool.",
        sources: [
          {
            title: "Command line options",
            url: "https://developers.openai.com/codex/cli/reference",
            snippet: "`codex exec` supports non-interactive runs.",
          },
        ],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "pi extension web search", maxSources: 2 },
    {
      cwd: process.cwd(),
      runner,
      onUpdate: (update) => {
        const first = update.content[0];
        updates.push(first?.type === "text" ? first.text : "");
        const details = update.details as { statusText?: string } | undefined;
        statusTexts.push(details?.statusText ?? "");
      },
    }
  );

  assert.match(result.content[0]?.text ?? "", /Codex CLI can be wrapped by a Pi tool\./);
  assert.equal(result.details.query, "pi extension web search");
  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.freshness, "indexed");
  assert.equal(result.details.sourceCount, 1);
  assert.equal(result.details.searchCount, 2);
  assert.equal(result.details.searchCallCount, 2);
  assert.equal(result.details.queryBudget, 10);
  assert.equal(result.details.attempt, 1);
  assert.ok((result.details.elapsedMs ?? 0) >= 0);
  assert.equal(result.details.eventCount, 2);
  assert.deepEqual(result.details.searchQueries, [
    "developers.openai.com codex cli reference",
    "codex exec reference official docs",
  ]);
  assert.equal(result.details.sources[0]?.title, "Command line options");
  assert.ok(updates.some((line) => line.includes("Running fast Codex web search")));
  assert.ok(
    updates.some((line) => line.includes("Search #1: developers.openai.com codex cli reference"))
  );
  assert.ok(updates.some((line) => line.includes("Search #2: codex exec reference official docs")));
  assert.ok(
    statusTexts.some((line) => line.includes("Search #2: codex exec reference official docs"))
  );
});

void test("executeCodexWebSearch uses mode-specific default maxSources unless explicitly overridden", async () => {
  const prompts: string[] = [];

  const runner: RunCodexCommand = ({ args, stdin }) => {
    prompts.push(stdin ?? "");
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Mode-specific source caps were applied.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const settings = {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    fastMaxSources: 2,
    deepMaxSources: 7,
  };

  await executeCodexWebSearch(
    { query: "fast default max sources" },
    {
      cwd: process.cwd(),
      runner,
      settings,
    }
  );

  await executeCodexWebSearch(
    { query: "deep default max sources", mode: "deep" },
    {
      cwd: process.cwd(),
      runner,
      settings,
    }
  );

  await executeCodexWebSearch(
    { query: "explicit override", mode: "deep", maxSources: 4 },
    {
      cwd: process.cwd(),
      runner,
      settings,
    }
  );

  assert.match(prompts[0] ?? "", /at most 2 items/i);
  assert.match(prompts[1] ?? "", /at most 7 items/i);
  assert.match(prompts[2] ?? "", /at most 4 items/i);
});

void test("executeCodexWebSearch uses Defuddle directly for URL-only queries", async () => {
  let codexInvoked = false;
  const runner: RunCodexCommand = () => {
    codexInvoked = true;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  const defuddleRunner: RunDefuddleCommand = ({ url }) => {
    assert.equal(url, "https://developers.openai.com/codex/cli/features");
    return Promise.resolve({
      url,
      title: "Features – Codex CLI | OpenAI Developers",
      description: "Overview of functionality in the Codex terminal client",
      domain: "developers.openai.com",
      author: "",
      published: "",
      wordCount: 1234,
      content: "Codex supports workflows beyond chat.",
    });
  };

  const result = await executeCodexWebSearch(
    { query: "https://defuddle.md/https://developers.openai.com/codex/cli/features" },
    {
      cwd: process.cwd(),
      runner,
      defuddleRunner,
    }
  );

  assert.equal(codexInvoked, false);
  assert.equal(result.details.searchCount, 0);
  assert.equal(result.details.defuddle?.directUrlQuery, true);
  assert.deepEqual(result.details.defuddle?.urls, [
    "https://developers.openai.com/codex/cli/features",
  ]);
  assert.match(result.details.summary, /Defuddle extracted clean content directly/);
  assert.equal(result.details.sources[0]?.title, "Features – Codex CLI | OpenAI Developers");
  assert.match(result.content[0]?.text ?? "", /Extracted content:/);
  assert.match(result.content[0]?.text ?? "", /Codex supports workflows beyond chat\./);
});

void test("executeCodexWebSearch forwards the caller's cancellation to the Codex run", async () => {
  const controller = new AbortController();
  const runner: RunCodexCommand = ({ signal }) =>
    new Promise((_resolve, reject) => {
      assert.ok(signal);
      assert.notEqual(signal, controller.signal);
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      setTimeout(() => controller.abort(new Error("search cancelled by the user")), 10);
    });

  await assert.rejects(
    executeCodexWebSearch(
      { query: "cancel me", mode: "deep" },
      { cwd: process.cwd(), runner, signal: controller.signal }
    ),
    /search cancelled by the user/
  );
});

void test("executeCodexWebSearch rethrows Defuddle cancellations", async () => {
  const abortController = new AbortController();
  const abortError = new DOMException("Aborted", "AbortError");
  abortController.abort(abortError);

  const defuddleRunner: RunDefuddleCommand = () => Promise.reject(abortError);

  await assert.rejects(
    executeCodexWebSearch(
      { query: "https://developers.openai.com/codex/cli/features" },
      {
        cwd: process.cwd(),
        signal: abortController.signal,
        defuddleRunner,
      }
    ),
    /Aborted/
  );
});

void test("executeCodexWebSearch falls back to Defuddle for URL-based requests when Codex fails", async () => {
  const runner: RunCodexCommand = () =>
    Promise.reject(new Error("Codex web search timed out after 90 seconds."));

  const defuddleRunner: RunDefuddleCommand = ({ url }) => {
    assert.equal(url, "https://developers.openai.com/codex/cli/features");
    return Promise.resolve({
      url,
      title: "Features – Codex CLI | OpenAI Developers",
      description: "Overview of functionality in the Codex terminal client",
      domain: "developers.openai.com",
      author: "",
      published: "",
      wordCount: 1234,
      content: "Codex supports workflows beyond chat.",
    });
  };

  const result = await executeCodexWebSearch(
    { query: "summarize https://developers.openai.com/codex/cli/features" },
    {
      cwd: process.cwd(),
      runner,
      defuddleRunner,
      settings: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        defuddleMode: "both",
      },
    }
  );

  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.freshness, "indexed");
  assert.equal(result.details.retry, undefined);
  assert.equal(result.details.defuddle?.directUrlQuery, false);
  assert.equal(result.details.defuddle?.reason, "Codex web search timed out after 90 seconds.");
  assert.match(result.details.summary, /Codex did not produce a usable response/);
  assert.equal(result.details.sources[0]?.url, "https://developers.openai.com/codex/cli/features");
  assert.match(
    result.content[0]?.text ?? "",
    /Extracted content from https:\/\/developers\.openai\.com\/codex\/cli\/features:\nCodex supports workflows beyond chat\./
  );
});

void test("executeCodexWebSearch bounds fallback extracted content to a readable excerpt", async () => {
  const runner: RunCodexCommand = () =>
    Promise.reject(new Error("Codex web search timed out after 90 seconds."));

  const hugeContent = "lorem ipsum ".repeat(5_000);
  const defuddleRunner: RunDefuddleCommand = ({ url }) =>
    Promise.resolve({
      url,
      title: "Huge page",
      description: "",
      domain: "example.com",
      author: "",
      published: "",
      wordCount: 10_000,
      content: hugeContent,
    });

  const result = await executeCodexWebSearch(
    { query: "summarize https://example.com/huge-page" },
    {
      cwd: process.cwd(),
      runner,
      defuddleRunner,
      settings: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        defuddleMode: "both",
      },
    }
  );

  const text = result.content[0]?.text ?? "";
  assert.match(text, /Extracted content from https:\/\/example\.com\/huge-page:/);
  assert.match(text, /\[Content truncated to 12000 characters\.\]/);
  assert.ok(text.length < hugeContent.length);
});

void test("executeCodexWebSearch preserves Codex progress when Defuddle handles a failed run", async () => {
  const runner: RunCodexCommand = ({ onStdoutLine }) => {
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "search",
            query: "site:developers.openai.com codex cli features",
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url: "https://developers.openai.com/codex/cli/features",
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "error",
        message: "Reconnecting... 1/2",
      })
    );

    return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
  };

  const defuddleRunner: RunDefuddleCommand = ({ url }) => {
    assert.equal(url, "https://developers.openai.com/codex/cli/features");
    return Promise.resolve({
      url,
      title: "Features – Codex CLI | OpenAI Developers",
      description: "Overview of functionality in the Codex terminal client",
      domain: "developers.openai.com",
      author: "",
      published: "",
      wordCount: 1234,
      content: "Codex supports workflows beyond chat.",
    });
  };

  const result = await executeCodexWebSearch(
    { query: "summarize https://developers.openai.com/codex/cli/features", mode: "deep" },
    {
      cwd: process.cwd(),
      runner,
      defuddleRunner,
      settings: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        defuddleMode: "both",
      },
    }
  );

  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.equal(result.details.searchCount, 1);
  assert.equal(result.details.latestQuery, "site:developers.openai.com codex cli features");
  assert.deepEqual(result.details.searchQueries, ["site:developers.openai.com codex cli features"]);
  assert.deepEqual(result.details.pageActions, [
    "Open page: https://developers.openai.com/codex/cli/features",
  ]);
  assert.deepEqual(result.details.statusEvents, ["Reconnecting... 1/2"]);
  assert.equal(result.details.defuddle?.reason, "Codex web search timed out after 90 seconds.");
  assert.equal(result.details.retry, undefined);
});

void test("executeCodexWebSearch does not use Defuddle fallback for generic URL queries", async () => {
  const runner: RunCodexCommand = () =>
    Promise.reject(new Error("Codex web search timed out after 90 seconds."));

  let defuddleInvoked = false;
  const defuddleRunner: RunDefuddleCommand = () => {
    defuddleInvoked = true;
    return Promise.resolve({
      url: "https://developers.openai.com/codex/cli/features",
      title: "Features – Codex CLI | OpenAI Developers",
      description: "Overview of functionality in the Codex terminal client",
      domain: "developers.openai.com",
      author: "",
      published: "",
      wordCount: 1234,
      content: "Codex supports workflows beyond chat.",
    });
  };

  const result = await executeCodexWebSearch(
    { query: "compare this page https://developers.openai.com/codex/cli/features" },
    {
      cwd: process.cwd(),
      runner,
      defuddleRunner,
      settings: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        defuddleMode: "both",
      },
    }
  );

  assert.equal(defuddleInvoked, false);
  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.freshness, "indexed");
  assert.equal(result.details.failure?.kind, "timeout");
  assert.equal(result.details.retry, undefined);
  assert.match(result.content[0]?.text ?? "", /could not produce a usable result/i);
});

void test("executeCodexWebSearch does not hide terminal auth failures behind Defuddle fallback", async () => {
  const runner: RunCodexCommand = () =>
    Promise.reject(new Error("authentication required; run codex login"));

  let defuddleInvoked = false;
  const defuddleRunner: RunDefuddleCommand = () => {
    defuddleInvoked = true;
    return Promise.resolve({
      url: "https://developers.openai.com/codex/cli/features",
      title: "Features – Codex CLI | OpenAI Developers",
      description: "Overview of functionality in the Codex terminal client",
      domain: "developers.openai.com",
      author: "",
      published: "",
      wordCount: 1234,
      content: "Codex supports workflows beyond chat.",
    });
  };

  await assert.rejects(
    executeCodexWebSearch(
      { query: "summarize https://developers.openai.com/codex/cli/features" },
      {
        cwd: process.cwd(),
        runner,
        defuddleRunner,
        settings: {
          ...DEFAULT_WEB_SEARCH_SETTINGS,
          defuddleMode: "both",
        },
      }
    ),
    /authentication required|codex login/
  );

  assert.equal(defuddleInvoked, false);
});

void test("executeCodexWebSearch classifies missing codex binaries before auth guidance", async () => {
  const runner: RunCodexCommand = () =>
    Promise.reject(
      new Error(
        "Could not find `codex` in PATH or common install locations. Install Codex CLI, then run `codex login status` or `codex login`."
      )
    );

  await assert.rejects(
    executeCodexWebSearch(
      { query: "missing codex binary" },
      {
        cwd: process.cwd(),
        runner,
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const failure = (error as Error & { failure?: { kind?: string } }).failure;
      assert.equal(failure?.kind, "missing_cli");
      return true;
    }
  );
});

void test("executeCodexWebSearch falls back to the final stdout agent message when the output file is empty", async () => {
  const runner: RunCodexCommand = ({ args }) => {
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(outputPath, "   \n").then(() => ({
      code: 0,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              summary: "Recovered the final response from stdout.",
              sources: [],
            }),
          },
        }),
      ].join("\n"),
      stderr: "",
    }));
  };

  const result = await executeCodexWebSearch(
    { query: "stdout fallback" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.match(result.content[0]?.text ?? "", /Recovered the final response from stdout\./);
  assert.equal(result.details.summary, "Recovered the final response from stdout.");
});

void test("executeCodexWebSearch understands raw response.output_item events from Codex", async () => {
  const stdoutLines = [
    JSON.stringify({
      type: "response.output_item.added",
      item: {
        type: "web_search_call",
        id: "ws_1",
        status: "in_progress",
      },
    }),
    JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "raw response event query",
        },
      },
    }),
    JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              summary: "Recovered from raw response events.",
              sources: [],
            }),
          },
        ],
      },
    }),
  ];

  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);

    for (const line of stdoutLines) {
      onStdoutLine?.(line);
    }

    return writeFile(outputPath, "   \n").then(() => ({
      code: 0,
      stdout: stdoutLines.join("\n"),
      stderr: "",
    }));
  };

  const result = await executeCodexWebSearch(
    { query: "raw response event fallback" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.searchCount, 1);
  assert.deepEqual(result.details.searchQueries, ["raw response event query"]);
  assert.equal(result.details.summary, "Recovered from raw response events.");
});

void test("executeCodexWebSearch uses persisted settings for default mode and freshness", async () => {
  const runner: RunCodexCommand = ({ args }) => {
    assert.ok(args.includes('web_search="cached"'));
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Configured defaults were applied.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "compare travel backpacks" },
    {
      cwd: process.cwd(),
      runner,
      settings: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        defaultMode: "deep",
        fastFreshness: "live",
        deepFreshness: "cached",
      },
    }
  );

  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "cached");
});

void test("executeCodexWebSearch auto-upgrades freshness for current-event queries", async () => {
  const runner: RunCodexCommand = ({ args }) => {
    assert.ok(args.includes('web_search="live"'));
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Sentinels won today.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "did sentinels win today" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.freshness, "live");
});

void test("executeCodexWebSearch honors explicit freshness overrides", async () => {
  const runner: RunCodexCommand = ({ args }) => {
    assert.ok(args.includes('web_search="cached"'));
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Tokyo weather summary.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "weather now in Tokyo", freshness: "cached" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.freshness, "cached");
});

void test("executeCodexWebSearch retries default fast searches as deep/live after transport failures", async () => {
  const attempts: { args: string[]; stdin: string | undefined }[] = [];

  const runner: RunCodexCommand = ({ args, stdin }) => {
    attempts.push({ args, stdin });

    if (attempts.length === 1) {
      return Promise.reject(
        new Error("stream disconnected before completion: error sending request")
      );
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Recovered on deep/live retry.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "did sentinels win or lose their valorant game on february 7th" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(attempts.length, 2);
  assert.ok(attempts[0]?.args.includes('web_search="indexed"'));
  assert.ok(attempts[0]?.stdin?.includes("This is a quick lookup."));
  assert.ok(attempts[1]?.args.includes('web_search="live"'));
  assert.ok(attempts[1]?.stdin?.includes("This is a deeper research task."));
  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.deepEqual(result.details.retry, {
    retriedFromFast: true,
    originalMode: "fast",
    originalFreshness: "indexed",
    fallbackReason: "stream disconnected before completion: error sending request",
  });
  assert.match(result.content[0]?.text ?? "", /Recovered on deep\/live retry\./);
});

void test("executeCodexWebSearch does not retry fast timeouts as deep/live", async () => {
  const turnState = { fastModeExhausted: false };
  let attempts = 0;

  const runner: RunCodexCommand = () => {
    attempts += 1;
    return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
  };

  const result = await executeCodexWebSearch(
    { query: "simple lookup that times out" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
    }
  );

  assert.equal(attempts, 1);
  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.failure?.kind, "timeout");
  assert.equal(result.details.retry, undefined);
  assert.equal(turnState.fastModeExhausted, true);
});

void test("executeCodexWebSearch keeps retry provenance when Defuddle handles a failed deep/live retry", async () => {
  let attempts = 0;

  const runner: RunCodexCommand = () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.reject(
        new Error("stream disconnected before completion: error sending request")
      );
    }

    return Promise.reject(
      new Error("Codex did not write a final response to the output file or stdout events.")
    );
  };

  const defuddleRunner: RunDefuddleCommand = ({ url }) => {
    assert.equal(url, "https://developers.openai.com/codex/cli/features");
    return Promise.resolve({
      url,
      title: "Features – Codex CLI | OpenAI Developers",
      description: "Overview of functionality in the Codex terminal client",
      domain: "developers.openai.com",
      author: "",
      published: "",
      wordCount: 1234,
      content: "Codex supports workflows beyond chat.",
    });
  };

  const result = await executeCodexWebSearch(
    { query: "summarize https://developers.openai.com/codex/cli/features" },
    {
      cwd: process.cwd(),
      runner,
      defuddleRunner,
      settings: {
        ...DEFAULT_WEB_SEARCH_SETTINGS,
        defuddleMode: "both",
      },
    }
  );

  assert.equal(attempts, 2);
  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.deepEqual(result.details.retry, {
    retriedFromFast: true,
    originalMode: "fast",
    originalFreshness: "indexed",
    fallbackReason: "stream disconnected before completion: error sending request",
  });
  assert.equal(
    result.details.defuddle?.reason,
    "Codex did not write a final response to the output file or stdout events."
  );
});

void test("executeCodexWebSearch soft-fails default fast searches after budget exhaustion without escalating", async () => {
  const statusTexts: string[] = [];
  const turnState = { fastModeExhausted: false };
  let attempts = 0;

  const runner: RunCodexCommand = ({ onStdoutLine, signal }) => {
    attempts += 1;

    for (let i = 1; i <= 11; i += 1) {
      onStdoutLine?.(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "web_search",
            action: {
              type: "search",
              query: `query ${i}`,
              queries: [`query ${i}`],
            },
          },
        })
      );
      if (signal?.aborted) break;
    }

    const reason: unknown = signal?.reason;
    return Promise.reject(
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "expected abort")
    );
  };

  const result = await executeCodexWebSearch(
    { query: "budget-heavy fast search" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
      onUpdate: (update) => {
        const details = update.details as { statusText?: string } | undefined;
        statusTexts.push(details?.statusText ?? "");
      },
    }
  );

  assert.equal(attempts, 1);
  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.failure?.kind, "budget");
  assert.equal(result.details.retry, undefined);
  assert.equal(turnState.fastModeExhausted, true);
  assert.ok(
    statusTexts.some((line) =>
      line.includes("Fast mode has used its full search-call budget (10/10)")
    )
  );
  assert.match(result.content[0]?.text ?? "", /fast search-call budget/);
});

void test("executeCodexWebSearch rejects blank queries before spawning Codex", async () => {
  let invoked = false;
  const runner: RunCodexCommand = () => {
    invoked = true;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  await assert.rejects(
    executeCodexWebSearch(
      { query: "   " },
      {
        cwd: process.cwd(),
        runner,
      }
    ),
    /non-empty query/
  );

  assert.equal(invoked, false);
});

void test("executeCodexWebSearch truncates oversized tool output and keeps a temp file", async () => {
  const runner: RunCodexCommand = ({ args }) => {
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "A".repeat(60_000),
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "huge summary" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.truncated, true);
  assert.match(result.content[0]?.text ?? "", /Output truncated:/);
  assert.match(result.details.fullOutputPath ?? "", /pi-codex-web-search-result-/);

  if (result.details.fullOutputPath) {
    await rm(dirname(result.details.fullOutputPath), { recursive: true, force: true });
  }
});

void test("executeCodexWebSearch budgets batched queries by web_search call", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine, signal }) => {
    const batches = [
      ["query 1", "query 2", "query 3", "query 4"],
      ["query 5", "query 6", "query 7", "query 8", "query 9", "query 10", "query 11", "query 12"],
    ];

    for (const [index, queries] of batches.entries()) {
      onStdoutLine?.(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: `web-search-${index + 1}`,
            type: "web_search",
            query: `${queries[0]} ...`,
            action: { type: "search", queries },
          },
        })
      );
    }

    assert.equal(signal?.aborted, false);
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({ summary: "Completed two batched search calls.", sources: [] })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "batched technical lookup", mode: "fast" },
    { cwd: process.cwd(), runner }
  );

  assert.equal(result.details.failure, undefined);
  assert.equal(result.details.searchCallCount, 2);
  assert.equal(result.details.searchCount, 12);
  assert.equal(
    result.details.searchQueries.some((query) => query.endsWith("...")),
    false
  );
  assert.match(result.content[0]?.text ?? "", /Completed two batched search calls/);
});

void test("executeCodexWebSearch allows runs that use the full fast search budget", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    for (let i = 1; i <= 10; i += 1) {
      onStdoutLine?.(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "web_search",
            action: {
              type: "search",
              query: `query ${i}`,
              queries: [`query ${i}`],
            },
          },
        })
      );
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Completed at the fast search budget.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "weather in Tokyo", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.searchCount, 10);
  assert.match(result.content[0]?.text ?? "", /Completed at the fast search budget\./);
});

void test("executeCodexWebSearch does not count page inspection against the search budget", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine, signal }) => {
    for (let i = 1; i <= 10; i += 1) {
      onStdoutLine?.(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "web_search",
            action: {
              type: "search",
              query: `query ${i}`,
              queries: [`query ${i}`],
            },
          },
        })
      );
      if (signal?.aborted) {
        break;
      }
    }

    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url: "https://wiki.archlinux.org/title/Niri",
          },
        },
      })
    );
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      return Promise.reject(
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "expected abort")
      );
    }

    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "find_in_page",
            url: "https://wiki.archlinux.org/title/Niri",
            pattern: "xdg-desktop-portal",
          },
        },
      })
    );
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      return Promise.reject(
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "expected abort")
      );
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Page inspection stayed within the search budget.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "site:wiki.archlinux.org Niri xdg-desktop-portal", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.searchCount, 10);
  assert.deepEqual(result.details.searchQueries, [
    "query 1",
    "query 2",
    "query 3",
    "query 4",
    "query 5",
    "query 6",
    "query 7",
    "query 8",
    "query 9",
    "query 10",
  ]);
  assert.deepEqual(result.details.pageActions, [
    "Open page: https://wiki.archlinux.org/title/Niri",
    "Find in page: xdg-desktop-portal in https://wiki.archlinux.org/title/Niri",
  ]);
  assert.match(result.content[0]?.text ?? "", /Page inspection stayed within the search budget\./);
});

void test("executeCodexWebSearch ignores find_in_page actions without a pattern", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "find_in_page",
            url: "https://wiki.archlinux.org/title/Niri",
          },
        },
      })
    );

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Ignored incomplete find_in_page action.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "site:wiki.archlinux.org Niri", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.searchCount, 0);
  assert.deepEqual(result.details.pageActions, []);
  assert.match(result.content[0]?.text ?? "", /Ignored incomplete find_in_page action\./);
});

void test("executeCodexWebSearch keeps non-consecutive repeated page actions", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    const url = "https://wiki.archlinux.org/title/Niri";

    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url,
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url,
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "find_in_page",
            url,
            pattern: "xdg-desktop-portal",
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url,
          },
        },
      })
    );

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Repeated page actions were preserved when separated by other activity.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "site:wiki.archlinux.org Niri", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.searchCount, 0);
  assert.deepEqual(result.details.pageActions, [
    "Open page: https://wiki.archlinux.org/title/Niri",
    "Find in page: xdg-desktop-portal in https://wiki.archlinux.org/title/Niri",
    "Open page: https://wiki.archlinux.org/title/Niri",
  ]);
  assert.match(
    result.content[0]?.text ?? "",
    /Repeated page actions were preserved when separated by other activity\./
  );
});

void test("executeCodexWebSearch deduplicates page actions around search events", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    const url = "https://wiki.archlinux.org/title/Niri";

    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url,
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "search",
            query: "Niri wayland compositor features",
            queries: ["Niri wayland compositor features"],
          },
        },
      })
    );
    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
          action: {
            type: "open_page",
            url,
          },
        },
      })
    );

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Page actions around search were deduplicated correctly.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "site:wiki.archlinux.org Niri", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.searchCount, 1);
  // Duplicate page actions are deduplicated even across search events
  // since search events don't add page actions to the list
  assert.deepEqual(result.details.pageActions, [
    "Open page: https://wiki.archlinux.org/title/Niri",
  ]);
  assert.match(
    result.content[0]?.text ?? "",
    /Page actions around search were deduplicated correctly\./
  );
});

void test("executeCodexWebSearch counts repeated identical searches against the fast budget", async () => {
  const runner: RunCodexCommand = ({ onStdoutLine, signal }) => {
    for (let i = 1; i <= 11; i += 1) {
      onStdoutLine?.(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "web_search",
            action: {
              type: "search",
              query: "same query",
              queries: ["same query"],
            },
          },
        })
      );
      if (signal?.aborted) break;
    }

    const reason: unknown = signal?.reason;
    return Promise.reject(
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "expected abort")
    );
  };

  const result = await executeCodexWebSearch(
    { query: "weather in Tokyo", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.failure?.kind, "budget");
  assert.equal(result.details.searchCount, 11);
  assert.deepEqual(result.details.searchQueries, ["same query"]);
  assert.match(result.content[0]?.text ?? "", /11\/10 calls/);
});

void test("executeCodexWebSearch soft-fails explicit fast mode when Codex exceeds the search budget", async () => {
  const runner: RunCodexCommand = ({ onStdoutLine, signal }) => {
    for (let i = 1; i <= 11; i += 1) {
      onStdoutLine?.(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "web_search",
            action: {
              type: "search",
              query: `query ${i}`,
              queries: [`query ${i}`],
            },
          },
        })
      );
      if (signal?.aborted) break;
    }

    const reason: unknown = signal?.reason;
    return Promise.reject(
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "expected abort")
    );
  };

  const result = await executeCodexWebSearch(
    { query: "weather in Tokyo", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.failure?.kind, "budget");
  assert.equal(result.details.searchCount, 11);
  assert.match(result.content[0]?.text ?? "", /fast search-call budget/);
});

void test("executeCodexWebSearch soft-fails repeated fast retries within the same turn", async () => {
  const turnState = { fastModeExhausted: true };
  let invoked = false;
  const runner: RunCodexCommand = () => {
    invoked = true;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };

  const result = await executeCodexWebSearch(
    { query: "did sentinels win today" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
    }
  );

  assert.equal(invoked, false);
  assert.equal(result.details.failure?.kind, "budget");
  assert.match(result.content[0]?.text ?? "", /failed earlier in this turn/i);
});

void test("executeCodexWebSearch retries turn.failed transport failures and surfaces progress", async () => {
  const statusTexts: string[] = [];
  let attempts = 0;

  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    attempts += 1;

    if (attempts === 1) {
      const stdoutLines = [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "error",
            message: "Falling back from WebSockets to HTTPS transport. upstream reset",
          },
        }),
        JSON.stringify({
          type: "error",
          message: "Reconnecting... 1/2",
        }),
        JSON.stringify({
          type: "turn.failed",
          error: {
            message: "stream disconnected before completion: error sending request",
          },
        }),
      ];

      for (const line of stdoutLines) {
        onStdoutLine?.(line);
      }

      return Promise.resolve({
        code: 1,
        stdout: stdoutLines.join("\n"),
        stderr: "",
      });
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Recovered after a transport retry.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "latest codex transport status" },
    {
      cwd: process.cwd(),
      runner,
      onUpdate: (update) => {
        const details = update.details as { statusText?: string } | undefined;
        statusTexts.push(details?.statusText ?? "");
      },
    }
  );

  assert.equal(attempts, 2);
  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.equal(result.details.retry?.retriedFromFast, true);
  assert.match(result.details.retry?.fallbackReason ?? "", /stream disconnected before completion/);
  assert.ok(
    statusTexts.some((line) => line.includes("Falling back from WebSockets to HTTPS transport"))
  );
  assert.ok(statusTexts.some((line) => line.includes("Reconnecting... 1/2")));
  assert.match(result.content[0]?.text ?? "", /Recovered after a transport retry\./);
});

void test("executeCodexWebSearch does not poison later fast searches after a recovered transport failure", async () => {
  const turnState = { fastModeExhausted: false };
  let attempts = 0;

  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    attempts += 1;

    if (attempts === 1) {
      const stdoutLines = [
        JSON.stringify({
          type: "turn.failed",
          error: {
            message: "stream disconnected before completion: error sending request",
          },
        }),
      ];
      for (const line of stdoutLines) {
        onStdoutLine?.(line);
      }
      return Promise.resolve({ code: 1, stdout: stdoutLines.join("\n"), stderr: "" });
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    const summary =
      attempts === 2 ? "Recovered on deep/live retry." : "Later fast search still works.";
    return writeFile(outputPath, JSON.stringify({ summary, sources: [] })).then(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
  };

  const first = await executeCodexWebSearch(
    { query: "first transport hiccup" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
    }
  );
  const second = await executeCodexWebSearch(
    { query: "second fast lookup", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
    }
  );

  assert.equal(first.details.mode, "deep");
  assert.equal(turnState.fastModeExhausted, false);
  assert.equal(second.details.mode, "fast");
  assert.match(second.content[0]?.text ?? "", /Later fast search still works\./);
});

void test("executeCodexWebSearch blocks later fast searches after a timeout", async () => {
  const turnState = { fastModeExhausted: false };
  let attempts = 0;

  const runner: RunCodexCommand = () => {
    attempts += 1;
    return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
  };

  const first = await executeCodexWebSearch(
    { query: "first timeout" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
    }
  );
  const second = await executeCodexWebSearch(
    { query: "second fast lookup", mode: "fast" },
    {
      cwd: process.cwd(),
      runner,
      turnState,
    }
  );

  assert.equal(first.details.failure?.kind, "timeout");
  assert.equal(turnState.fastModeExhausted, true);
  assert.equal(second.details.failure?.kind, "budget");
  assert.equal(attempts, 1);
});

void test("executeCodexWebSearch classifies common backend 5xx failures as transport", async () => {
  const runner: RunCodexCommand = () =>
    Promise.reject(
      new Error(
        "503 Service Unavailable: upstream connect error or disconnect/reset before headers"
      )
    );

  const result = await executeCodexWebSearch(
    { query: "backend outage", mode: "deep" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.failure?.kind, "transport");
  assert.match(result.content[0]?.text ?? "", /Failure kind: transport/);
});

void test("executeCodexWebSearch returns a soft degraded result for blank output plus turn.failed", async () => {
  const runner: RunCodexCommand = ({ args, onStdoutLine }) => {
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);

    const stdoutLines = [
      JSON.stringify({
        type: "error",
        message: "Reconnecting... 2/2",
      }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: "stream disconnected before completion: error sending request",
        },
      }),
    ];

    for (const line of stdoutLines) {
      onStdoutLine?.(line);
    }

    return writeFile(outputPath, "   \n").then(() => ({
      code: 0,
      stdout: stdoutLines.join("\n"),
      stderr: "",
    }));
  };

  const result = await executeCodexWebSearch(
    { query: "transport failure trace", mode: "deep" },
    {
      cwd: process.cwd(),
      runner,
    }
  );

  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.failure?.kind, "transport");
  assert.deepEqual(result.details.statusEvents, [
    "Reconnecting... 2/2",
    "stream disconnected before completion: error sending request",
  ]);
  assert.match(result.content[0]?.text ?? "", /could not produce a usable result/i);
  assert.doesNotMatch(result.content[0]?.text ?? "", /Sources: none provided by Codex\./);
});

void test("executeCodexWebSearch surfaces codex execution failures", async () => {
  const runner: RunCodexCommand = () =>
    Promise.resolve({
      code: 7,
      stdout: "progress\nfinal line",
      stderr: "authentication required",
    });

  await assert.rejects(
    executeCodexWebSearch(
      { query: "broken run" },
      {
        cwd: process.cwd(),
        runner,
      }
    ),
    /codex exec failed with exit code 7[\s\S]*authentication required[\s\S]*codex login status[\s\S]*codex login/
  );
});

void test("executeCodexWebSearch classifies exit failures by Codex errors, not by search activity", async () => {
  // The stdout tail holds ordinary research events. A query that mentions
  // "login" or a status code must not turn a transport failure into a
  // non-recoverable auth or other misclassified failure.
  const stdoutLines = [
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "ws_1",
        type: "web_search",
        action: { type: "search", query: "github login page returns 403 forbidden" },
      },
    }),
    JSON.stringify({
      type: "turn.failed",
      error: { message: "stream disconnected before completion: error sending request" },
    }),
  ];
  const runner: RunCodexCommand = () =>
    Promise.resolve({ code: 1, stdout: stdoutLines.join("\n"), stderr: "" });

  const result = await executeCodexWebSearch(
    { query: "why does the github login page return 403", mode: "deep" },
    {
      cwd: process.cwd(),
      runner,
      settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, defuddleMode: "off" },
    }
  );

  assert.equal(result.details.failure?.kind, "transport");
  assert.equal(result.details.failure?.recoverable, true);
  // The stdout tail is still kept for diagnostics.
  assert.match(result.details.failure?.message ?? "", /github login page/);
});

void test("executeCodexWebSearch bounds the stdout tail kept in failure messages", async () => {
  const hugeLine = JSON.stringify({ type: "item.completed", item: { text: "x".repeat(200_000) } });
  const runner: RunCodexCommand = () =>
    Promise.resolve({ code: 1, stdout: `${hugeLine}\n`, stderr: "stream disconnected" });

  const result = await executeCodexWebSearch(
    { query: "bounded failure", mode: "deep" },
    {
      cwd: process.cwd(),
      runner,
      settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, defuddleMode: "off" },
    }
  );

  assert.equal(result.details.failure?.kind, "transport");
  assert.ok((result.details.failure?.message.length ?? 0) < 5_000);
});

function verboseStderr(lastLine: string): string {
  // 25 ordinary log lines of about 280 chars: their 20-line tail alone is
  // longer than the failure message bound.
  const logLine = `INFO codex_core::session: processing event ${"x".repeat(240)}`;
  return [...Array.from({ length: 25 }, () => logLine), lastLine].join("\n");
}

void test("executeCodexWebSearch classifies a long stderr by its final error line", async () => {
  const runner: RunCodexCommand = () =>
    Promise.resolve({
      code: 1,
      stdout: "",
      stderr: verboseStderr(
        "ERROR codex_exec: unexpected status 401 Unauthorized: Missing bearer token"
      ),
    });

  await assert.rejects(
    executeCodexWebSearch(
      { query: "verbose auth failure", mode: "deep" },
      { cwd: process.cwd(), runner }
    ),
    (error: unknown) => {
      const failure = (error as { failure?: { kind?: string; message?: string } }).failure;
      assert.equal(failure?.kind, "auth");
      assert.match(failure?.message ?? "", /401 Unauthorized/);
      assert.ok((failure?.message?.length ?? 0) < 5_000);
      return true;
    }
  );
});

void test("executeCodexWebSearch retries a long-stderr transport failure in deep/live mode", async () => {
  let attempts = 0;
  const runner: RunCodexCommand = ({ args }) => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: verboseStderr("ERROR codex_exec: stream disconnected before completion"),
      });
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({ summary: "Recovered after a transport retry.", sources: [] })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "verbose transport failure" },
    {
      cwd: process.cwd(),
      runner,
      settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, defuddleMode: "off" },
    }
  );

  assert.equal(attempts, 2);
  assert.equal(result.details.retry?.retriedFromFast, true);
  assert.match(result.details.retry?.fallbackReason ?? "", /stream disconnected before completion/);
});

void test("executeCodexWebSearch treats a dead-connection startup timeout as a timeout, not an auth failure", async () => {
  const now = Date.now();
  const startupFailure = getInactivityFailure(
    {
      query: "q",
      mode: "fast",
      freshness: "indexed",
      searchCount: 0,
      searchCallCount: 0,
      searchQueries: [],
      pageActions: [],
      statusEvents: [],
      eventCount: 0,
      startedAt: now - 31_000,
    },
    90_000
  );
  assert.ok(startupFailure);
  // The hint mentions `codex login status`, which must not make it look like an auth problem.
  assert.match(startupFailure, /codex login status/);

  const turnState = { fastModeExhausted: false };
  const result = await executeCodexWebSearch(
    { query: "latest codex release notes", mode: "fast", freshness: "indexed" },
    {
      cwd: process.cwd(),
      runner: () => Promise.reject(new Error(startupFailure)),
      settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, defuddleMode: "off" },
      turnState,
    }
  );

  assert.equal(result.details.failure?.kind, "timeout");
  assert.equal(result.details.failure?.recoverable, true);
  assert.equal(turnState.fastModeExhausted, true);
});

void test("runCodexCommand does not spawn Codex for an already cancelled search", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-pre-aborted-"));
  const marker = join(dir, "spawned");
  const script = join(dir, "codex");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });

  const previousEnv = process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
  try {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));

    // A missing binary used to emit an unhandled "error" (ENOENT) after the
    // early rejection, crashing the host process.
    process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = join(dir, "missing-codex");
    await assert.rejects(
      runCodexCommand({ args: [], cwd: dir, signal: controller.signal }),
      /cancelled before start/
    );

    process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = script;
    await assert.rejects(
      runCodexCommand({ args: [], cwd: dir, signal: controller.signal }),
      /cancelled before start/
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally {
    if (previousEnv === undefined) {
      delete process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
    } else {
      process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = previousEnv;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

void test("getScriptRuntimeEnv makes a Bun-compiled Pi binary run the Defuddle script", () => {
  const env = { PATH: "/usr/bin" };
  assert.equal(getScriptRuntimeEnv(env, false), env);
  assert.deepEqual(getScriptRuntimeEnv(env, true), { PATH: "/usr/bin", BUN_BE_BUN: "1" });
  assert.equal("BUN_BE_BUN" in env, false);
});

void test("runDefuddleCommand rejects an already cancelled extraction without fetching", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before extraction"));
  await assert.rejects(
    runDefuddleCommand({
      url: "https://example.com/",
      cwd: process.cwd(),
      signal: controller.signal,
    }),
    /cancelled before extraction/
  );
});

void test("runCodexCommand survives Codex exiting before it reads the prompt", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-epipe-"));
  const script = join(dir, "codex");
  // Exit without reading stdin, so writing a large prompt hits a closed pipe (EPIPE).
  await writeFile(script, "#!/bin/sh\necho 'config error' >&2\nexit 3\n", { mode: 0o755 });

  const previousEnv = process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
  process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = script;
  try {
    const result = await runCodexCommand({
      args: [],
      cwd: dir,
      stdin: "x".repeat(4 * 1024 * 1024),
    });

    assert.equal(result.code, 3);
    assert.match(result.stderr, /config error/);
  } finally {
    if (previousEnv === undefined) {
      delete process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH;
    } else {
      process.env.PI_CODEX_WEB_SEARCH_CODEX_PATH = previousEnv;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
