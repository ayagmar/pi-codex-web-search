import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extensionTemplate from "../src/index.js";
import { EXTENSION_COMMAND, TOOL_NAME } from "../src/constants.js";

interface CapturedExtension {
  commandName?: string;
  toolName?: string;
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  return {
    on: () => undefined,
    registerCommand: (name: string) => {
      captured.commandName = name;
    },
    registerTool: (tool: { name: string }) => {
      captured.toolName = tool.name;
    },
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;
}

void test("extension registers command and tool", () => {
  const captured: CapturedExtension = {};
  extensionTemplate(createMockPi(captured));

  assert.equal(captured.commandName, EXTENSION_COMMAND);
  assert.equal(captured.toolName, TOOL_NAME);
});
