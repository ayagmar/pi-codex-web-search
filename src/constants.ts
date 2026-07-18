export const TOOL_NAME = "web_search";
export const SETTINGS_COMMAND = "web-search-settings";

export const DEFAULT_FAST_MAX_SOURCES = 5;
export const DEFAULT_DEEP_MAX_SOURCES = 5;
export const MAX_ALLOWED_SOURCES = 10;

export const FAST_SEARCH_TIMEOUT_MS = 90_000;
export const DEEP_SEARCH_TIMEOUT_MS = 240_000;

// Phase-aware inactivity deadlines, checked alongside the hard wall-clock
// timeout. A run that emits no JSONL events at all is a dead connection and
// should fail fast; a run that goes silent mid-research has stalled.
export const STARTUP_INACTIVITY_TIMEOUT_MS = 30_000;
export const STALL_INACTIVITY_TIMEOUT_MS = 60_000;
export const DEFUDDLE_TIMEOUT_MS = 45_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 600_000;

export const FAST_SEARCH_QUERY_BUDGET = 10;
export const DEEP_SEARCH_QUERY_BUDGET = 24;
export const MIN_QUERY_BUDGET = 1;
export const MAX_QUERY_BUDGET = 100;
