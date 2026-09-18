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
 * ground truth - a field run measured roughly a 20% miss rate on it in
 * sustained use (about one press in five produced no 0x8A). That miss rate
 * makes this poll load-bearing rather than a redundant safety net: relying
 * on the notification alone would silently merge two pages' worth of
 * writing about once every five turns, and D9's rejection of a ROM-backfill
 * path means there is no correcting it after the fact.
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
  // Bumped by both start() and stop() - the same shape reconnect.ts uses to
  // close its own ABA hazard. A boolean cannot tell "I was stopped" apart
  // from "a later start reset the flag": a poll that hangs across a
  // stop()+start() would otherwise resume into the *new* session and see
  // `running === true` again, applying a read that belongs to a session that
  // no longer exists. Every async continuation below re-checks its own
  // captured generation against the live one before acting.
  let generation = 0;

  /**
   * The single point of contact with `deps.getStoredPageCount`, shared by
   * `poll()` and `start()`'s baseline read so both respect the same
   * single-flight slot. The real driver throws on a second concurrent call,
   * so a caller that finds the slot occupied skips its read entirely rather
   * than overlapping it - this is what closes the case where a restart's
   * baseline read would otherwise race a still-resolving stale poll.
   *
   * Returns `undefined` if the slot was busy, the call failed, or this
   * generation was superseded before the result came back - in every one of
   * those cases the caller must take no further action.
   */
  async function readCount(myGen: number): Promise<number | undefined> {
    if (polling) return undefined;
    polling = true;
    try {
      const count = await deps.getStoredPageCount();
      return myGen === generation ? count : undefined;
    } catch (err) {
      if (myGen === generation) deps.onError?.(err);
      return undefined;
    } finally {
      polling = false;
    }
  }

  async function poll(myGen: number) {
    if (!running || myGen !== generation) return;
    const count = await readCount(myGen);
    if (count === undefined) return;
    if (count > known) {
      const previous = known;
      known = count;
      deps.onPageTurn(count, previous);
    } else if (count < known) {
      // The pad was cleared or renumbered. Re-anchor silently: this is not
      // a page turn, and treating it as one would invent pages.
      known = count;
    }
  }

  return {
    async start(initialCount?: number) {
      if (running) return;
      running = true;
      generation++;
      const myGen = generation;

      if (initialCount !== undefined) {
        known = initialCount;
      } else {
        const count = await readCount(myGen);
        if (count !== undefined) known = count;
        // Otherwise leave `known` as-is: the single-flight slot was busy
        // (a stale poll from a just-stopped session still resolving), the
        // read failed, or this session was superseded while we waited. The
        // first successful poll will anchor it.
      }

      if (myGen === generation) {
        timer = setInterval(() => { void poll(myGen); }, pollIntervalMs);
      }
    },
    stop() {
      running = false;
      generation++;
      if (timer) { clearInterval(timer); timer = null; }
    },
    hint() {
      void poll(generation);
    },
    get pageCount() { return known; },
  };
}
