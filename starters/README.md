# Starter patterns

Use these as drop-in starting points for `src/index.ts`.

- `event-only.ts` → listeners/interceptors/guards (`tool_call`, `tool_result`, shortcut)
- `tool-only.ts` → model-callable tools, plus result post-processing via `tool_result`
- `command-only.ts` → user slash UX, including a small interactive `select` flow and shortcut
- `hybrid.ts` → event + command + tool + shortcut in one file
- `ui-only.ts` → status line, widget, custom dashboard via `ctx.ui.custom()`, shortcut

Quick copy examples:

```bash
cp starters/event-only.ts src/index.ts
# or
cp starters/tool-only.ts src/index.ts
```

Then run:

```bash
pnpm run check
```

## Setup order

If you copy a starter into `src/index.ts` **before** running `pnpm run setup-template`,
the new file keeps the default `myext` names. Either:

- Run `setup-template` first, then copy the starter
- Or copy the starter first, then run `setup-template` and manually update names in `src/index.ts`
