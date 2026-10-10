import { createEmitter } from '@/device/emitter';

/**
 * Shared signal that any `engine.resumeNote()` call is in flight, anywhere in
 * the app - not whose click started it. `architecture.md` §8.3 documents the
 * hazard this closes: resuming a *different* note (or starting a session)
 * before the first resume's op has published state falls through to
 * `closeNote()` against the half-opened resume and leaves a stray empty
 * page. The fix is cheap and lives in the UI (S1's own responsibility, not
 * the engine's): disable every Resume button and Start session for as long
 * as any resume call is pending.
 *
 * One flag, not a counter: the lock only needs to answer "is anything in
 * flight right now", never "how many calls are in flight" - two overlapping
 * `run()`s (unreachable in practice, since the disabled buttons prevent the
 * click that would start a second one) still leave `pending: true` until
 * both have settled.
 */
export interface ResumeLockState {
  pending: boolean;
}

export interface ResumeLock {
  getState(): ResumeLockState;
  subscribe(fn: (state: ResumeLockState) => void): () => void;
  /** Runs `fn` with the lock held for its whole lifetime, released whether it resolves or rejects. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createResumeLock(): ResumeLock {
  let inFlight = 0;
  const emitter = createEmitter<ResumeLockState>();

  function state(): ResumeLockState {
    return { pending: inFlight > 0 };
  }

  return {
    getState: state,
    subscribe: (fn) => emitter.subscribe(fn),
    async run<T>(fn: () => Promise<T>): Promise<T> {
      inFlight += 1;
      if (inFlight === 1) emitter.emit(state());
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        if (inFlight === 0) emitter.emit(state());
      }
    },
  };
}

/**
 * Module-level singleton, the same shape `src/transcription/startTranscription.ts`
 * uses for the transcription queue. A plain prop or a React context would need
 * `AppShell`/`main.tsx` to grow a provider - `SessionControls` and `NotesView`
 * are mounted as siblings there, not one inside the other - for a value this
 * small, and both files are outside this unit's ownership.
 */
let instance: ResumeLock | null = null;

export function getResumeLock(): ResumeLock {
  if (!instance) instance = createResumeLock();
  return instance;
}

export function resetResumeLockForTests(): void {
  instance = null;
}
