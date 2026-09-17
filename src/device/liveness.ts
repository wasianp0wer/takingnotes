export interface LivenessDeps {
  /** A cheap read. Rejecting is taken as proof the link is dead. */
  ping: () => Promise<unknown>;
  onDead: () => void;
}

export interface LivenessOptions {
  /** Silence after which the link is suspect. */
  idleMs?: number;
  /** How often to evaluate that silence. */
  checkIntervalMs?: number;
}

export interface LivenessWatchdog {
  start(): void;
  stop(): void;
  /** Call for every inbound frame. */
  noteFrame(): void;
}

/**
 * Detects a link that is nominally connected but carrying nothing.
 *
 * `gatt.connected` is not evidence: the field drop that motivated this had its
 * last inbound frame 0s before the disconnect, i.e. the link died while
 * actively in use. Silence plus a failed cheap read is better evidence.
 */
export function createLivenessWatchdog(
  deps: LivenessDeps,
  opts: LivenessOptions = {},
): LivenessWatchdog {
  const idleMs = opts.idleMs ?? 15_000;
  const checkIntervalMs = opts.checkIntervalMs ?? 5_000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = Date.now();
  let pinging = false;

  async function check() {
    // One ping at a time: the check interval is shorter than a ping can take,
    // and piling pings onto a struggling link is how the write storm started.
    if (pinging) return;
    if (Date.now() - lastFrameAt < idleMs) return;
    pinging = true;
    try {
      await deps.ping();
      // A reply is itself proof of life even if no notification arrived.
      lastFrameAt = Date.now();
    } catch {
      deps.onDead();
    } finally {
      pinging = false;
    }
  }

  return {
    start() {
      if (timer) return;
      lastFrameAt = Date.now();
      timer = setInterval(() => { void check(); }, checkIntervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    noteFrame() {
      lastFrameAt = Date.now();
    },
  };
}
