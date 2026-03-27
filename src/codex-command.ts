import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunCodexCommandOptions, RunCodexCommandResult } from "./types.js";

const CODEX_BINARY_NAMES =
  process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
const CODEX_COMMAND_ENV_KEYS = [
  "PI_CODEX_WEB_SEARCH_CODEX_PATH",
  "PI_CODEX_WEB_SEARCH_CODEX",
  "CODEX_PATH",
] as const;
const PACKAGE_ROOTS = [
  fileURLToPath(new URL("../node_modules/@openai", import.meta.url)),
  join(homedir(), "node_modules", "@openai"),
];

let cachedBundledCodexPath: string | undefined;

class CodexCommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Could not find Codex command: ${command}`);
    this.name = "CodexCommandNotFoundError";
  }
}

export async function runCodexCommand(
  options: RunCodexCommandOptions
): Promise<RunCodexCommandResult> {
  const candidates = await getCodexCommandCandidates(options.cwd);

  for (const command of candidates) {
    try {
      const result = await spawnCodexCommand(command, options);
      if (command !== "codex") {
        cachedBundledCodexPath = command;
      }
      return result;
    } catch (error) {
      if (error instanceof CodexCommandNotFoundError) {
        continue;
      }
      throw error;
    }
  }

  const tried = candidates.filter((candidate) => candidate !== "codex");
  const triedMessage =
    tried.length > 0 ? ` Checked: ${tried.map((path) => `\`${path}\``).join(", ")}.` : "";

  throw new Error(
    `Could not find \`codex\` in PATH or common install locations.${triedMessage} Install Codex CLI, then run \`codex login status\` or \`codex login\`.`
  );
}

export async function findBundledCodexExecutable(cwd?: string): Promise<string | undefined> {
  if (cachedBundledCodexPath && (await isExecutableFile(cachedBundledCodexPath))) {
    return cachedBundledCodexPath;
  }

  for (const root of getCodexPackageRoots(cwd)) {
    for (const packageName of await readDirectoryNames(root)) {
      if (!packageName.startsWith("codex")) {
        continue;
      }

      const packageDir = join(root, packageName);
      const directCandidate = await findCodexBinaryInPackage(packageDir);
      if (directCandidate) {
        cachedBundledCodexPath = directCandidate;
        return directCandidate;
      }
    }
  }

  return undefined;
}

async function getCodexCommandCandidates(cwd: string): Promise<string[]> {
  const candidates = [
    ...CODEX_COMMAND_ENV_KEYS.map((key) => process.env[key]?.trim()).filter(
      (value): value is string => !!value
    ),
    ...(cachedBundledCodexPath ? [cachedBundledCodexPath] : []),
    "codex",
  ];

  const bundledCodex = await findBundledCodexExecutable(cwd);
  if (bundledCodex) {
    candidates.push(bundledCodex);
  }

  return [...new Set(candidates)];
}

function getCodexPackageRoots(cwd?: string): string[] {
  const prefix = process.env.npm_config_prefix?.trim();

  return [
    cwd ? join(resolve(cwd), "node_modules", "@openai") : undefined,
    ...PACKAGE_ROOTS,
    prefix ? join(resolve(prefix), "lib", "node_modules", "@openai") : undefined,
    join(dirname(process.execPath), "..", "lib", "node_modules", "@openai"),
  ].filter((root): root is string => !!root);
}

async function findCodexBinaryInPackage(packageDir: string): Promise<string | undefined> {
  for (const binaryName of CODEX_BINARY_NAMES) {
    const directCandidates = [join(packageDir, binaryName), join(packageDir, "bin", binaryName)];
    for (const candidate of directCandidates) {
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  const vendorDir = join(packageDir, "vendor");
  for (const vendorEntry of await readDirectoryNames(vendorDir)) {
    for (const binaryName of CODEX_BINARY_NAMES) {
      const candidate = join(vendorDir, vendorEntry, "codex", binaryName);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnCodexCommand(
  command: string,
  options: RunCodexCommandOptions
): Promise<RunCodexCommandResult> {
  return new Promise<RunCodexCommandResult>((resolve, reject) => {
    const child = spawn(command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      const reason: unknown = options.signal?.reason;
      const error =
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "Codex web search was cancelled.");
      finish(() => reject(error));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => {
          reject(
            new Error(`Codex web search timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)
          );
        });
      }, timeoutMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        finish(() => reject(new CodexCommandNotFoundError(command)));
        return;
      }

      finish(() => reject(new Error(`Failed to start Codex CLI: ${error.message}`)));
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutLineBuffer += chunk;

      let newlineIndex = stdoutLineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutLineBuffer.slice(0, newlineIndex);
        options.onStdoutLine?.(line);
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutLineBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (stdoutLineBuffer) {
        options.onStdoutLine?.(stdoutLineBuffer);
      }
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
