import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCodexWebSearch } from "../src/codex.js";
import type { RunCodexCommand } from "../src/types.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

/**
 * Replays real `codex exec --json` JSONL streams captured from the live CLI.
 * These catch protocol-shape regressions (like the display-query double
 * counting bug) that synthetic events can miss. Refresh a fixture by
 * re-running the query in the fixture header comment against the current
 * Codex CLI.
 */
async function loadFixture(name: string): Promise<string[]> {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf-8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

function createReplayRunner(
  lines: string[],
  finalOutput: { summary: string; sources: { title: string; url: string; snippet: string }[] }
): RunCodexCommand {
  return ({ args, onStdoutLine }) => {
    for (const line of lines) {
      onStdoutLine?.(line);
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assert.ok(outputPath);
    return writeFile(outputPath, JSON.stringify(finalOutput)).then(() => ({
      code: 0,
      stdout: lines.join("\n"),
      stderr: "",
    }));
  };
}

void test("replayed single-search Codex stream counts one call and one query", async () => {
  const lines = await loadFixture("codex-single-search.jsonl");
  const runner = createReplayRunner(lines, {
    summary: "Node.js 24 is the latest LTS major version.",
    sources: [
      {
        title: "Node.js downloads",
        url: "https://nodejs.org/en/download",
        snippet: "Current LTS release line.",
      },
    ],
  });

  const result = await executeCodexWebSearch(
    { query: "what is the latest stable Node.js LTS major version?", mode: "fast" },
    { cwd: process.cwd(), runner }
  );

  assert.equal(result.details.failure, undefined);
  assert.equal(result.details.searchCallCount, 1);
  assert.equal(result.details.searchCount, 1);
  assert.deepEqual(result.details.searchQueries, [
    "site:nodejs.org Node.js latest LTS release current",
  ]);
  assert.equal(result.details.sourceCount, 1);
  // Every fixture line is a JSON event and must be counted exactly once.
  assert.equal(result.details.eventCount, lines.length);
});

void test("replayed batched-search Codex stream does not double-count started/completed events", async () => {
  const lines = await loadFixture("codex-batched-search.jsonl");
  const runner = createReplayRunner(lines, {
    summary: "OpenJDK 21 defaults to G1 GC; OpenJDK 8 defaults to Parallel GC.",
    sources: [
      {
        title: "JDK 21 GC tuning guide",
        url: "https://docs.oracle.com/en/java/javase/21/gctuning/",
        snippet: "G1 is the default collector.",
      },
    ],
  });

  const result = await executeCodexWebSearch(
    { query: "compare default GC in OpenJDK 21 vs OpenJDK 8", mode: "fast" },
    { cwd: process.cwd(), runner }
  );

  assert.equal(result.details.failure, undefined);
  // The stream contains two web_search item ids. The first search call emits
  // item.started (action type "other", no queries) plus item.completed with
  // two batched queries; the second call never reports query data. Only the
  // call with real search queries counts.
  assert.equal(result.details.searchCallCount, 1);
  assert.equal(result.details.searchCount, 3);
  assert.equal(result.details.searchQueries.length, 3);
  // The abbreviated top-level display query ends in "..." and must not be
  // recorded alongside the real batched action queries.
  assert.ok(result.details.searchQueries.every((query) => !query.endsWith("...")));
  assert.ok(
    result.details.searchQueries.every(
      (query) => query.startsWith("site:docs.oracle.com") || query.startsWith("site:openjdk.org")
    )
  );
  assert.equal(result.details.eventCount, lines.length);
});
