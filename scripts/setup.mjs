import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = createInterface({ input: stdin, output: stdout });

try {
  const current = await readCurrentTemplateValues();

  const extensionName = await ask("Extension name", current.extensionName);
  const packageName = await ask("npm package name", current.packageName);
  const description = await ask("Description", current.description);
  const command = normalizeCommand(await ask("Command name", current.command));

  const defaultToolName =
    current.toolName === `${current.command}_echo` ? `${command}_echo` : current.toolName;
  const defaultStateType =
    current.stateType === `${current.command}:state` ? `${command}:state` : current.stateType;

  const toolName = await ask("Tool name", defaultToolName);
  const stateType = await ask("State entry type", defaultStateType);

  await updateConstants({ extensionName, command, toolName, stateType });
  await updatePackage({ packageName, description, extensionName });
  await updateStarterNames(current, { command, toolName });
  await updateTestNames(current, { command, toolName });

  stdout.write("\nTemplate setup complete.\n");
  stdout.write("Run `pnpm run check` next.\n");
} finally {
  rl.close();
}

async function ask(label, fallback) {
  const value = await rl.question(`${label} [${fallback}]: `);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeCommand(value) {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return cleaned.length > 0 ? cleaned : "myext";
}

async function readCurrentTemplateValues() {
  const constants = await readFile("src/constants.ts", "utf8");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));

  const command = readConst(constants, "EXTENSION_COMMAND", "myext");

  return {
    extensionName: readConst(constants, "EXTENSION_NAME", "my-pi-extension"),
    command,
    toolName: readConst(constants, "TOOL_NAME", `${command}_echo`),
    stateType: readConst(constants, "STATE_ENTRY_TYPE", `${command}:state`),
    packageName:
      typeof pkg.name === "string" && pkg.name.trim().length > 0 ? pkg.name : "my-pi-extension",
    description:
      typeof pkg.description === "string" && pkg.description.trim().length > 0
        ? pkg.description
        : "Starter template for building robust Pi extensions",
  };
}

function readConst(content, constName, fallback) {
  const match = content.match(new RegExp(`export const ${constName} = "([^"]*)";`));
  return match?.[1] ?? fallback;
}

async function updateConstants({ extensionName, command, toolName, stateType }) {
  const path = "src/constants.ts";
  let content = await readFile(path, "utf8");

  content = replaceConst(content, "EXTENSION_NAME", extensionName);
  content = replaceConst(content, "EXTENSION_COMMAND", command);
  content = replaceConst(content, "TOOL_NAME", toolName);
  content = replaceConst(content, "STATE_ENTRY_TYPE", stateType);

  await writeFile(path, content);
}

async function updatePackage({ packageName, description, extensionName }) {
  const path = "package.json";
  const pkg = JSON.parse(await readFile(path, "utf8"));

  pkg.name = packageName;
  pkg.description = description;

  if (pkg.pi?.image && typeof pkg.pi.image === "string") {
    pkg.pi.image = `https://placehold.co/1200x630/png?text=${encodeURIComponent(extensionName)}`;
  }

  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function updateStarterNames(previous, next) {
  const files = [
    "starters/event-only.ts",
    "starters/tool-only.ts",
    "starters/command-only.ts",
    "starters/hybrid.ts",
    "starters/ui-only.ts",
  ];

  for (const path of files) {
    let content = await readFile(path, "utf8");
    content = replaceTemplateNames(content, previous, next);
    await writeFile(path, content);
  }
}

function replaceTemplateNames(content, previous, next) {
  const toolCandidates = Array.from(new Set([previous.toolName, "myext_echo"]));
  const commandCandidates = Array.from(new Set([previous.command, "myext"]));

  let updated = content;

  for (const tool of toolCandidates) {
    if (tool === next.toolName) continue;
    updated = updated.split(`"${tool}"`).join(`"${next.toolName}"`);
  }

  for (const command of commandCandidates) {
    if (command === next.command) continue;
    updated = updated.split(`"${command}"`).join(`"${next.command}"`);
    updated = updated.split(`/${command}`).join(`/${next.command}`);
  }

  return updated;
}

function replaceConst(content, constName, value) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const pattern = new RegExp(`(export const ${constName} = )"[^"]*";`);
  return content.replace(pattern, `$1"${escaped}";`);
}

async function updateTestNames(previous, next) {
  const files = ["test/starters.test.ts"];

  for (const path of files) {
    let content = await readFile(path, "utf8");
    content = replaceTemplateNames(content, previous, next);
    await writeFile(path, content);
  }
}
