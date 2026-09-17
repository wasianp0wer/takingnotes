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
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wait = (ms: number) => new Promise<void>((resolve) => {
    timer = setTimeout(() => { timer = null; resolve(); }, ms);
  });

  async function loop() {
    let attempt = 0;
    while (!cancelled && attempt < maxAttempts) {
      const delayMs = delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      deps.onAttempt?.(attempt, delayMs);
      await wait(delayMs);
      if (cancelled) break;
      try {
        await deps.reconnect();
        if (cancelled) break;
        running = false;
        deps.onSuccess?.();
        return;
      } catch {
        // Still down. Fall through to the next rung of the ladder.
      }
    }
    running = false;
    if (!cancelled) deps.onGiveUp?.();
  }

  return {
    start() {
      // Guard against a second loop: a burst of disconnect events must not
      // multiply the attempt rate, which is the same failure shape as the
      // overlapping recovery passes fixed in 45b0f77.
      if (running) return;
      running = true;
      cancelled = false;
      void loop();
    },
    stop() {
      cancelled = true;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get isReconnecting() { return running; },
  };
}
