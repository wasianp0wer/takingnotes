import type { CaptureEngine } from '@/capture/types';
import { getSettingValue } from '@/storage/settingKeys';
import { createOllamaTranscriber } from '@/transcription/ollama';
import {
  createTranscriptionQueue,
  type TranscriptionQueue,
  type TranscriptionSettingsSnapshot,
} from '@/transcription/queue';
import { renderPage } from '@/transcription/rasterize';

/**
 * Module-level so React StrictMode's double invocation and a remounting Notes
 * tab all reuse one queue (F1-A7). A second queue would double every job and
 * fight the first one over the same transcript rows.
 */
let queue: TranscriptionQueue | null = null;

async function readSettings(): Promise<TranscriptionSettingsSnapshot> {
  const [baseUrl, model, renderLongEdge] = await Promise.all([
    getSettingValue('ollama.baseUrl'),
    getSettingValue('ollama.model'),
    getSettingValue('transcription.renderLongEdge'),
  ]);
  return { baseUrl, model, renderLongEdge };
}

/**
 * Returns the app's transcription queue, building and starting it on the first
 * call. Never stopped: the Notes tab starts it and tab switches must not
 * abandon a page mid-transcription.
 */
export function ensureTranscriptionQueue(engine: CaptureEngine): TranscriptionQueue {
  if (queue) return queue;

  const created = createTranscriptionQueue({
    engine,
    getSettings: readSettings,
    createTranscriber: (baseUrl) => createOllamaTranscriber({ baseUrl }),
    render: (strokes, dims, longEdge) => renderPage(strokes, dims, longEdge),
  });
  queue = created;

  // Starting is fire-and-forget: the caller is a render path, and a storage
  // scan that fails must not take the Notes view down with it.
  void created.start().catch((error) => {
    console.error('[transcription] queue failed to start', error);
  });
  return created;
}

/** The queue if one was built, else `null`. For callers that must not build one. */
export function getTranscriptionQueue(): TranscriptionQueue | null {
  return queue;
}

export function resetTranscriptionQueueForTests(): void {
  queue?.stop();
  queue = null;
}
