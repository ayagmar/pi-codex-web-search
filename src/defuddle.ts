import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DEFUDDLE_TIMEOUT_MS } from "./constants.js";
import type { DefuddleParseResult, RunDefuddleCommandOptions } from "./types.js";

const require = createRequire(import.meta.url);
const DEFUDDLE_URL_PREFIX = "https://defuddle.md/";
const URL_PATTERN = /https?:\/\/\S+/giu;

interface DefuddleCliOutput {
  content?: unknown;
  contentMarkdown?: unknown;
  title?: unknown;
  description?: unknown;
  domain?: unknown;
  author?: unknown;
  published?: unknown;
  wordCount?: unknown;
}

export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  const urls: string[] = [];

  for (const match of matches) {
    const normalized = normalizeMatchedUrl(match);
    if (!normalized) continue;
    if (urls.includes(normalized)) continue;
    urls.push(normalized);
  }

  return urls;
}

export function getDirectUrlQuery(query: string): string | undefined {
  const matches = query.match(URL_PATTERN) ?? [];
  if (matches.length !== 1) {
    return undefined;
  }

  const rawUrl = matches[0];
  if (!rawUrl) {
    return undefined;
  }

  const directUrl = normalizeMatchedUrl(rawUrl);
  if (!directUrl) {
    return undefined;
  }

  const remainder = query.replace(rawUrl, " ").trim();
  return remainder ? undefined : directUrl;
}

export function buildDefuddleSnippet(result: DefuddleParseResult): string {
  const description = result.description.trim();
  if (description) {
    return description;
  }

  const preview = extractPreview(result.content, 280);
  if (preview) {
    return preview;
  }

  return result.wordCount > 0
    ? `Extracted clean page content (${result.wordCount} words).`
    : "Extracted clean page content.";
}

export function buildDefuddleSummary(
  results: DefuddleParseResult[],
  options: { directUrlQuery: boolean; reason: string }
): string {
  if (results.length === 0) {
    return options.reason;
  }

  if (results.length === 1) {
    const first = results[0];
    if (!first) {
      return options.reason;
    }

    const title = first.title.trim() || first.url;
    const preview = buildDefuddleSnippet(first);
    const prefix = options.directUrlQuery
      ? `Defuddle extracted clean content directly from ${title}.`
      : `Codex did not produce a usable response, so Defuddle extracted clean content from ${title}.`;

    return preview ? `${prefix} ${preview}` : prefix;
  }

  return `Codex did not produce a usable response, so Defuddle extracted clean content from ${results.length} referenced pages.`;
}

export async function runDefuddleCommand(
  options: RunDefuddleCommandOptions
): Promise<DefuddleParseResult> {
  const cliPath = resolveDefuddleCliPath();

  return new Promise<DefuddleParseResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "parse", options.url, "--markdown", "--json"], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
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
          : new Error(typeof reason === "string" ? reason : "Defuddle extraction was cancelled.");
      finish(() => reject(error));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    const timeoutMs = options.timeoutMs ?? DEFUDDLE_TIMEOUT_MS;
    timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => {
        reject(
          new Error(`Defuddle extraction timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)
        );
      });
    }, timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      finish(() => reject(new Error(`Failed to start Defuddle: ${error.message}`)));
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `Defuddle exited with code ${code ?? 1}.`;
        finish(() => reject(new Error(message)));
        return;
      }

      try {
        const parsed = parseDefuddleOutput(stdout, options.url);
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  });
}

function resolveDefuddleCliPath(): string {
  try {
    const defuddleEntry = require.resolve("defuddle");
    return join(dirname(defuddleEntry), "cli.js");
  } catch {
    throw new Error(
      "Could not resolve the `defuddle` package. Reinstall the extension dependencies."
    );
  }
}

function parseDefuddleOutput(stdout: string, url: string): DefuddleParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Defuddle returned invalid JSON: ${message}`);
  }

  const output = parsed as DefuddleCliOutput;
  const content = pickString(output.contentMarkdown) || pickString(output.content);
  if (!content) {
    throw new Error("Defuddle did not return any extracted content.");
  }

  return {
    url,
    title: pickString(output.title),
    description: pickString(output.description),
    domain: pickString(output.domain),
    author: pickString(output.author),
    published: pickString(output.published),
    wordCount: pickNumber(output.wordCount),
    content,
  };
}

function normalizeMatchedUrl(value: string): string | undefined {
  const cleaned = trimTrailingPunctuation(value.trim());
  const unwrapped = unwrapDefuddleUrl(cleaned);

  try {
    const url = new URL(unwrapped);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function unwrapDefuddleUrl(url: string): string {
  if (!url.startsWith(DEFUDDLE_URL_PREFIX)) {
    return url;
  }

  const candidate = url.slice(DEFUDDLE_URL_PREFIX.length);
  return candidate.startsWith("http://") || candidate.startsWith("https://") ? candidate : url;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[\s),.;:!?]+$/u, "");
}

function extractPreview(content: string, maxLength: number): string {
  const collapsed = content.replace(/\s+/gu, " ").trim();
  if (!collapsed) {
    return "";
  }

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  const sentences = collapsed.match(/[^.!?]+[.!?]?/gu) ?? [];
  let preview = "";

  for (const sentence of sentences) {
    const next = `${preview} ${sentence}`.trim();
    if (next.length > maxLength) {
      break;
    }
    preview = next;
    if (preview.length >= Math.floor(maxLength * 0.7)) {
      break;
    }
  }

  if (preview) {
    return preview;
  }

  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
