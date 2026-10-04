import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  formatSettings,
  getSettingsPath,
  InvalidSettingsFileError,
  loadSettings,
  loadSettingsStrict,
  normalizeSettings,
  saveSettings,
  updateSettings,
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
  assert.match(formatted, /Search-call budgets:/);

  await rm(dir, { recursive: true, force: true });
});

void test("settings are stored in the Pi agent directory from PI_CODING_AGENT_DIR", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(getSettingsPath(), join(dir, "pi-codex-web-search.settings.json"));

  await saveSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS, defaultMode: "deep" });
  const raw = JSON.parse(await readFile(join(dir, "pi-codex-web-search.settings.json"), "utf-8"));
  assert.equal(raw.defaultMode, "deep");
  assert.equal((await loadSettings()).defaultMode, "deep");
});

void test("a settings file with invalid JSON falls back to defaults for searches only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  const broken = '{ "defaultMode": "deep", "fastMaxSources": 9, }\n';
  await writeFile(path, broken, "utf-8");

  assert.deepEqual(await loadSettings(path), DEFAULT_WEB_SEARCH_SETTINGS);
  await assert.rejects(loadSettingsStrict(path), InvalidSettingsFileError);
  // Editing one value must not replace the user's other values with defaults.
  await assert.rejects(updateSettings({ deepMaxSources: 3 }, path), /not valid JSON/);
  assert.equal(await readFile(path, "utf-8"), broken);
});

void test("updateSettings merges concurrent changes and leaves no temp files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");

  await Promise.all([
    updateSettings({ defaultMode: "deep" }, path),
    updateSettings({ fastMaxSources: 2 }, path),
    updateSettings({ deepQueryBudget: 40 }, path),
  ]);

  assert.deepEqual(await loadSettingsStrict(path), {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    defaultMode: "deep",
    fastMaxSources: 2,
    deepQueryBudget: 40,
  });
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

void test("updateSettings saves through a symlink and keeps the target's mode", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "dotfiles-settings.json");
  const link = join(dir, "settings.json");
  await writeFile(target, '{ "fastMaxSources": 7 }\n', { mode: 0o600 });
  await symlink(target, link);

  await updateSettings({ defaultMode: "deep" }, link);

  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.deepEqual(await loadSettingsStrict(target), {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    defaultMode: "deep",
    fastMaxSources: 7,
  });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), ["dotfiles-settings.json", "settings.json"]);
});

void test("saveSettings creates the target of a dangling symlink chain", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-web-search-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "agent"));
  await mkdir(join(dir, "dotfiles"));
  const link = join(dir, "agent", "settings.json");
  const middle = join(dir, "agent", "middle.json");
  const target = join(dir, "dotfiles", "settings.json");
  // Relative links, as stow creates them; the final file does not exist yet.
  await symlink("middle.json", link);
  await symlink("../dotfiles/settings.json", middle);

  await saveSettings({ defaultMode: "deep" }, link);

  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal((await lstat(middle)).isSymbolicLink(), true);
  assert.deepEqual(await loadSettingsStrict(target), {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    defaultMode: "deep",
  });
  assert.deepEqual(await readdir(join(dir, "dotfiles")), ["settings.json"]);
  assert.deepEqual((await readdir(join(dir, "agent"))).sort(), ["middle.json", "settings.json"]);
});
