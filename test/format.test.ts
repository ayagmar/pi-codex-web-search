import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "../src/format.js";

void test("formatElapsed renders seconds and minutes", () => {
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(1_499), "1s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(600_000), "10m 00s");
});
