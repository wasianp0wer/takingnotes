import type { HuionTransport } from '@/utils/huionTransport';

export interface PacedTransportOptions {
  /** Minimum ms between the completion of one write and the start of the next. */
  minGapMs?: number;
}

interface QueueEntry {
  data: Uint8Array;
  /** The link generation this write was issued against. See `epoch` below. */
  epoch: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Serializes every write to the wrapped transport: one in flight at a time,
 * FIFO, with a floor on the gap between them.
 *
 * This exists because overlapping callers once drove ~90 writes/sec against a
 * design pace of 25/sec, overran the controller's buffer and killed the link
 * mid-transfer (fixed at the call site in 45b0f77). The guard there was
 * specific to one loop; this makes the whole class impossible no matter how
 * many timers and callers the device layer grows.
 *
 * The gap is measured from the PREVIOUS WRITE'S COMPLETION, so a caller that
 * already paces itself more slowly than the floor is never delayed - the
 * driver's own `sleep(40)` in the package-recovery loop and this queue do not
 * compound.
 */
export function createPacedTransport(
  inner: HuionTransport,
  opts: PacedTransportOptions = {},
): HuionTransport {
  const minGapMs = opts.minGapMs ?? 40;
  const queue: QueueEntry[] = [];
  let draining = false;
  let closed = false;
  let lastWriteEndedAt = 0;
  // Bumped by reopen(). A transport-level drop does NOT call close(), so
  // nothing rejects work already queued when the link dies; without this the
  // reopened link inherits it and replays commands from a session that has
  // ended. `closed` alone cannot express that - reopen() has to clear it -
  // and it cannot reach the entry drain() has already shifted and is
  // currently waiting out the pacing gap for. Stamping each entry with the
  // generation it was issued against covers both. Same lesson as the
  // generation counters in reconnect.ts, pageTurnDetector.ts and liveness.ts.
  let epoch = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (closed) {
          entry.reject(new Error('Transport closed before write was sent'));
          continue;
        }
        if (entry.epoch !== epoch) {
          entry.reject(new Error('Transport reopened before write was sent'));
          continue;
        }
        const wait = minGapMs - (Date.now() - lastWriteEndedAt);
        if (wait > 0) await sleep(wait);
        // Re-check: close() or a drop-and-reopen can land while we were
        // waiting out the gap, and this entry is already out of the queue so
        // reopen()'s flush below cannot see it.
        if (closed) {
          entry.reject(new Error('Transport closed before write was sent'));
          continue;
        }
        if (entry.epoch !== epoch) {
          entry.reject(new Error('Transport reopened before write was sent'));
          continue;
        }
        try {
          await inner.write(entry.data);
          entry.resolve();
        } catch (err) {
          // Reject only this write. Draining continues: one failed frame must
          // not strand every frame queued behind it.
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          lastWriteEndedAt = Date.now();
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    get deviceName() { return inner.deviceName; },
    get deviceId() { return inner.deviceId; },
    onNotify(handler) { inner.onNotify(handler); },
    onDisconnect(handler) { inner.onDisconnect(handler); },
    async open() {
      // Same retirement as reopen(): close() flushes the queue but cannot
      // reach the entry drain() has already shifted and is waiting out the
      // pacing gap for, and that entry's only other guard is `closed` -
      // which open() is about to clear.
      epoch++;
      closed = false;
      await inner.open();
    },
    async reopen() {
      // Retire the old generation and flush before clearing `closed`: a
      // resumed session must not inherit the dead one's pending work.
      epoch++;
      while (queue.length > 0) {
        queue.shift()!.reject(new Error('Transport reopened before write was sent'));
      }
      closed = false;
      await inner.reopen();
    },
    write(data) {
      if (closed) return Promise.reject(new Error('Transport closed'));
      const myEpoch = epoch;
      return new Promise<void>((resolve, reject) => {
        queue.push({ data, epoch: myEpoch, resolve, reject });
        void drain();
      });
    },
    async close() {
      closed = true;
      // Anything still queued will be rejected by the drain loop; reject here
      // too in case no drain is running.
      while (queue.length > 0) {
        queue.shift()!.reject(new Error('Transport closed before write was sent'));
      }
      await inner.close();
    },
  };
}
