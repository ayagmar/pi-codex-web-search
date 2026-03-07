import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  executeCodexWebSearch,
  formatWebSearchResult,
  normalizeMaxSources,
  normalizeQuery,
  parseCodexWebSearchOutput,
  resolveSearchFreshness,
  resolveSearchMode,
} from "../src/codex.js";
import { DEFAULT_MAX_SOURCES, MAX_ALLOWED_SOURCES } from "../src/constants.js";
import type { RunCodexCommand } from "../src/types.js";

void test("normalizeMaxSources clamps values into the supported range", () => {
  assert.equal(normalizeMaxSources(undefined), DEFAULT_MAX_SOURCES);
  assert.equal(normalizeMaxSources(0), 1);
  assert.equal(normalizeMaxSources(3.9), 3);
  assert.equal(normalizeMaxSources(999), MAX_ALLOWED_SOURCES);
});

void test("normalizeQuery trims input and rejects blank queries", () => {
  assert.equal(normalizeQuery("  latest codex cli release  "), "latest codex cli release");
  assert.throws(() => normalizeQuery("   \n\t  "), /non-empty query/);
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

void test("resolveSearchFreshness maps fast and deep to configured freshness", () => {
  assert.equal(resolveSearchFreshness("fast"), "cached");
  assert.equal(resolveSearchFreshness("deep"), "live");
  assert.equal(resolveSearchFreshness("fast", "live", "cached"), "live");
  assert.equal(resolveSearchFreshness("deep", "cached", "cached"), "cached");
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

  const runner: RunCodexCommand = ({ args, stdin, onStdoutLine }) => {
    assert.ok(stdin?.includes("User query: pi extension web search"));

    onStdoutLine?.(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "web_search",
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
        defaultMode: "deep",
        fastFreshness: "live",
        deepFreshness: "cached",
      },
    }
  );

  assert.equal(result.details.mode, "deep");
  assert.equal(result.details.freshness, "cached");
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

void test("executeCodexWebSearch aborts fast mode when Codex exceeds the search budget", async () => {
  const runner: RunCodexCommand = ({ onStdoutLine, signal }) => {
    for (let i = 1; i <= 7; i += 1) {
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

  await assert.rejects(
    executeCodexWebSearch(
      { query: "weather in Tokyo" },
      {
        cwd: process.cwd(),
        runner,
      }
    ),
    /fast search budget/
  );
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
    /codex exec failed with exit code 7[\s\S]*authentication required/
  );
});
