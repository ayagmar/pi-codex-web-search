import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchKey, createSearchGate } from "../src/search-gate.js";
import type { SearchGateResult } from "../src/search-gate.js";

function successResult(text: string): SearchGateResult {
  return {
    content: [{ type: "text", text }],
    details: { sourceCount: 1, summary: text },
  };
}

void test("buildSearchKey normalizes query case and whitespace but keeps overrides distinct", () => {
  assert.equal(
    buildSearchKey({ query: "  Latest Codex Release " }),
    buildSearchKey({ query: "latest codex release" })
  );
  assert.notEqual(
    buildSearchKey({ query: "latest codex release" }),
    buildSearchKey({ query: "latest codex release", mode: "deep" })
  );
  assert.notEqual(
    buildSearchKey({ query: "latest codex release", freshness: "live" }),
    buildSearchKey({ query: "latest codex release", freshness: "indexed" })
  );
});

void test("identical concurrent searches await the same in-flight run", async () => {
  let runs = 0;
  let release: (() => void) | undefined;
  const gate = createSearchGate(async () => {
    runs += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return successResult("shared result");
  });

  const first = gate.execute("call-1", { query: "same question" });
  const second = gate.execute("call-2", { query: "Same Question" });

  release?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(runs, 1);
  assert.equal(firstResult.content[0]?.text, "shared result");
  assert.equal(secondResult.content[0]?.text, "shared result");
  const coalesced = secondResult.details as { coalescedWithToolCallId?: string };
  assert.equal(coalesced.coalescedWithToolCallId, "call-1");
});

void test("different concurrent searches are skipped with guidance", async () => {
  let release: (() => void) | undefined;
  const gate = createSearchGate(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return successResult("first result");
  });

  const first = gate.execute("call-1", { query: "first question" });
  const skipped = await gate.execute("call-2", { query: "second question" });

  const details = skipped.details as {
    concurrentSearchSkipped?: boolean;
    activeQuery?: string;
    skippedQuery?: string;
  };
  assert.equal(details.concurrentSearchSkipped, true);
  assert.equal(details.activeQuery, "first question");
  assert.equal(details.skippedQuery, "second question");
  assert.match(skipped.content[0]?.text ?? "", /Skipped this concurrent web search/);

  release?.();
  await first;
});

void test("repeated searches within a turn are served from the cache", async () => {
  let runs = 0;
  const gate = createSearchGate(() => {
    runs += 1;
    return Promise.resolve(successResult(`run ${runs}`));
  });

  const first = await gate.execute("call-1", { query: "cached question" });
  const second = await gate.execute("call-2", { query: "cached question" });

  assert.equal(runs, 1);
  assert.equal(first.content[0]?.text, "run 1");
  assert.equal(second.content[0]?.text, "run 1");
  const cachedDetails = second.details as { servedFromTurnCache?: boolean };
  assert.equal(cachedDetails.servedFromTurnCache, true);
});

void test("reset clears the turn cache so the next turn searches again", async () => {
  let runs = 0;
  const gate = createSearchGate(() => {
    runs += 1;
    return Promise.resolve(successResult(`run ${runs}`));
  });

  await gate.execute("call-1", { query: "per-turn question" });
  gate.reset();
  const second = await gate.execute("call-2", { query: "per-turn question" });

  assert.equal(runs, 2);
  assert.equal(second.content[0]?.text, "run 2");
  const details = second.details as { servedFromTurnCache?: boolean };
  assert.equal(details.servedFromTurnCache, undefined);
});

void test("failed results are not cached", async () => {
  let runs = 0;
  const gate = createSearchGate(() => {
    runs += 1;
    if (runs === 1) {
      return Promise.resolve({
        content: [{ type: "text" as const, text: "failed" }],
        details: { failure: { kind: "timeout", message: "timed out", recoverable: true } },
      });
    }
    return Promise.resolve(successResult("recovered"));
  });

  const first = await gate.execute("call-1", { query: "flaky question" });
  const second = await gate.execute("call-2", { query: "flaky question" });

  assert.equal(runs, 2);
  assert.match(first.content[0]?.text ?? "", /failed/);
  assert.equal(second.content[0]?.text, "recovered");
});

void test("thrown runs release the gate for the next search", async () => {
  let runs = 0;
  const gate = createSearchGate(() => {
    runs += 1;
    if (runs === 1) {
      return Promise.reject(new Error("hard failure"));
    }
    return Promise.resolve(successResult("second run works"));
  });

  await assert.rejects(gate.execute("call-1", { query: "throwing question" }), /hard failure/);
  const second = await gate.execute("call-2", { query: "throwing question" });

  assert.equal(runs, 2);
  assert.equal(second.content[0]?.text, "second run works");
});

void test("cache evicts oldest entries beyond the size limit", async () => {
  let runs = 0;
  const gate = createSearchGate(() => {
    runs += 1;
    return Promise.resolve(successResult(`run ${runs}`));
  });

  for (let i = 0; i < 17; i += 1) {
    await gate.execute(`call-${i}`, { query: `question ${i}` });
  }

  // question 0 evicted; a repeat should trigger a fresh run.
  await gate.execute("call-repeat", { query: "question 0" });
  assert.equal(runs, 18);

  // question 16 still cached.
  const cached = await gate.execute("call-cached", { query: "question 16" });
  const details = cached.details as { servedFromTurnCache?: boolean };
  assert.equal(details.servedFromTurnCache, true);
});
