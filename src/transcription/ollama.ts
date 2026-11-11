import {
  createOllamaClient,
  DegenerateOutputError,
  isDegenerateOutput,
  stripCodeFence,
  type FetchLike,
} from '@/llm/ollamaClient';
import { getPromptFor } from '@/transcription/prompts';
import type { PageTranscriber, TranscriptionResult } from '@/transcription/types';

/**
 * Handwriting transcription over Ollama's vision path. The HTTP request itself,
 * the per-call timeout, the unreachable-host message and the degenerate-output
 * guard now live in `src/llm/ollamaClient.ts`, shared with Phase 2's text
 * features (docs/architecture.md §6.4); what stays here is what is specific to
 * turning one page image into Markdown.
 *
 * Its exports are unchanged, including the ones re-exported from the shared
 * module, so callers and tests never have to know where a guard lives.
 */

export type { FetchLike } from '@/llm/ollamaClient';
export {
  DEFAULT_TIMEOUT_MS,
  DegenerateOutputError,
  isDegenerateOutput,
  listOllamaModels,
} from '@/llm/ollamaClient';

export interface OllamaTranscriberOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  numPredict?: number;
}

/** Output token cap (F3): a page is 150-250 tokens; a degenerate run produced ~20,000. */
export const DEFAULT_NUM_PREDICT = 2000;

const B64_CHUNK = 32 * 1024;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + B64_CHUNK));
  }
  return btoa(binary);
}

export function createOllamaTranscriber(opts: OllamaTranscriberOptions): PageTranscriber {
  const numPredict = opts.numPredict ?? DEFAULT_NUM_PREDICT;
  const client = createOllamaClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetch,
    timeoutMs: opts.timeoutMs,
    // Names the operation in the timeout and abort messages the user sees.
    label: 'Transcription',
  });

  return {
    async transcribePage(image, { model, firstPage, signal }): Promise<TranscriptionResult> {
      // Checked before encoding the image: an aborted page must not spend a
      // base64 pass on a result nobody is waiting for.
      client.throwIfAborted(signal);
      const { promptVersion, prompt } = getPromptFor(model, { firstPage });
      const images = [await blobToBase64(image)];

      const data = await client.generate(
        { model, prompt, images, options: { num_predict: numPredict, temperature: 0 } },
        signal,
      );

      const markdown = stripCodeFence(data.response ?? '');
      if (isDegenerateOutput(markdown, data.done_reason)) {
        throw new DegenerateOutputError('Degenerate output: the model repeated itself');
      }
      return { markdown, model, promptVersion };
    },
  };
}
