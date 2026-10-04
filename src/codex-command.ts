import { type ChildProcess, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunCodexCommandOptions, type RunCodexCommandResult } from "./types.js";

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

// Cap accumulated subprocess output so a runaway Codex process or a huge
// page cannot exhaust extension memory. Line callbacks still see every line;
// only the aggregated stdout/stderr strings are bounded.
export const MAX_CAPTURED_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTURED_STDERR_BYTES = 1024 * 1024;
// A single JSONL line should never approach this; newline-free floods are
// truncated to their tail (an incomplete line simply fails JSON parsing).
export const MAX_LINE_BUFFER_BYTES = 2 * 1024 * 1024;

export function appendBounded(buffer: string, chunk: string, maxBytes: number): string {
  const combined = buffer + chunk;
  if (combined.length <= maxBytes) {
    return combined;
  }
  // Keep the tail: final agent messages and errors arrive last.
  return combined.slice(combined.length - maxBytes);
}

// A Codex binary auto-detected in a common install location. Only paths from
// cwd-independent roots are ever cached, and only after they spawned.
let cachedBundledCodexPath: string | undefined;

class CodexCommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Could not find Codex command: ${command}`);
    this.name = "CodexCommandNotFoundError";
  }
}

/**
 * Runs Codex, resolved in this order: explicit env overrides, `codex` on
 * PATH, then a binary auto-detected in a common npm install location. The
 * workspace's own node_modules is never searched: a repository opened in Pi
 * must not be able to supply the binary that runs.
 */
export async function runCodexCommand(
  options: RunCodexCommandOptions
): Promise<RunCodexCommandResult> {
  // spawn reports a missing working directory as ENOENT, which would
  // otherwise read as "Codex is not installed".
  if (!(await isDirectory(options.cwd))) {
    throw new Error(
      `Failed to start Codex CLI: the working directory ${options.cwd} does not exist.`
    );
  }

  const tried: string[] = [];

  for (const command of getConfiguredCodexCommands()) {
    const result = await trySpawnCodexCommand(command, options);
    if (result) {
      return result;
    }
    tried.push(command);
    if (command === cachedBundledCodexPath) {
      cachedBundledCodexPath = undefined;
    }
  }

  const bundledCodex = await findBundledCodexExecutable();
  if (bundledCodex && !tried.includes(bundledCodex)) {
    const result = await trySpawnCodexCommand(bundledCodex, options);
    if (result) {
      cachedBundledCodexPath = bundledCodex;
      return result;
    }
    tried.push(bundledCodex);
  }

  const checked = tried.filter((candidate) => candidate !== "codex");
  const triedMessage =
    checked.length > 0 ? ` Checked: ${checked.map((path) => `\`${path}\``).join(", ")}.` : "";

  throw new Error(
    `Could not find \`codex\` in PATH or common install locations.${triedMessage} Install Codex CLI, then run \`codex login status\` or \`codex login\`.`
  );
}

async function trySpawnCodexCommand(
  command: string,
  options: RunCodexCommandOptions
): Promise<RunCodexCommandResult | undefined> {
  try {
    return await spawnCodexCommand(command, options);
  } catch (error) {
    if (error instanceof CodexCommandNotFoundError) {
      return undefined;
    }
    throw error;
  }
}

function getConfiguredCodexCommands(): string[] {
  return [
    ...new Set([
      ...CODEX_COMMAND_ENV_KEYS.map((key) => process.env[key]?.trim()).filter(
        (value): value is string => !!value
      ),
      "codex",
      ...(cachedBundledCodexPath ? [cachedBundledCodexPath] : []),
    ]),
  ];
}

export async function findBundledCodexExecutable(
  roots: readonly string[] = getCodexPackageRoots()
): Promise<string | undefined> {
  for (const root of roots) {
    for (const packageName of await readDirectoryNames(root)) {
      if (!packageName.startsWith("codex")) {
        continue;
      }

      const directCandidate = await findCodexBinaryInPackage(join(root, packageName));
      if (directCandidate) {
        return directCandidate;
      }
    }
  }

  return undefined;
}

