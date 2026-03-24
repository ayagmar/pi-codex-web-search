# pi-codex-web-search

Pi extension that registers a `web_search` tool backed by your local `codex` CLI.

It is designed for the case where:

- you already use `codex`
- you are already authenticated with `codex login`
- you do **not** want to manage a separate API key inside the extension

## How it works

When Pi calls `web_search`, the extension runs Codex non-interactively:

- `codex exec --json`
- `-c web_search="cached"` or `-c web_search="live"`
- read-only sandbox
- ephemeral session
- structured JSON output enforced with `--output-schema`
- final assistant message captured with `--output-last-message`

Codex's official web-search modes are `disabled | cached | live`.
This extension uses `cached` and `live` explicitly per tool call. In Codex CLI terms,
`--search` is equivalent to live web search.

The extension then:

- parses Codex JSONL events to show search progress in Pi
- tracks the actual search queries Codex issued across multiple item event shapes
- keeps a running search counter in the tool UI
- shows clearer in-flight status when fast mode nears its budget or auto-escalates
- uses persisted defaults for mode, freshness, and per-mode source caps unless the tool call overrides them
- records when a default fast search had to be retried as deep/live
- uses Defuddle for direct URL-only requests and supports optional URL fallback when Codex cannot produce a usable result
- returns a concise summary plus numbered sources with URLs and snippets

## Requirements

- Node.js 22+
- `codex` available in `PATH`
- authenticated Codex CLI session

Check your Codex auth state with:

```bash
codex login status
```

If needed, authenticate with:

```bash
codex login
```

## Install

From npm:

```bash
pi install npm:pi-codex-web-search
```

From the repository path:

```bash
pi install /absolute/path/to/pi-codex-web-search
```

Or load directly during development:

```bash
pi -e ./src/index.ts
```

For hot reload, place the extension in one of Pi's extension folders and run `/reload`.

## Tool

### `web_search`

Parameters:

- `query: string` — what to search for
- `maxSources?: number` — optional cap from 1 to 10. If omitted, the saved fast/deep default is used for the chosen mode.
- `mode?: "fast" | "deep"` — optional depth override. If omitted, the saved default mode is used.
- `freshness?: "cached" | "live"` — optional freshness override. Use `live` for time-sensitive questions.

Behavior:

- uses the local Codex CLI
- requires a non-empty query
- defaults to saved settings of:
  - default mode = `fast`
  - fast freshness = `cached`
  - deep freshness = `live`
  - fast max sources = `5`
  - deep max sources = `5`
- supports explicit `deep` mode for broader research
- supports explicit `cached`/`live` freshness overrides
- keeps `cached` as the default for normal fast lookups and only auto-promotes to `live` for strong recency cues like `today`, `latest`, `current`, `now`, `weather`, `price`, `breaking`, and `urgent`
- uses Defuddle immediately when the query is just a URL (including `https://defuddle.md/<url>` mirrors) when `defuddle-mode` allows direct extraction
- automatically retries one recoverable default fast search as `deep` + `live` when Codex times out, burns through the fast query budget, loses transport, or fails to emit a usable final response
- shows reconnects, WebSocket-to-HTTPS fallback, and the final classified failure cause in tool progress/details when they happen
- can fall back to Defuddle for single-URL extraction-style requests when Codex still fails after its own retries, if `defuddle-mode` enables fallback
- falls back to Codex's final JSONL agent message if `--output-last-message` comes back empty, and treats `turn.failed` / `error` JSONL events as first-class failure signals
- enforces smaller time/query budgets in fast mode so lightweight lookups do not run indefinitely
- warns when fast mode has consumed its full query budget and is about to fail or auto-escalate
- blocks repeated fast-mode retries within the same turn after fast mode has already been exhausted
- shows live search queries and a running search counter in Pi's tool UI
- supports expanded tool details with `Ctrl+O`
- returns a compact answer with sources
- truncates oversized output and saves the full result to a temp file when needed
- surfaces clearer Codex auth guidance, including `codex login status` and `codex login`, when authentication appears to be missing or expired
- soft-degrades recoverable Codex failures so Pi can keep going, while still failing clearly for missing `codex`, bad local config, cancellations, and auth problems

## Settings

Use the slash command below to persist defaults across sessions:

```text
/web-search-settings
```

The interactive dialog is grouped into:

- Search defaults
- Defuddle behavior
- Timeouts
- Query budgets

You can also use direct subcommands:

```text
/web-search-settings status
/web-search-settings default-mode deep
/web-search-settings fast-freshness cached
/web-search-settings deep-freshness live
/web-search-settings fast-max-sources 5
/web-search-settings deep-max-sources 5
/web-search-settings default-max-sources 5
/web-search-settings defuddle-mode direct
/web-search-settings fast-timeout-ms 90000
/web-search-settings deep-timeout-ms 240000
/web-search-settings defuddle-timeout-ms 45000
/web-search-settings fast-query-budget 10
/web-search-settings deep-query-budget 24
/web-search-settings reset
```

Notes:

- `default-max-sources` is kept as a compatibility alias and updates both `fast-max-sources` and `deep-max-sources`.
- The settings file is stored under your Pi agent directory and is reused by future sessions.
- Defaults include `defuddle-mode = direct` for URL-only extraction without surprising non-URL search behavior.
- Timeouts and search-query budgets are configurable for both fast and deep modes.

Note: current Codex docs describe the top-level `web_search` setting as the supported configuration surface. Older legacy settings such as `features.web_search_request` are deprecated.

## Example

Ask Pi something like:

> Search the web for the latest Codex CLI release notes and summarize the key changes.

Pi can call:

```json
{
  "query": "latest Codex CLI release notes",
  "maxSources": 3
}
```

## Development

```bash
pnpm install
pnpm run check
```

## Release

This repo includes a manual GitHub Actions release workflow modeled after the one used in `pi-copilot-queue`.

Requirements:

- `NPM_TOKEN` GitHub Actions secret configured for the repository
- permissions to run the `Release` workflow

You can trigger it from GitHub Actions with a `patch`, `minor`, or `major` bump, plus an optional first-release flag.

Local equivalents:

```bash
pnpm run release
pnpm run release:first
```

## Notes

- This extension does **not** register the native OpenAI Responses `web_search` tool directly inside Pi.
- Instead, it exposes a Pi tool that delegates web research to the locally installed Codex CLI.
- That keeps auth and web-search behavior aligned with your existing Codex setup.

## License

MIT
