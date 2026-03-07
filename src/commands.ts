import { EXTENSION_COMMAND } from "./constants.js";

export function buildHelpText(): string {
  return [
    `/${EXTENSION_COMMAND} status`,
    `/${EXTENSION_COMMAND} set-label <text>`,
    `/${EXTENSION_COMMAND} help`,
  ].join("\n");
}

export function parseSubcommand(raw: string): { name: string; rest: string } {
  const trimmed = raw.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { name: trimmed.toLowerCase(), rest: "" };
  return {
    name: trimmed.slice(0, spaceIndex).toLowerCase(),
    rest: trimmed.slice(spaceIndex + 1).trim(),
  };
}
