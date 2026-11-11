// "Is anything answering at Ollama's address?", asked from the main process,
// where CORS does not apply. The renderer can't tell "not running" from
// "running but refusing this origin" (both are an opaque fetch failure), so
// `checkOllamaSetup` uses this to tell them apart. Pure apart from `fetchImpl`.

/** How long the probe waits before calling Ollama unreachable. */
export const OLLAMA_PROBE_TIMEOUT_MS = 2000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * `<baseUrl>/api/tags`, or null unless `baseUrl` is a plain `http:` URL on
 * `localhost` or `127.0.0.1` (spec §5: same-machine Ollama only). The main
 * process fetches this on the renderer's say-so, so anything else, including
 * credentials in the URL, is refused rather than fetched.
 */
export function ollamaTagsUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') return null;
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/**
 * `redirect: 'manual'`: the probe never follows a 3xx off localhost (a
 * redirect still counts as an answer, so as reachable).
 */
export type ProbeFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual' },
) => Promise<unknown>;

/**
 * True when Ollama's address gave any HTTP response at all (whatever the
 * status, a redirect included, which is not followed); false on a network error, a timeout, or a disallowed URL.
 */
export async function probeOllama(
  baseUrl: unknown,
  fetchImpl: ProbeFetch,
  timeoutMs: number = OLLAMA_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const target = ollamaTagsUrl(baseUrl);
  if (target === null) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  const answered = Promise.resolve()
    .then(() => fetchImpl(target, { signal: controller.signal, redirect: 'manual' }))
    .then(
      () => true,
      () => false,
    );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