function getCodexPackageRoots(): string[] {
  const prefix = process.env.npm_config_prefix?.trim();

  return [
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
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

export function toCancellationError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : fallbackMessage);
}

/** How long a child gets to exit after SIGTERM before it is sent SIGKILL. */
export const FORCE_KILL_DELAY_MS = 2_000;

/**
 * Sends SIGTERM to a child that runs in the caller's process group, then
 * SIGKILL if it has not exited after `delayMs`. `child.kill` is a no-op once
 * the child has exited, so a late SIGKILL can never reach a recycled PID.
 */
export function terminateWithForceKill(child: ChildProcess, delayMs = FORCE_KILL_DELAY_MS): void {
  child.kill("SIGTERM");
  const forceKillId = setTimeout(() => child.kill("SIGKILL"), delayMs);
  forceKillId.unref?.();
  child.once("close", () => clearTimeout(forceKillId));
}

function terminateChild(
  child: ReturnType<typeof spawn>,
  afterTerminate?: () => void,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the timeout/abort and the kill.
  }
  afterTerminate?.();
}

function spawnCodexCommand(
  command: string,
  options: RunCodexCommandOptions
): Promise<RunCodexCommandResult> {
  return new Promise<RunCodexCommandResult>((resolve, reject) => {
    // Never start Codex for a search that is already cancelled: the child
    // would only be killed again, and a spawn failure (ENOENT) would surface
    // as an unhandled "error" event once no listener is attached.
    if (options.signal?.aborted) {
      reject(toCancellationError(options.signal.reason, "Codex web search was cancelled."));
      return;
    }

    const child = spawn(command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // Put Codex in its own process group so a timeout cannot leave a
      // spawned network/helper process running after Pi has moved on.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let forceKillId: NodeJS.Timeout | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const scheduleForceKill = (): void => {
      forceKillId = setTimeout(
        () => terminateChild(child, undefined, "SIGKILL"),
        FORCE_KILL_DELAY_MS
      );
      forceKillId.unref?.();
    };

    const onAbort = (): void => {
      terminateChild(child, scheduleForceKill);
      const error = toCancellationError(options.signal?.reason, "Codex web search was cancelled.");
      finish(() => reject(error));
    };

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      timeoutId = setTimeout(() => {
        terminateChild(child, scheduleForceKill);
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
      stdout = appendBounded(stdout, chunk, MAX_CAPTURED_STDOUT_BYTES);
      stdoutLineBuffer = appendBounded(stdoutLineBuffer, chunk, MAX_LINE_BUFFER_BYTES);

      let newlineIndex = stdoutLineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutLineBuffer.slice(0, newlineIndex);
        options.onStdoutLine?.(line);
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutLineBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf-8");
    let stderrLineBuffer = "";
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, MAX_CAPTURED_STDERR_BYTES);
      stderrLineBuffer = appendBounded(stderrLineBuffer, chunk, MAX_LINE_BUFFER_BYTES);

      let newlineIndex = stderrLineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        options.onStderrLine?.(stderrLineBuffer.slice(0, newlineIndex));
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1);
        newlineIndex = stderrLineBuffer.indexOf("\n");
      }
    });

    child.on("close", (code) => {
      // The child is gone; a pending force-kill must not fire against a
      // recycled PID or process group.
      if (forceKillId) clearTimeout(forceKillId);
      if (stdoutLineBuffer) {
        options.onStdoutLine?.(stdoutLineBuffer);
      }
      if (stderrLineBuffer) {
        options.onStderrLine?.(stderrLineBuffer);
      }
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });

    // Codex can exit (bad config, auth failure, cancellation) before reading
    // the prompt; the resulting EPIPE on stdin would otherwise be an uncaught
    // error in the Pi process. The exit code and stderr already report the
    // failure through the "close" handler.
    child.stdin.on("error", () => {});

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}
