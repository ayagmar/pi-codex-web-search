import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, formatInlineQuery } from "../src/format.js";

void test("formatElapsed renders seconds and minutes", () => {
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(1_499), "1s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(600_000), "10m 00s");
});

void test("formatInlineQuery truncates by terminal width", () => {
  assert.equal(formatInlineQuery(undefined), "…");
  assert.equal(formatInlineQuery("   "), "…");
  assert.equal(formatInlineQuery("  short query  "), "short query");
  assert.equal(formatInlineQuery("abcdefghij", 10), "abcdefghij");
  assert.equal(formatInlineQuery("abcdefghijk", 10), "abcdefghi…");

  // Each CJK character takes two columns.
  const wide = formatInlineQuery("東京の天気予報を教えてください今日明日", 10);
  assert.ok(visibleWidth(wide) <= 10);
  assert.equal(wide, "東京の天…");
  // No ANSI reset is inserted before the ellipsis, so outer colors survive.
  assert.ok(!wide.includes("\u001b"));
});

void test("formatInlineQuery keeps multi-line text on one line", () => {
  assert.equal(
    formatInlineQuery("codex exec failed with exit code 1.\n\nstream disconnected\n\t retrying"),
    "codex exec failed with exit code 1. stream disconnected retrying"
  );
});
