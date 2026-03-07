# pi-codex-web-search

Pi extension that registers a `web_search` tool backed by your local `codex` CLI.

It is designed for the case where:

- you already use `codex`
- you are already authenticated with `codex login`
- you do **not** want to manage a separate API key inside the extension

## How it works

When Pi calls `web_search`, the extension runs Codex non-interactively:

- `codex exec --json`
- web-search freshness set explicitly to `cached` or `live`
- read-only sandbox
- ephemeral session
- structured JSON output enforced with `--output-schema`

The extension then:

- parses Codex's live JSONL events to show search progress in Pi
- tracks the actual search queries Codex issued
- keeps a running search counter in the tool UI
- uses persisted defaults for mode and freshness unless the tool call overrides mode
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
- `maxSources?: number` — optional cap from 1 to 10, default `5`
- `mode?: "fast" | "deep"` — optional depth override. If omitted, the saved default mode is used.

Behavior:

- uses the local Codex CLI
- requires a non-empty query
- defaults to saved settings of:
  - default mode = `fast`
  - fast freshness = `cached`
  - deep freshness = `live`
- supports explicit `deep` mode for broader research
- enforces smaller time/query budgets in fast mode so lightweight lookups do not run indefinitely
- shows live search queries and a running search counter in Pi's tool UI
- supports expanded tool details with `Ctrl+O`
- returns a compact answer with sources
- truncates oversized output and saves the full result to a temp file when needed
- fails clearly if `codex` is missing or `codex exec` fails

## Settings

Use the slash command below to persist defaults across sessions:

```text
/web-search-settings
```

You can also use direct subcommands:

```text
/web-search-settings status
/web-search-settings default-mode deep
/web-search-settings fast-freshness cached
/web-search-settings deep-freshness live
/web-search-settings reset
```

The settings file is stored under your Pi agent directory and is reused by future sessions.

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

## Notes

- This extension does **not** register the native OpenAI Responses `web_search` tool directly inside Pi.
- Instead, it exposes a Pi tool that delegates web research to the locally installed Codex CLI.
- That keeps auth and web-search behavior aligned with your existing Codex setup.

## License

MIT
