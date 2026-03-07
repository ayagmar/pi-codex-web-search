import type { EchoInput } from "./types.js";
import { MAX_MESSAGE_LENGTH } from "./constants.js";

export function sanitizeMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) {
    return message;
  }

  return `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

export function buildEchoText(input: EchoInput): string {
  const sanitized = sanitizeMessage(input.message.trim());
  return input.uppercase ? sanitized.toUpperCase() : sanitized;
}
