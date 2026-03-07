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
  });

  assert.deepEqual(normalized, {
    defaultMode: DEFAULT_WEB_SEARCH_SETTINGS.defaultMode,
    fastFreshness: "live",
    deepFreshness: DEFAULT_WEB_SEARCH_SETTINGS.deepFreshness,
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
      defaultMode: "deep",
      fastFreshness: "live",
      deepFreshness: "cached",
    },
    path
  );

  assert.deepEqual(saved, {
    defaultMode: "deep",
    fastFreshness: "live",
    deepFreshness: "cached",
  });

  const loaded = await loadSettings(path);
  assert.deepEqual(loaded, saved);

  const raw = await readFile(path, "utf-8");
  assert.match(raw, /"defaultMode": "deep"/);
  assert.match(formatSettings(loaded), /Fast freshness: live/);

  await rm(dir, { recursive: true, force: true });
});
