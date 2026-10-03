import { type SearchFreshness, type SearchMode } from "./types.js";

export interface SearchGateParams {
  query: string;
  maxSources?: number;
  mode?: SearchMode;
  freshness?: SearchFreshness;
}

export interface SearchGateResult {
  content: { type: "text"; text: string }[];
  details: object;
}

interface ActiveSearch {
  toolCallId: string;
  query: string;
  key: string;
  promise: Promise<SearchGateResult>;
}

const MAX_TURN_CACHE_ENTRIES = 16;

export function buildSearchKey(params: SearchGateParams): string {
  return JSON.stringify([
    params.query.trim().toLowerCase(),
    params.mode ?? "",
    params.freshness ?? "",
    params.maxSources ?? "",
  ]);
}

/**
 * Serializes web searches within a Pi session:
 * - identical concurrent requests await the same in-flight promise,
 * - repeated requests within one turn are served from a small result cache,
 * - differing concurrent requests are skipped with guidance to combine them.
 *
 * `context` carries per-call state (abort signal, progress callback, cwd) and
 * is handed to `run` for the call that actually starts the search, so sibling
 * calls can never overwrite another call's signal or progress sink.
 */
export function createSearchGate<TContext = void>(
  run: (
    toolCallId: string,
    params: SearchGateParams,
    context: TContext
  ) => Promise<SearchGateResult>
): {
  execute: (
    toolCallId: string,
    params: SearchGateParams,
    context: TContext
  ) => Promise<SearchGateResult>;
  reset: () => void;
} {
  let active: ActiveSearch | undefined;
  const turnCache = new Map<string, SearchGateResult>();

  const execute = async (
    toolCallId: string,
    params: SearchGateParams,
    context: TContext
  ): Promise<SearchGateResult> => {
    const key = buildSearchKey(params);

    const cached = turnCache.get(key);
    if (cached) {
      return {
        content: cached.content,
        details: { ...cached.details, servedFromTurnCache: true },
      };
    }

    if (active) {
      const owner = active;
      if (owner.key === key) {
        const result = await owner.promise;
        return {
          content: result.content,
          details: { ...result.details, coalescedWithToolCallId: owner.toolCallId },
        };
      }

      return buildSkippedResult(owner, params);
    }

    const promise = run(toolCallId, params, context);
    active = { toolCallId, query: params.query, key, promise };

    try {
      const result = await promise;
      if (isCacheableResult(result)) {
        if (turnCache.size >= MAX_TURN_CACHE_ENTRIES) {
          const oldestKey = turnCache.keys().next().value;
          if (oldestKey !== undefined) {
            turnCache.delete(oldestKey);
          }
        }
        turnCache.set(key, result);
      }
      return result;
    } finally {
      if (active?.toolCallId === toolCallId) {
        active = undefined;
      }
    }
  };

  const reset = (): void => {
    turnCache.clear();
  };

  return { execute, reset };
}

function isCacheableResult(result: SearchGateResult): boolean {
  const details = result.details as {
    failure?: unknown;
    concurrentSearchSkipped?: unknown;
  };
  return details.failure === undefined && details.concurrentSearchSkipped === undefined;
}

function buildSkippedResult(active: ActiveSearch, params: SearchGateParams): SearchGateResult {
  return {
    content: [
      {
        type: "text",
        text: [
          "Skipped this concurrent web search because another web_search call is already running.",
          `Active request: ${active.query}`,
          `Skipped request: ${params.query}`,
          "Wait for the active result, then issue one follow-up search only if it is still needed. Combine related subquestions instead of launching parallel searches.",
        ].join("\n"),
      },
    ],
    details: {
      concurrentSearchSkipped: true,
      activeToolCallId: active.toolCallId,
      activeQuery: active.query,
      skippedQuery: params.query,
    },
  };
}
