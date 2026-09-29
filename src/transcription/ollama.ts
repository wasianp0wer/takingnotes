import { getPromptFor } from '@/transcription/prompts';
import type { PageTranscriber, TranscriptionResult } from '@/transcription/types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaTranscriberOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  numPredict?: number;
}

/** Per-page wall clock budget (harness finding F3: a bad page must not stall the queue). */
export const DEFAULT_TIMEOUT_MS = 180_000;
/** Output token cap (F3): a page is 150-250 tokens; a degenerate run produced ~20,000. */
export const DEFAULT_NUM_PREDICT = 2000;

/** Thrown when the model fell into repetition instead of transcribing (finding F2). */
export class DegenerateOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DegenerateOutputError';
  }
}

const B64_CHUNK = 32 * 1024;
const FENCE_RE = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/;

interface OllamaGenerateResponse {
  response?: string;
  done_reason?: string;
}

type Attempt =
  | { ok: true; data: OllamaGenerateResponse }
  | { ok: false; status: number; error: string };

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

const abortError = (): Error => {
  const err = new Error('Transcription aborted');
  err.name = 'AbortError';
  return err;
};

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + B64_CHUNK));
  }
  return btoa(binary);
}

/** Trims, and unwraps a single fenced ```markdown block. */
function cleanOutput(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCE_RE.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Repetition guard (spec §3, harness finding F2): a high character count is a
 * failure signal for handwriting transcription, not a success signal.
 */
export function isDegenerateOutput(text: string, doneReason?: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0) {
    const uniqueLines = new Set(lines).size / lines.length;
    if (lines.length >= 8 && uniqueLines < 0.3) return true;
    if (doneReason === 'length' && lines.length >= 4 && uniqueLines < 0.5) return true;
  }
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length >= 60 && new Set(tokens).size / tokens.length < 0.1) return true;
  return false;
}

async function readErrorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON - fall through to the raw body.
  }
  return body;
}

export function createOllamaTranscriber(opts: OllamaTranscriberOptions): PageTranscriber {
  const fetchImpl = opts.fetch ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const numPredict = opts.numPredict ?? DEFAULT_NUM_PREDICT;
  const base = trimBase(opts.baseUrl);
  const url = `${base}/api/generate`;

  async function callOnce(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    if (signal?.aborted) throw abortError();

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
        if (timedOut) throw new Error(`Transcription timed out after ${timeoutMs / 1000}s`);
        if (err instanceof TypeError) {
          throw new Error(`Could not reach Ollama at ${base}: ${err.message}`);
        }
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
    async transcribePage(image, { model, signal }): Promise<TranscriptionResult> {
      if (signal?.aborted) throw abortError();
      const { promptVersion, prompt } = getPromptFor(model);
      const images = [await blobToBase64(image)];
      const options = { num_predict: numPredict, temperature: 0 };

      // `think: false` is a hard default, not a setting (finding F1: 34x faster
      // and more accurate on gemma4). Models that reject the field get one
      // retry without it.
      let attempt = await callOnce(
        { model, prompt, images, stream: false, think: false, options },
        signal,
      );
      if (!attempt.ok && /think/i.test(attempt.error)) {
        attempt = await callOnce({ model, prompt, images, stream: false, options }, signal);
      }
      if (!attempt.ok) {
        throw new Error(`Ollama ${attempt.status}: ${attempt.error}`);
      }

      const markdown = cleanOutput(attempt.data.response ?? '');
      if (isDegenerateOutput(markdown, attempt.data.done_reason)) {
        throw new DegenerateOutputError('Degenerate output: the model repeated itself');
      }
      return { markdown, model, promptVersion };
    },
  };
}

/** Names of the models installed in Ollama, for the settings model picker. */
export async function listOllamaModels(
  baseUrl: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string[]> {
  const res = await fetchImpl(`${trimBase(baseUrl)}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  return (data.models ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort();
}
