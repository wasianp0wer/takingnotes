export interface PageTurnDeps {
  getStoredPageCount: () => Promise<number>;
  /** Fired when the count rises. A jump of more than one is still one event. */
  onPageTurn: (newCount: number, previousCount: number) => void;
  onError?: (err: unknown) => void;
}

export interface PageTurnOptions {
  /**
   * How often to re-read the ROM page count.
   *
   * COUPLING, by design: in the device controller composition every inbound
   * frame - including this poll's own `0x85` reply - feeds the liveness
   * watchdog's `noteFrame()`. While `pollIntervalMs` stays below the
   * watchdog's `idleMs` (5s vs 15s by default) a healthy poll keeps the
   * watchdog permanently quiet, so the watchdog only escalates after roughly
   * three consecutive poll failures. Raising this above `idleMs` inverts
   * that: the watchdog stops being a backstop behind this detector and
   * becomes the primary liveness sensor. See the note on
   * `LivenessOptions.idleMs`.
   */
  pollIntervalMs?: number;
}

export interface PageTurnDetector {
  /**
   * Anchors the baseline and begins polling. Does not fire a turn - not even
   * when the baseline read fails, in which case the first successful poll
   * becomes the baseline instead, still without firing.
   */
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
  // Whether `known` reflects a real reading from the device. `known` starts
  // at 0, which is indistinguishable from a genuine empty pad, so a baseline
  // read that never succeeded must not be treated as a baseline: the first
  // poll would see any real count as a rise from 0 and fabricate a page turn.
  // Under D9 the live stream is the only source of truth and nothing
  // re-downloads from ROM, so a fabricated boundary splits a page
  // irreparably - exactly as bad as a missed one.
  let anchored = false;
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
    if (!anchored) {
      // start()'s baseline read never landed (transient drop, 5s timeout, or
      // a busy single-flight slot). This poll is that baseline - adopt it
      // silently. Firing here would invent a turn the user never made.
      known = count;
      anchored = true;
      return;
    }
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
        anchored = true;
      } else {
        const count = await readCount(myGen);
        if (count !== undefined) {
          known = count;
          anchored = true;
        }
        // Otherwise leave `known` unanchored: the single-flight slot was busy
        // (a stale poll from a just-stopped session still resolving), the
        // read failed, or this session was superseded while we waited. The
        // first successful poll anchors it - silently, via the `!anchored`
        // branch in poll(). This must not be left to the `count > known`
        // comparison: `known` is still its initial 0, so the first poll of a
        // pad holding N pages would report a turn from 0 to N. start()
        // cannot surface the failure to the caller either (readCount
        // swallows into onError, so startCapture() reports success), which
        // is why the recovery has to be correct here rather than upstream.
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
