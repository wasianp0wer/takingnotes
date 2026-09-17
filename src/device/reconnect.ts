export interface ReconnectDeps {
  /** Attempts one reconnection. Rejecting means "not yet". */
  reconnect: () => Promise<void>;
  onAttempt?: (attempt: number, delayMs: number) => void;
  onSuccess?: () => void;
  onGiveUp?: () => void;
}

export interface ReconnectOptions {
  /** Backoff ladder; the final entry repeats indefinitely. */
  delaysMs?: number[];
  /** Bound on attempts. Defaults to Infinity - a drop must never end a session. */
  maxAttempts?: number;
}

export interface ReconnectPolicy {
  start(): void;
  stop(): void;
  readonly isReconnecting: boolean;
}

const DEFAULT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Drives `deps.reconnect()` on a backoff ladder until it succeeds.
 *
 * Defaults to retrying forever: the user's decision is that a session stays
 * open as long as possible, so a dropped link must never be what ends one.
 * `maxAttempts` exists so tests can bound the loop.
 */
export function createReconnectPolicy(
  deps: ReconnectDeps,
  opts: ReconnectOptions = {},
): ReconnectPolicy {
  const delays = opts.delaysMs?.length ? opts.delaysMs : DEFAULT_DELAYS;
  const maxAttempts = opts.maxAttempts ?? Infinity;

  let running = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wait = (ms: number) => new Promise<void>((resolve) => {
    timer = setTimeout(() => { timer = null; resolve(); }, ms);
  });

  async function loop(myGen: number) {
    let attempt = 0;
    while (myGen === generation && attempt < maxAttempts) {
      const delayMs = delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      try {
        deps.onAttempt?.(attempt, delayMs);
      } catch {
        // Suppress callback errors so they don't stop the loop
      }
      await wait(delayMs);
      if (myGen !== generation) break;
      try {
        await deps.reconnect();
        if (myGen !== generation) break;
        running = false;
        try {
          deps.onSuccess?.();
        } catch {
          // Suppress callback errors
        }
        return;
      } catch {
        // Still down. Fall through to the next rung of the ladder.
      }
    }
    // Only fire onGiveUp if we're still the current generation
    if (myGen === generation) {
      running = false;
      try {
        deps.onGiveUp?.();
      } catch {
        // Suppress callback errors
      }
    }
  }

  return {
    start() {
      // Guard against a second loop: a burst of disconnect events must not
      // multiply the attempt rate, which is the same failure shape as the
      // overlapping recovery passes fixed in 45b0f77.
      if (running) return;
      running = true;
      generation++;
      void loop(generation);
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get isReconnecting() { return running; },
  };
}
