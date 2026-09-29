// Kept apart from `whisperClient.ts` so tests can import the client without this module's
// `new Worker(...)` — and without the model runtime it pulls in — ever being evaluated.

/**
 * Creates the Whisper worker. The `new URL(..., import.meta.url)` form is what Vite needs to
 * bundle the worker as its own module chunk.
 */
export function createWhisperWorker(): Worker {
  return new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
}
