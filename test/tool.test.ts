import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MESSAGE_LENGTH } from "../src/constants.js";
import { buildEchoText, sanitizeMessage } from "../src/tool.js";

void test("buildEchoText returns plain message", () => {
  assert.equal(buildEchoText({ message: "hello" }), "hello");
});

void test("buildEchoText can uppercase", () => {
  assert.equal(buildEchoText({ message: "hello", uppercase: true }), "HELLO");
});

void test("sanitizeMessage truncates long input", () => {
  const longMessage = "x".repeat(MAX_MESSAGE_LENGTH + 10);
  const sanitized = sanitizeMessage(longMessage);
  assert.equal(sanitized.length, MAX_MESSAGE_LENGTH);
  assert.match(sanitized, /…$/);
});
