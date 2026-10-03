import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  DEEP_SEARCH_QUERY_BUDGET,
  DEEP_SEARCH_TIMEOUT_MS,
  DEFAULT_DEEP_MAX_SOURCES,
  DEFAULT_FAST_MAX_SOURCES,
  DEFUDDLE_TIMEOUT_MS,
  FAST_SEARCH_QUERY_BUDGET,
  FAST_SEARCH_TIMEOUT_MS,
  MAX_ALLOWED_SOURCES,
  MAX_QUERY_BUDGET,
  MAX_TIMEOUT_MS,
  MIN_QUERY_BUDGET,
  MIN_TIMEOUT_MS,
  SETTINGS_COMMAND,
} from "./constants.js";
import {
  type DefuddleMode,
  type SearchFreshness,
  type SearchMode,
  type WebSearchSettings,
} from "./types.js";

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  defaultMode: "fast",
  // Indexed search is Codex's best low-latency default: it uses the hosted
  // index without waiting for a live crawl. Recency-sensitive queries still
  // promote themselves to live in resolveSearchFreshness().
  fastFreshness: "indexed",
  deepFreshness: "live",
  fastMaxSources: DEFAULT_FAST_MAX_SOURCES,
  deepMaxSources: DEFAULT_DEEP_MAX_SOURCES,
  defuddleMode: "direct",
  fastTimeoutMs: FAST_SEARCH_TIMEOUT_MS,
  deepTimeoutMs: DEEP_SEARCH_TIMEOUT_MS,
  defuddleTimeoutMs: DEFUDDLE_TIMEOUT_MS,
  fastQueryBudget: FAST_SEARCH_QUERY_BUDGET,
  deepQueryBudget: DEEP_SEARCH_QUERY_BUDGET,
};

export const SETTINGS_FILE_NAME = "pi-codex-web-search.settings.json";

/**
 * Settings live in Pi's agent directory, which honors PI_CODING_AGENT_DIR.
 * Resolved on every call so a relocated agent dir is picked up at runtime.
 */
export function getSettingsPath(): string {
  return join(getAgentDir(), SETTINGS_FILE_NAME);
}

export class InvalidSettingsFileError extends Error {
  constructor(
    readonly path: string,
    reason: string
  ) {
    super(
      `The web search settings file ${path} is not valid JSON (${reason}). web_search uses the default settings until it is fixed. Fix or delete the file, or run /${SETTINGS_COMMAND} reset.`
    );
    this.name = "InvalidSettingsFileError";
  }
}

/**
 * Settings for a web search. A missing or unreadable-as-JSON file falls back
 * to the defaults so a broken settings file never breaks searching.
 */
export async function loadSettings(path = getSettingsPath()): Promise<WebSearchSettings> {
  try {
    return await loadSettingsStrict(path);
  } catch (error) {
    if (error instanceof InvalidSettingsFileError) {
      return { ...DEFAULT_WEB_SEARCH_SETTINGS };
    }
    throw error;
  }
}

/**
 * Like loadSettings, but reports a settings file with invalid JSON instead of
 * replacing it with defaults. Used before editing, so a save never silently
 * overwrites the values a user put in a file with a typo.
 */
export async function loadSettingsStrict(path = getSettingsPath()): Promise<WebSearchSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_WEB_SEARCH_SETTINGS };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new InvalidSettingsFileError(
      path,
      error instanceof Error ? error.message : String(error)
    );
  }
  return normalizeSettings(parsed);
}

export async function saveSettings(
  settings: Partial<WebSearchSettings>,
  path = getSettingsPath()
): Promise<WebSearchSettings> {
  return withFileMutationQueue(path, () => writeSettingsFile(settings, path));
}

/**
 * Applies `changes` to the saved settings as one read-modify-write, so
 * concurrent updates cannot drop each other's values.
 */
export async function updateSettings(
  changes: Partial<WebSearchSettings>,
  path = getSettingsPath()
): Promise<WebSearchSettings> {
  return withFileMutationQueue(path, async () => {
    const current = await loadSettingsStrict(path);
    return writeSettingsFile({ ...current, ...changes }, path);
  });
}

async function writeSettingsFile(
  settings: Partial<WebSearchSettings>,
  path: string
): Promise<WebSearchSettings> {
  const normalized = normalizeSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  // Write a sibling temp file and rename it into place, so a search that
  // reads the settings concurrently never sees a half-written file.
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return normalized;
}

