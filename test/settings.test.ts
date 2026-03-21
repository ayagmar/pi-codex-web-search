import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  formatSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../src/settings.js";

void test("normalizeSettings fills invalid values with defaults", () => {
  const normalized = normalizeSettings({
    defaultMode: "bad",
    fastFreshness: "live",
    deepFreshness: 42,
    fastMaxSources: 999,
    deepMaxSources: 0,
    defuddleMode: "broken",
    fastTimeoutMs: 1,
    deepTimeoutMs: 999999999,
    defuddleTimeoutMs: "slow",
    fastQueryBudget: 0,
    deepQueryBudget: 999,
  });

  assert.deepEqual(normalized, {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    fastFreshness: "live",
  });
});

void test("normalizeSettings migrates legacy defaultMaxSources into both mode-specific defaults", () => {
  const normalized = normalizeSettings({
    defaultMaxSources: 7,
  });

  assert.deepEqual(normalized, {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    fastMaxSources: 7,
    deepMaxSources: 7,
  });
});

void test("loadSettings returns defaults when the file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-settings-"));
  const path = join(dir, "settings.json");

  const settings = await loadSettings(path);
  assert.deepEqual(settings, DEFAULT_WEB_SEARCH_SETTINGS);

  await rm(dir, { recursive: true, force: true });
});

void test("saveSettings writes normalized settings that loadSettings can read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-settings-"));
  const path = join(dir, "settings.json");

  const saved = await saveSettings(
    {
      ...DEFAULT_WEB_SEARCH_SETTINGS,
      defaultMode: "deep",
      fastFreshness: "live",
      deepFreshness: "cached",
      fastMaxSources: 3,
      deepMaxSources: 7,
      defuddleMode: "both",
      fastTimeoutMs: 120_000,
      deepTimeoutMs: 300_000,
      defuddleTimeoutMs: 60_000,
      fastQueryBudget: 12,
      deepQueryBudget: 30,
    },
    path
  );

  assert.deepEqual(saved, {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    defaultMode: "deep",
    fastFreshness: "live",
    deepFreshness: "cached",
    fastMaxSources: 3,
    deepMaxSources: 7,
    defuddleMode: "both",
    fastTimeoutMs: 120_000,
    deepTimeoutMs: 300_000,
    defuddleTimeoutMs: 60_000,
    fastQueryBudget: 12,
    deepQueryBudget: 30,
  });

  const loaded = await loadSettings(path);
  assert.deepEqual(loaded, saved);

  const raw = await readFile(path, "utf-8");
  assert.match(raw, /"defaultMode": "deep"/);
  assert.match(raw, /"fastMaxSources": 3/);
  assert.match(raw, /"deepMaxSources": 7/);

  const formatted = formatSettings(loaded);
  assert.match(formatted, /Search defaults:/);
  assert.match(formatted, /Fast freshness: live/);
  assert.match(formatted, /Fast max sources: 3/);
  assert.match(formatted, /Deep max sources: 7/);
  assert.match(formatted, /Defuddle behavior:/);
  assert.match(formatted, /Timeouts:/);
  assert.match(formatted, /Fast: 120s/);
  assert.match(formatted, /Query budgets:/);

  await rm(dir, { recursive: true, force: true });
});
