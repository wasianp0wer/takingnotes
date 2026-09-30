import {
  createOllamaClient,
  DegenerateOutputError,
  isDegenerateOutput,
  stripCodeFence,
  type FetchLike,
} from '@/llm/ollamaClient';
import { getSyllabusVisionPromptFor } from '@/syllabus/prompts';

/**
 * A scanned syllabus page has no text layer, so it goes through the vision model
 * as OCR (P2-A5): the page's text comes back, and the ordinary JSON extraction
 * path then reads it. One extraction prompt to maintain, and the review table
 * remains the safety net either way.
 *
 * Every guard is the shared one from `src/llm/ollamaClient.ts` - the same ones
 * handwriting transcription uses.
 */
export interface SyllabusPageReader {
  readPage(
    image: Blob,
    opts: { model: string; signal?: AbortSignal },
  ): Promise<{ text: string; promptVersion: string }>;
}

export interface OllamaPageReaderOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  numPredict?: number;
}

/** A syllabus page is denser than a handwritten one, so it gets a larger cap. */
export const DEFAULT_PAGE_NUM_PREDICT = 3000;

const B64_CHUNK = 32 * 1024;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + B64_CHUNK));
  }
  return btoa(binary);
}

export function createOllamaPageReader(opts: OllamaPageReaderOptions): SyllabusPageReader {
  const numPredict = opts.numPredict ?? DEFAULT_PAGE_NUM_PREDICT;
  const client = createOllamaClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    // Names this operation in the timeout and abort messages the user reads.
    label: 'Syllabus page',
  });

  return {
    async readPage(image, { model, signal }) {
      // Checked before encoding: a cancelled import must not spend a base64 pass.
      client.throwIfAborted(signal);
      const { prompt, promptVersion } = getSyllabusVisionPromptFor(model);
      const images = [await blobToBase64(image)];

      const data = await client.generate(
        { model, prompt, images, options: { num_predict: numPredict, temperature: 0 } },
        signal,
      );

      const text = stripCodeFence(data.response ?? '');
      if (isDegenerateOutput(text, data.done_reason)) {
        throw new DegenerateOutputError('Degenerate output: the model repeated itself');
      }
      return { text, promptVersion };
    },
  };
}
