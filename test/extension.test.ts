import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import codexWebSearchExtension from "../src/index.js";
import { SETTINGS_COMMAND, TOOL_NAME } from "../src/constants.js";

interface CapturedExtension {
  toolName?: string;
  toolDescription?: string;
  commandName?: string;
  commandDescription?: string;
}

function createMockPi(captured: CapturedExtension): ExtensionAPI {
  return {
    on: () => undefined,
    registerTool: (tool: { name: string; description: string }) => {
      captured.toolName = tool.name;
      captured.toolDescription = tool.description;
    },
    registerCommand: (name: string, command: { description: string }) => {
      captured.commandName = name;
      captured.commandDescription = command.description;
    },
  } as unknown as ExtensionAPI;
}

void test("extension registers the web_search tool and settings command", () => {
  const captured: CapturedExtension = {};
  codexWebSearchExtension(createMockPi(captured));

  assert.equal(captured.toolName, TOOL_NAME);
  assert.match(captured.toolDescription ?? "", /Codex CLI/);
  assert.equal(captured.commandName, SETTINGS_COMMAND);
  assert.match(captured.commandDescription ?? "", /default mode and freshness/);
});
