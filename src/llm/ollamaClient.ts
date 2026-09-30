/**
 * The low-level Ollama HTTP layer (docs/architecture.md §6.4).
 *
 * Phase 1 spoke to Ollama from `src/transcription/ollama.ts` for vision; Phase 2
 * also needs text generation, with the same guards. Everything about talking to
 * one Ollama host safely lives here - the guarded request shape, the per-call
 * timeout, naming the host when it is unreachable, and refusing degenerate
 * output - and nothing here knows what a page, a gap or an assignment is.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Per-call wall clock budget (transcription finding F3: a bad call must not stall a queue). */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** Thrown when the model fell into repetition instead of answering (finding F2). */
export class DegenerateOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DegenerateOutputError';
  }
}

/** The fields of `POST /api/generate` this app ever sets. `stream` and `think` are the client's. */
export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  /** Base64-encoded images, for a vision model. */
  images?: string[];
  options?: Record<string, unknown>;
}

export interface OllamaGenerateResponse {
  response?: string;
  done_reason?: string;
}

export interface OllamaClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Names the operation in timeout and abort messages ("Transcription timed out
   * after 180s"). Those messages reach the user, who needs to know which part
   * of the app gave up, not that an HTTP request did.
   */
  label?: string;
}

export interface OllamaClient {
  /** The base URL with trailing slashes removed, as it appears in error messages. */
  readonly baseUrl: string;
  /**
   * One `/api/generate` call. Adds `stream: false` and `think: false`, retrying
   * once without `think` for models that reject the field. Rejects on an HTTP
   * error, a timeout, an abort or an unreachable host.
   */
  generate(
    request: OllamaGenerateRequest,
    signal?: AbortSignal,
  ): Promise<OllamaGenerateResponse>;
  /** Throws this client's `AbortError` when the signal is already aborted. */
  throwIfAborted(signal: AbortSignal | undefined): void;
}

type Attempt =
  | { ok: true; data: OllamaGenerateResponse }
  | { ok: false; status: number; error: string };

const FENCE_RE = /^```[A-Za-z0-9+#.-]*\s*\n([\s\S]*?)\n```$/;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/** A network failure (fetch rejects with TypeError) names the host that is down. */
const unreachableError = (base: string, message: string): Error =>
  new Error(`Could not reach Ollama at ${base}: ${message}`);

async function readErrorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON - fall through to the raw body.
  }
  return body;
}

/**
 * Trims, and unwraps a single fenced block that spans the whole answer. The
 * language tag is anything, not just `markdown`: text callers ask for JSON and
 * get ```json just as often as transcription gets ```markdown.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCE_RE.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Repetition guard (spec §3, harness finding F2): a high character count is a
 * failure signal for handwriting transcription, not a success signal.
 *
 * A real degenerate run always hits the `num_predict` cap, so rule (b) is the
 * primary guard. Rules (a) and (c) are deliberately loose so that legitimately
 * repetitive pages - a checklist of identical `- [ ]` lines, a table with
 * repeating rows - are not thrown away.
 */
export function isDegenerateOutput(text: string, doneReason?: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0) {
    const uniqueLines = new Set(lines).size / lines.length;
    if (lines.length >= 20 && uniqueLines < 0.3) return true;
    if (doneReason === 'length' && lines.length >= 4 && uniqueLines < 0.5) return true;
  }
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length >= 200 && new Set(tokens).size / tokens.length < 0.1) return true;
  return false;
}

export function createOllamaClient(opts: OllamaClientOptions): OllamaClient {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = opts.label ?? 'Request';
  const base = trimBase(opts.baseUrl);
  const url = `${base}/api/generate`;

  const abortError = (): Error => {
    const err = new Error(`${label} aborted`);
    err.name = 'AbortError';
    return err;
  };

  function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortError();
  }

  async function callOnce(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    throwIfAborted(signal);

    // The timeout aborts its own controller, so a slow call is cut off without
    // touching the caller's signal - and `timedOut` is what tells the two kinds
    // of abort apart afterwards.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new Error(`${label} timed out after ${timeoutMs / 1000}s`);
        if (err instanceof TypeError) throw unreachableError(base, err.message);
        throw err;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: await readErrorText(res) };
      }
      return { ok: true, data: (await res.json()) as OllamaGenerateResponse };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    baseUrl: base,
    throwIfAborted,

    async generate(request, signal) {
      // `think: false` is a hard default, not a setting (finding F1: 34x faster
      // and more accurate on gemma4). Models that reject the field get one
      // retry without it.
      let attempt = await callOnce({ ...request, stream: false, think: false }, signal);
      if (!attempt.ok && /think/i.test(attempt.error)) {
        attempt = await callOnce({ ...request, stream: false }, signal);
      }
      if (!attempt.ok) {
        throw new Error(`Ollama ${attempt.status}: ${attempt.error}`);
      }
      return attempt.data;
    },
  };
}

/** Names of the models installed in Ollama, for the settings model picker. */
export async function listOllamaModels(
  baseUrl: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string[]> {
  const base = trimBase(baseUrl);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/tags`);
  } catch (err) {
    if (err instanceof TypeError) throw unreachableError(base, err.message);
    throw err;
  }
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  return (data.models ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort();
}
