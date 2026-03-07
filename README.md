# Pi Extension Template

A practical starter for building Pi extensions that are easy to ship, test, and maintain.

## What you get

- Strict TypeScript + ESLint + Prettier
- Unit tests + smoke test
- GitHub Actions CI with individual step reporting
- A minimal default extension in `src/index.ts`
- Multiple architecture starters in `starters/`

## Quick start

1. Click **Use this template** on GitHub
2. Clone your new repo
3. Install dependencies

```bash
pnpm install
```

This template uses [pnpm](https://pnpm.io/) for faster installs and disk efficiency. npm works too—just replace `pnpm` with `npm` in all commands.

4. Run the setup script to customize names

```bash
pnpm run setup-template
```

This updates `src/constants.ts`, `package.json`, and starter files with your extension name.

5. Run checks

```bash
pnpm run check
```

6. Load it in Pi

```bash
pi -e ./src/index.ts
```

For reloadable dev, place it in:

- `~/.pi/agent/extensions/` (global)
- `.pi/extensions/` (project)

Then use `/reload`.

## Choose your extension pattern

Not all Pi extensions need commands or tools. Pick a starter that matches your use case:

- `starters/event-only.ts` → listeners/interceptors/guards (`tool_call`, `tool_result`, shortcut)
- `starters/tool-only.ts` → model-callable tools + result interception + custom rendering
- `starters/command-only.ts` → slash command UX + a small interactive picker + shortcut
- `starters/hybrid.ts` → command + tool + event hooks + shortcut
- `starters/ui-only.ts` → status line, widget, custom dashboard via `ctx.ui.custom()`, shortcut

Replace the default `src/index.ts` with your chosen starter:

```bash
cp starters/event-only.ts src/index.ts
pnpm run check
```

**Note:** If you copy a starter into `src/index.ts` **before** running `setup-template`, `src/index.ts` keeps the old `myext` names. Either:

- Run `setup-template` first, then copy the starter
- Or copy the starter first, then run setup and manually update names in `src/index.ts`

## Install methods (direct + extmgr)

### Direct with Pi

From local path:

```bash
pi install /absolute/path/to/your-extension-repo
```

From GitHub (before publishing):

```bash
pi install git:github.com/yourusername/your-repo
# or
pi install https://github.com/yourusername/your-repo
```

From npm (after publishing):

```bash
pi install npm:your-package-name
```

### With `pi-extmgr`

Install extmgr once:

```bash
pi install npm:pi-extmgr
```

Then inside Pi:

```bash
/extensions install /absolute/path/to/your-extension-repo
/extensions install git:github.com/yourusername/your-repo
/extensions install npm:your-package-name
```

You can also open the interactive manager with `/extensions` and install from there.

If Pi is already running, run `/reload` after install.

## Customize

The `setup-template` script updates most files automatically. To customize manually:

Update `src/constants.ts`:

- `EXTENSION_NAME`
- `EXTENSION_COMMAND`
- `TOOL_NAME`
- `STATE_ENTRY_TYPE`

Update `package.json`:

- `name`
- `description`
- `pi.image` (for package gallery)

Update `LICENSE`:

- Replace `Your Name` with your actual name or organization

## Scripts

```bash
pnpm run setup-template
pnpm run typecheck
pnpm run test
pnpm run smoke-test
pnpm run lint
pnpm run format:check
pnpm run check
```

## Testing notes

- `test/commands.test.ts`, `test/tool.test.ts`, `test/extension.test.ts` cover core template logic
- `test/starters.test.ts` validates starter behavior patterns (registration + key flow)

## Docs worth reading

- [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [development.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/development.md)
- [packages.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [examples/extensions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)

## Share your extension

Add the `pi-package` keyword to `package.json` (already included) and publish to npm.
Your extension will appear in the [Pi package gallery](https://pi.dev/packages)
and on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package).

Add `pi.video` or `pi.image` in `package.json` for a gallery preview
(see [packages.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md#gallery-metadata)).

## License

MIT