export function formatSettings(settings: WebSearchSettings): string {
  return [
    "Search defaults:",
    `  Default mode: ${settings.defaultMode}`,
    `  Fast freshness: ${settings.fastFreshness}`,
    `  Deep freshness: ${settings.deepFreshness}`,
    `  Fast max sources: ${settings.fastMaxSources}`,
    `  Deep max sources: ${settings.deepMaxSources}`,
    "",
    "Defuddle behavior:",
    `  Mode: ${settings.defuddleMode}`,
    "",
    "Timeouts:",
    `  Fast: ${formatDuration(settings.fastTimeoutMs)}`,
    `  Deep: ${formatDuration(settings.deepTimeoutMs)}`,
    `  Defuddle: ${formatDuration(settings.defuddleTimeoutMs)}`,
    "",
    "Search-call budgets:",
    `  Fast: ${settings.fastQueryBudget}`,
    `  Deep: ${settings.deepQueryBudget}`,
  ].join("\n");
}

export function normalizeSettings(value: unknown): WebSearchSettings {
  const candidate = value && typeof value === "object" ? value : {};
  const typedCandidate = candidate as {
    defaultMode?: unknown;
    fastFreshness?: unknown;
    deepFreshness?: unknown;
    fastMaxSources?: unknown;
    deepMaxSources?: unknown;
    defaultMaxSources?: unknown;
    defuddleMode?: unknown;
    fastTimeoutMs?: unknown;
    deepTimeoutMs?: unknown;
    defuddleTimeoutMs?: unknown;
    fastQueryBudget?: unknown;
    deepQueryBudget?: unknown;
  };
  const legacyMaxSources = asOptionalIntegerInRange(
    typedCandidate.defaultMaxSources,
    1,
    MAX_ALLOWED_SOURCES
  );

  return {
    defaultMode: asMode(typedCandidate.defaultMode, DEFAULT_WEB_SEARCH_SETTINGS.defaultMode),
    fastFreshness: asFreshness(
      typedCandidate.fastFreshness,
      DEFAULT_WEB_SEARCH_SETTINGS.fastFreshness
    ),
    deepFreshness: asFreshness(
      typedCandidate.deepFreshness,
      DEFAULT_WEB_SEARCH_SETTINGS.deepFreshness
    ),
    fastMaxSources: asIntegerInRange(
      typedCandidate.fastMaxSources,
      1,
      MAX_ALLOWED_SOURCES,
      legacyMaxSources ?? DEFAULT_WEB_SEARCH_SETTINGS.fastMaxSources
    ),
    deepMaxSources: asIntegerInRange(
      typedCandidate.deepMaxSources,
      1,
      MAX_ALLOWED_SOURCES,
      legacyMaxSources ?? DEFAULT_WEB_SEARCH_SETTINGS.deepMaxSources
    ),
    defuddleMode: asDefuddleMode(
      typedCandidate.defuddleMode,
      DEFAULT_WEB_SEARCH_SETTINGS.defuddleMode
    ),
    fastTimeoutMs: asIntegerInRange(
      typedCandidate.fastTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_WEB_SEARCH_SETTINGS.fastTimeoutMs
    ),
    deepTimeoutMs: asIntegerInRange(
      typedCandidate.deepTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_WEB_SEARCH_SETTINGS.deepTimeoutMs
    ),
    defuddleTimeoutMs: asIntegerInRange(
      typedCandidate.defuddleTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_WEB_SEARCH_SETTINGS.defuddleTimeoutMs
    ),
    fastQueryBudget: asIntegerInRange(
      typedCandidate.fastQueryBudget,
      MIN_QUERY_BUDGET,
      MAX_QUERY_BUDGET,
      DEFAULT_WEB_SEARCH_SETTINGS.fastQueryBudget
    ),
    deepQueryBudget: asIntegerInRange(
      typedCandidate.deepQueryBudget,
      MIN_QUERY_BUDGET,
      MAX_QUERY_BUDGET,
      DEFAULT_WEB_SEARCH_SETTINGS.deepQueryBudget
    ),
  };
}

function formatDuration(value: number): string {
  if (value % 1_000 === 0) {
    return `${value / 1_000}s (${value} ms)`;
  }
  return `${value} ms`;
}

function asMode(value: unknown, fallback: SearchMode): SearchMode {
  return value === "fast" || value === "deep" ? value : fallback;
}

function asFreshness(value: unknown, fallback: SearchFreshness): SearchFreshness {
  return value === "cached" || value === "indexed" || value === "live" ? value : fallback;
}

function asDefuddleMode(value: unknown, fallback: DefuddleMode): DefuddleMode {
  return value === "off" || value === "direct" || value === "fallback" || value === "both"
    ? value
    : fallback;
}

function asOptionalIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) {
    return undefined;
  }

  return rounded;
}

function asIntegerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return asOptionalIntegerInRange(value, min, max) ?? fallback;
}
