export interface PageTurnDeps {
  getStoredPageCount: () => Promise<number>;
  /** Fired when the count rises. A jump of more than one is still one event. */
  onPageTurn: (newCount: number, previousCount: number) => void;
  onError?: (err: unknown) => void;
}

export interface PageTurnOptions {
  pollIntervalMs?: number;
}

export interface PageTurnDetector {
  /** Anchors the baseline and begins polling. Does not fire a turn. */
  start(initialCount?: number): Promise<void>;
  stop(): void;
  /** A 0x8A arrived. Poll now rather than waiting out the interval. */
  hint(): void;
  readonly pageCount: number;
}

/**
 * Detects page turns from the ROM page count, treating the `0x8A`
 * notification only as a reason to look sooner.
 *
 * C6 makes the count ground truth: a page commits to ROM exactly on page
 * turn, so the count rises exactly on page turn. The notification is not
 * ground truth - a field run recorded four presses and zero detections.
 *
 * This is not "relying on device memory" in the sense D9 rejects: that is
 * about downloading stroke DATA, whose quality problems (C7) do not apply to
 * a 4-byte counter read.
 */
export function createPageTurnDetector(
  deps: PageTurnDeps,
  opts: PageTurnOptions = {},
): PageTurnDetector {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let known = 0;
  let polling = false;
  let running = false;

  async function poll() {
    // Single-flight. `getStoredPageCount` is itself single-flight on the
    // driver and throws on a second concurrent call, so overlapping polls
    // would produce spurious errors as well as extra traffic.
    if (polling || !running) return;
    polling = true;
    try {
      const count = await deps.getStoredPageCount();
      if (!running) return;
      if (count > known) {
        const previous = known;
        known = count;
        deps.onPageTurn(count, previous);
      } else if (count < known) {
        // The pad was cleared or renumbered. Re-anchor silently: this is not
        // a page turn, and treating it as one would invent pages.
        known = count;
      }
    } catch (err) {
      deps.onError?.(err);
    } finally {
      polling = false;
    }
  }

  return {
    async start(initialCount?: number) {
      if (running) return;
      running = true;
      if (initialCount !== undefined) {
        known = initialCount;
      } else {
        try {
          known = await deps.getStoredPageCount();
        } catch (err) {
          // Baseline unknown. Leave `known` at 0 and let the first successful
          // poll anchor it; firing a turn for that first reading would
          // invent one, so the first rise from 0 is reported only if the
          // device really does have pages appear later.
          deps.onError?.(err);
        }
      }
      timer = setInterval(() => { void poll(); }, pollIntervalMs);
    },
    stop() {
      running = false;
      if (timer) { clearInterval(timer); timer = null; }
    },
    hint() {
      void poll();
    },
    get pageCount() { return known; },
  };
}
