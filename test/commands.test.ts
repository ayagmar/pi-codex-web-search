import test from "node:test";
import assert from "node:assert/strict";
import { buildHelpText, parseSubcommand } from "../src/commands.js";
import { EXTENSION_COMMAND } from "../src/constants.js";

void test("parseSubcommand splits name and rest", () => {
  assert.deepEqual(parseSubcommand("set-label shipping-ready"), {
    name: "set-label",
    rest: "shipping-ready",
  });
});

void test("parseSubcommand handles single word", () => {
  assert.deepEqual(parseSubcommand("status"), { name: "status", rest: "" });
});

void test("parseSubcommand handles empty input", () => {
  assert.deepEqual(parseSubcommand(""), { name: "", rest: "" });
  assert.deepEqual(parseSubcommand("  "), { name: "", rest: "" });
});

void test("parseSubcommand lowercases name", () => {
  assert.deepEqual(parseSubcommand("STATUS"), { name: "status", rest: "" });
  assert.deepEqual(parseSubcommand("Set-Label Hello"), { name: "set-label", rest: "Hello" });
});

void test("buildHelpText includes command name", () => {
  const help = buildHelpText();
  assert.match(help, new RegExp(`/${EXTENSION_COMMAND} status`));
  assert.match(help, new RegExp(`/${EXTENSION_COMMAND} set-label <text>`));
});
