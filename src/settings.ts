import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SearchFreshness, SearchMode, WebSearchSettings } from "./types.js";

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  defaultMode: "fast",
  fastFreshness: "cached",
  deepFreshness: "live",
};

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-codex-web-search.settings.json");

export async function loadSettings(path = SETTINGS_PATH): Promise<WebSearchSettings> {
  try {
    const raw = await readFile(path, "utf-8");
    try {
      return normalizeSettings(JSON.parse(raw) as unknown);
    } catch {
      return { ...DEFAULT_WEB_SEARCH_SETTINGS };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_WEB_SEARCH_SETTINGS };
    }
    throw error;
  }
}

export async function saveSettings(
  settings: Partial<WebSearchSettings>,
  path = SETTINGS_PATH
): Promise<WebSearchSettings> {
  const normalized = normalizeSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

export function formatSettings(settings: WebSearchSettings): string {
  return [
    `Default mode: ${settings.defaultMode}`,
    `Fast freshness: ${settings.fastFreshness}`,
    `Deep freshness: ${settings.deepFreshness}`,
  ].join("\n");
}

export function normalizeSettings(value: unknown): WebSearchSettings {
  const candidate = value && typeof value === "object" ? value : {};
  const typedCandidate = candidate as {
    defaultMode?: unknown;
    fastFreshness?: unknown;
    deepFreshness?: unknown;
  };

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
  };
}

function asMode(value: unknown, fallback: SearchMode): SearchMode {
  return value === "fast" || value === "deep" ? value : fallback;
}

function asFreshness(value: unknown, fallback: SearchFreshness): SearchFreshness {
  return value === "cached" || value === "live" ? value : fallback;
}
