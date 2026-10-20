import { compileMatcher, firstMatches } from '@/search/matcher';

/**
 * Runs a regex against many texts under a time budget. The static guard in
 * `matcher.ts` rejects the known catastrophic shapes; this is the backstop for
 * whatever it misses: the match runs in a Worker, and if it has not answered
 * within `REGEX_TIME_BUDGET_MS` the worker is terminated (a fresh one serves
 * the next run) and the caller gets an error instead of a frozen tab.
 *
 * Superseding: a newer `run()` abandons an older in-flight one. The older call
 * resolves `{ ok: false, error: SUPERSEDED_ERROR }`; callers should ignore it.
 */

export const REGEX_TIME_BUDGET_MS = 1000;
export const TIMEOUT_ERROR = 'This pattern took too long to run';
export const SUPERSEDED_ERROR = 'superseded';

export interface RegexMatch {
  index: number;
  length: number;
}
export type RegexRunResult = { ok: true; matches: (RegexMatch | null)[] } | { ok: false; error: string };

export interface RegexExecutor {
  run(pattern: string, texts: readonly string[]): Promise<(RegexMatch | null)[]>;
  terminate(): void;
}
export interface RegexRunner {
  run(pattern: string, texts: readonly string[]): Promise<RegexRunResult>;
  dispose(): void;
}

/**
 * In-thread executor. NO protection against a slow pattern: it exists only
 * for environments without `Worker` (the test runner).
 */
function createInThreadExecutor(): RegexExecutor {
  return {
    run: async (pattern, texts) => {
      const r = firstMatches(pattern, texts);
      if (!r.ok) throw new Error(r.error);
      return r.matches;
    },
    terminate: () => {},
  };
}

function createWorkerExecutor(): RegexExecutor {
  const worker = new Worker(new URL('./regexRunner.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  return {
    run: (pattern, texts) =>
      new Promise((resolve, reject) => {
        const id = (nextId += 1);
        worker.onmessage = (event: MessageEvent<{ id: number; result: RegexRunResult }>) => {
          if (event.data.id !== id) return;
          const { result } = event.data;
          if (result.ok) resolve(result.matches);
          else reject(new Error(result.error));
        };
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage({ id, pattern, texts: [...texts] });
      }),
    terminate: () => worker.terminate(),
  };
}

function defaultExecutor(): RegexExecutor {
  return typeof Worker === 'undefined' ? createInThreadExecutor() : createWorkerExecutor();
}

export function createRegexRunner(
  options: { createExecutor?: () => RegexExecutor; budgetMs?: number } = {},
): RegexRunner {
  const createExecutor = options.createExecutor ?? defaultExecutor;
  const budgetMs = options.budgetMs ?? REGEX_TIME_BUDGET_MS;
  let executor: RegexExecutor | null = null;
  let current = 0;
  let abandon: (() => void) | null = null;

  const drop = () => {
    executor?.terminate();
    executor = null;
  };

  return {
    run(pattern, texts) {
      // A newer run supersedes an in-flight one; its executor may be busy, so drop it.
      if (abandon !== null) {
        abandon();
        drop();
      }
      const compiled = compileMatcher(pattern, { regex: true });
      if (!compiled.ok) return Promise.resolve({ ok: false, error: compiled.error });

      current += 1;
      const mine = current;
      executor ??= createExecutor();
      const exec = executor;

      return new Promise<RegexRunResult>((resolve) => {
        let settled = false;
        const finish = (result: RegexRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (abandon === abandonMine) abandon = null;
          resolve(result);
        };
        const abandonMine = () => finish({ ok: false, error: SUPERSEDED_ERROR });
        abandon = abandonMine;
        const timer = setTimeout(() => {
          if (executor === exec) drop();
          finish({ ok: false, error: TIMEOUT_ERROR });
        }, budgetMs);
        exec.run(pattern, texts).then(
          (matches) => finish(mine === current ? { ok: true, matches } : { ok: false, error: SUPERSEDED_ERROR }),
          (e: unknown) => finish({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      });
    },
    dispose() {
      abandon?.();
      drop();
    },
  };
}
