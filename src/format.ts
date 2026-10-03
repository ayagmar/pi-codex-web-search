import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Formats a duration as `42s` or `3m 05s`. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Shortens a value for a single-line preview to at most `maxWidth` terminal
 * columns, so wide (CJK, emoji) text is not twice as long as intended.
 * The ellipsis is appended as plain text, so a caller's theme color still
 * applies to it.
 */
export function formatInlineQuery(query: unknown, maxWidth = 90): string {
  // Collapse newlines and runs of whitespace: a multi-line failure message
  // must not turn the collapsed one-line preview into a block of text.
  const text = typeof query === "string" ? query.replace(/\s+/gu, " ").trim() : "";
  if (!text) return "…";
  if (visibleWidth(text) <= maxWidth) return text;
  return `${sliceByColumn(text, 0, maxWidth - 1, true)}…`;
}
