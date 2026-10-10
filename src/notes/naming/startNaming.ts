import type { CaptureEngine } from '@/capture/types';
import { createOllamaTextGenerator } from '@/llm/ollamaText';
import { createNamingQueue, type NamingQueue } from '@/notes/naming/queue';
import { getSettingValue } from '@/storage/settingKeys';
import type { TranscriptionQueue } from '@/transcription/queue';

/**
 * Module-level singleton, the same shape `startTranscription.ts` uses for
 * the transcription queue: React StrictMode's double invocation and a
 * remounting Notes tab both reuse the one queue rather than fighting a
 * second one over the same notes.
 */
let queue: NamingQueue | null = null;

/**
 * Returns the app's naming queue, building and starting it on the first
 * call. Never stopped, for the same reason the transcription queue never is.
 */
export function ensureNamingQueue(
  engine: Pick<CaptureEngine, 'subscribePageFinalized' | 'subscribeNoteEnded'>,
  transcriptionQueue: Pick<TranscriptionQueue, 'subscribe'>,
): NamingQueue {
  if (queue) return queue;

  const created = createNamingQueue({
    engine,
    transcriptionQueue,
    getSettings: async () => {
      const [baseUrl, model] = await Promise.all([
        getSettingValue('ollama.baseUrl'),
        getSettingValue('ollama.model'),
      ]);
      return { baseUrl, model };
    },
    createGenerator: (baseUrl) => createOllamaTextGenerator({ baseUrl }),
  });
  queue = created;

  // Fire-and-forget, same reasoning as ensureTranscriptionQueue: the caller
  // is a render path, and a storage scan that fails must not take the Notes
  // view down with it.
  void created.start().catch((error) => {
    console.error('[naming] queue failed to start', error);
  });
  return created;
}

export function resetNamingQueueForTests(): void {
  queue?.stop();
  queue = null;
}
