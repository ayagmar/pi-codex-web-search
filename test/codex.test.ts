import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  executeCodexWebSearch,
  formatWebSearchResult,
  isLiveFreshnessQuery,
  normalizeMaxSources,
  normalizeQuery,
  parseCodexWebSearchOutput,
  resolveSearchFreshness,
  resolveSearchMode,
} from "../src/codex.js";
import { findBundledCodexExecutable } from "../src/codex-command.js";
import { extractUrlsFromText, getDirectUrlQuery } from "../src/defuddle.js";
import { DEFAULT_FAST_MAX_SOURCES, MAX_ALLOWED_SOURCES } from "../src/constants.js";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../src/settings.js";
import type { RunCodexCommand, RunDefuddleCommand } from "../src/types.js";

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
  assert.equal(resolveSearchFreshness({ query: "typescript decorators guide" }, "fast"), "cached");
  assert.equal(resolveSearchFreshness({ query: "did sentinels win today" }, "fast"), "live");
  assert.equal(
    resolveSearchFreshness(
      { query: "did sentinels win or lose their valorant game on february 7th" },
      "fast"
    ),
    "cached"
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
  const fastPrompt = buildCodexPrompt({ query: "latest codex cli release", maxSources: 3 });
  const deepPrompt = buildCodexPrompt({
    query: "latest codex cli release",
    maxSources: 3,
    mode: "deep",
  });

  assert.match(fastPrompt, /Return only a JSON object/i);
  assert.match(fastPrompt, /at most 3 items/i);
  assert.match(fastPrompt, /User query: latest codex cli release/);
  assert.match(fastPrompt, /quick lookup/i);
  assert.match(deepPrompt, /deeper research task/i);
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

  const found = await findBundledCodexExecutable(dir);
  assert.equal(found, binary);

  await rm(dir, { recursive: true, force: true });
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
  assert.equal(result.details.freshness, "cached");
  assert.equal(result.details.sourceCount, 1);
  assert.equal(result.details.searchCount, 2);
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

  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.deepEqual(result.details.retry, {
    retriedFromFast: true,
    originalMode: "fast",
    originalFreshness: "cached",
    fallbackReason: "Codex web search timed out after 90 seconds.",
  });
  assert.equal(result.details.defuddle?.directUrlQuery, false);
  assert.equal(result.details.defuddle?.reason, "Codex web search timed out after 90 seconds.");
  assert.match(result.details.summary, /Codex did not produce a usable response/);
  assert.equal(result.details.sources[0]?.url, "https://developers.openai.com/codex/cli/features");
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
  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.equal(result.details.failure?.kind, "timeout");
  assert.deepEqual(result.details.retry, {
    retriedFromFast: true,
    originalMode: "fast",
    originalFreshness: "cached",
    fallbackReason: "Codex web search timed out after 90 seconds.",
  });
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

void test("executeCodexWebSearch retries default fast searches as deep/live after retryable failures", async () => {
  const attempts: { args: string[]; stdin: string | undefined }[] = [];

  const runner: RunCodexCommand = ({ args, stdin }) => {
    attempts.push({ args, stdin });

    if (attempts.length === 1) {
      return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
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
  assert.ok(attempts[0]?.args.includes('web_search="cached"'));
  assert.ok(attempts[0]?.stdin?.includes("This is a quick lookup."));
  assert.ok(attempts[1]?.args.includes('web_search="live"'));
  assert.ok(attempts[1]?.stdin?.includes("This is a deeper research task."));
  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "live");
  assert.deepEqual(result.details.retry, {
    retriedFromFast: true,
    originalMode: "fast",
    originalFreshness: "cached",
    fallbackReason: "Codex web search timed out after 90 seconds.",
  });
  assert.match(result.content[0]?.text ?? "", /Recovered on deep\/live retry\./);
});

void test("executeCodexWebSearch keeps retry provenance when Defuddle handles a failed deep/live retry", async () => {
  let attempts = 0;

  const runner: RunCodexCommand = () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
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
    originalFreshness: "cached",
    fallbackReason: "Codex web search timed out after 90 seconds.",
  });
  assert.equal(
    result.details.defuddle?.reason,
    "Codex did not write a final response to the output file or stdout events."
  );
});

void test("executeCodexWebSearch auto-escalates default fast searches after budget exhaustion", async () => {
  const statusTexts: string[] = [];
  let attempts = 0;

  const runner: RunCodexCommand = ({ args, onStdoutLine, signal }) => {
    attempts += 1;

    if (attempts === 1) {
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
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(
      outputPath,
      JSON.stringify({
        summary: "Recovered after fast-mode budget exhaustion.",
        sources: [],
      })
    ).then(() => ({ code: 0, stdout: "", stderr: "" }));
  };

  const result = await executeCodexWebSearch(
    { query: "budget-heavy fast search" },
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
  assert.match(result.details.retry?.fallbackReason ?? "", /Auto-escalating once to deep\/live/);
  assert.ok(
    statusTexts.some((line) => line.includes("Fast mode has used its full query budget (10/10)"))
  );
  assert.ok(
    statusTexts.some((line) =>
      line.includes("Auto-escalating to deep/live after fast mode hit its query budget")
    )
  );
  assert.match(result.content[0]?.text ?? "", /Recovered after fast-mode budget exhaustion\./);
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
  assert.match(result.content[0]?.text ?? "", /11\/10 queries/);
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
  assert.match(result.content[0]?.text ?? "", /fast search budget/);
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

void test("executeCodexWebSearch does not poison later fast searches after a recovered timeout", async () => {
  const turnState = { fastModeExhausted: false };
  let attempts = 0;

  const runner: RunCodexCommand = ({ args }) => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    const summary =
      attempts === 2
        ? "Recovered after timeout retry."
        : "Later fast search still works after timeout.";
    return writeFile(outputPath, JSON.stringify({ summary, sources: [] })).then(() => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
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

  assert.equal(first.details.mode, "deep");
  assert.equal(turnState.fastModeExhausted, false);
  assert.equal(second.details.mode, "fast");
  assert.match(second.content[0]?.text ?? "", /Later fast search still works after timeout\./);
});

void test("executeCodexWebSearch blocks later fast searches after an unrecovered timeout", async () => {
  const turnState = { fastModeExhausted: false };
  let attempts = 0;

  const runner: RunCodexCommand = () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.reject(new Error("Codex web search timed out after 90 seconds."));
    }

    return Promise.reject(new Error("Codex still timed out after retry."));
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
  assert.equal(attempts, 2);
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
