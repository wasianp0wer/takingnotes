import { describe, expect, it, vi } from 'vitest';

import { createDeviceController } from '@/device/controller';
import { connectedFake, LIVE_PEN_DOWN_PACKET, withChecksum } from '@/test/huionFixtures';
import type { HuionPenPoint } from '@/utils/huionBLE';
import { HuionNoteBLE } from '@/utils/huionBLE';
import { CMD } from '@/utils/huionProtocol';
import { createPacedTransport } from '@/utils/pacedTransport';

/**
 * The driver awaits `handleCommand` before it forwards a 0x8D frame to
 * `onPen`, so pen delivery lands a few microtasks after `transport.emit()`
 * returns (unlike the page-turn event, which is dispatched synchronously
 * inside `handleCommand`). One macrotask drains all of them.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** connectedFake() plus a settable stored-page count on the 0x85 reply. */
function pageCountFake(read: () => number) {
  const transport = connectedFake();
  transport.on(CMD.CURRENT_PAGE, () => [
    withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, read() & 0xff, (read() >> 8) & 0xff, 0, 0]),
  ]);
  return transport;
}

describe('device controller', () => {
  it('fans pen points out to every subscriber', async () => {
    // Driven by a real live packet through the fake transport rather than a
    // test-only emit seam: this is the test that actually covers the
    // `device.onPen = ...` wiring in controller.ts. Deleting that line must
    // fail this test.
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const preview = vi.fn();
    const recorder = vi.fn();
    controller.subscribePen(preview);
    controller.subscribePen(recorder);

    await controller.connect();
    transport.emit(LIVE_PEN_DOWN_PACKET);
    await flush();

    expect(preview).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledTimes(1);
    const point = preview.mock.calls[0][0] as HuionPenPoint;
    expect(point.status).toBe(1);
    expect(point.pressure).toBeGreaterThan(0);
    expect(recorder.mock.calls[0][0]).toEqual(point);
  });

  it('fans log lines out to every subscriber', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const first: string[] = [];
    const second: string[] = [];
    controller.subscribeLog((line) => first.push(line));
    const unsubscribeSecond = controller.subscribeLog((line) => second.push(line));

    await controller.connect();

    // The handshake alone logs several lines; both subscribers see all of them.
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);

    unsubscribeSecond();
    const before = second.length;
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

    expect(first.length).toBeGreaterThan(before);
    expect(second).toHaveLength(before);
  });

  it('fans page turns out to every subscriber', async () => {
    // K28: 0x8A is the page-turn trigger directly - no poll needed to find
    // it. pageCountFake is only here so startCapture()'s baseline read
    // resolves fast; the count itself (held constant) never changes and
    // plays no part in the turn below.
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const first = vi.fn();
    const second = vi.fn();
    controller.subscribePageTurn(first);
    controller.subscribePageTurn(second);

    await controller.connect();
    await controller.startCapture();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    controller.stopCapture();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports connection state changes', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const states: boolean[] = [];
    controller.subscribeState((state) => states.push(state.isConnected));

    await controller.connect();
    transport.dropConnection();

    expect(states).toContain(true);
    expect(states[states.length - 1]).toBe(false);
  });

  it('stops delivering to an unsubscribed consumer', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const listener = vi.fn();
    const unsubscribe = controller.subscribePageTurn(listener);
    await controller.connect();
    await controller.startCapture();

    unsubscribe();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    controller.stopCapture();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps delivering to the remaining subscriber after one unsubscribes', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = controller.subscribePen(leaving);
    controller.subscribePen(staying);
    await controller.connect();

    unsubscribe();
    transport.emit(LIVE_PEN_DOWN_PACKET);
    await flush();

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });
});

describe('capture lifecycle', () => {
  it('K29: a rising count poll updates storedPageCount but no longer emits a page turn', async () => {
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { pageTurn: { pollIntervalMs: 10 } },
    );
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();
    count = 2;
    await tick(80);
    controller.stopCapture();

    // storedPageCount is still the poll's job (engine.devicePageNum() reads
    // it) - only what the poll *triggers* changed.
    expect(controller.getState().storedPageCount).toBe(2);
    expect(turns).toHaveLength(0);
  });

  it('K29/K30: the reconnect re-poll still catches up storedPageCount, but misses made while the link was down are not recovered as page turns', async () => {
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { pageTurn: { pollIntervalMs: 60_000 }, reconnect: { delaysMs: [10] } },
    );
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();
    transport.dropConnection();
    count = 3; // three presses while the link was down, none of them 0x8A frames
    await tick(400);
    controller.stopCapture();

    expect(controller.getState().storedPageCount).toBe(3);
    expect(turns).toHaveLength(0);
  });

  it('K28/K31: one 0x8A press, no count change, still creates exactly one page turn', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    controller.stopCapture();

    expect(turns).toHaveLength(1);
    // The count the pad happened to report never changed - the press alone
    // was enough, which is the whole point of K28.
    expect(controller.getState().storedPageCount).toBe(0);
  });

  it('K31: two 0x8A frames within the dedupe window make one page turn; two further apart make two', async () => {
    const transport = pageCountFake(() => 0);
    let t = 0;
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { now: () => t, pageTurnDedupeMs: 300 },
    );
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();

    t = 1_000;
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    t = 1_150; // 150ms later - inside the 300ms window
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    expect(turns).toHaveLength(1);

    t = 1_460; // 310ms after the *first* press - outside the window
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    expect(turns).toHaveLength(2);

    controller.stopCapture();
  });

  it('a 0x8A notification before startCapture() (or after stopCapture()) is harmless', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    expect(turns).toHaveLength(0);

    await controller.startCapture();
    controller.stopCapture();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));
    expect(turns).toHaveLength(0);
  });

  it('does not chase a drop that happened after stopCapture', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { reconnect: { delaysMs: [10] } },
    );
    const logs: string[] = [];
    controller.subscribeLog((line) => logs.push(line));

    await controller.connect();
    await controller.startCapture();
    controller.stopCapture();
    transport.dropConnection();
    await tick(80);

    expect(logs.filter((l) => l.includes('Reconnect attempt'))).toEqual([]);
  });

  it('restores streaming end-to-end after a transport-level drop and reconnect', async () => {
    // Task 8: the reconnect machinery restoring the link is not enough - a
    // session that was streaming before the drop must be streaming again
    // after, with no separate user gesture. Goes through the whole stack
    // (reconnectPolicy -> device.reconnect()), not just the driver directly.
    // pageCountFake (not connectedFake) because startCapture() polls
    // CURRENT_PAGE - connectedFake has no responder for it and the poll
    // would hang to its own 5s timeout.
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { reconnect: { delaysMs: [10] } },
    );

    await controller.connect();
    await controller.startStreaming();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(true);

    transport.dropConnection();
    expect(controller.getState().isStreaming).toBe(false);
    // Handshake (~100ms, one real sleep) + streaming restore (~400ms, three
    // real sleeps) + margin for scheduling overhead.
    await tick(700);
    controller.stopCapture();

    expect(controller.getState().isConnected).toBe(true);
    expect(controller.getState().isStreaming).toBe(true);
  });

  it('does not start streaming after a reconnect if it was not active before the drop', async () => {
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { reconnect: { delaysMs: [10] } },
    );

    await controller.connect();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(false);

    transport.dropConnection();
    // Long enough to cover a full (mistaken) restore attempt too - handshake
    // (~100ms) + streaming setup sleeps (~400ms) - so an implementation that
    // wrongly restores unconditionally would be caught here, not hidden by
    // an assertion that ran before its sleeps finished.
    await tick(700);
    controller.stopCapture();

    expect(controller.getState().isConnected).toBe(true);
    expect(controller.getState().isStreaming).toBe(false);
    expect(transport.written.some((f) => f[1] === CMD.ONLINE_ENABLE)).toBe(false);
  });
});

/** A fake setInterval/clearInterval pair, matching the pattern recorder.test.ts uses. */
function fakeIntervalPair() {
  const callbacks: (() => void)[] = [];
  return {
    callbacks,
    setInterval: (fn: () => void) => {
      callbacks.push(fn);
      return callbacks.length;
    },
    clearInterval: (handle: unknown) => {
      callbacks[(handle as number) - 1] = () => {};
    },
    fireAll: () => callbacks.forEach((fn) => fn()),
  };
}

function batteryFrame(percent: number): Uint8Array {
  return withChecksum([0xcd, CMD.BATTERY, 0x04, percent]);
}

describe('battery (K26, K27)', () => {
  it('is null before connecting', () => {
    const controller = createDeviceController(() => new HuionNoteBLE(connectedFake()));
    expect(controller.getState().batteryPercent).toBeNull();
  });

  it('is set from a CMD.BATTERY reply (the handshake already queries it on connect)', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));

    await controller.connect();
    transport.emit(batteryFrame(82));

    expect(controller.getState().batteryPercent).toBe(82);
  });

  it('a CMD.BATTERY reply arriving after a disconnect is ignored, not resurrecting a cleared percentage', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));

    await controller.connect();
    transport.emit(batteryFrame(82));
    expect(controller.getState().batteryPercent).toBe(82);

    transport.dropConnection();
    expect(controller.getState().batteryPercent).toBeNull();

    // A reply that was already in flight when the drop happened lands late -
    // gated on isConnected, it must not resurrect a stale number.
    transport.emit(batteryFrame(55));
    expect(controller.getState().batteryPercent).toBeNull();
  });

  it('the periodic poll issues a further CMD.BATTERY query', async () => {
    const transport = connectedFake();
    const interval = fakeIntervalPair();
    const controller = createDeviceController(() => new HuionNoteBLE(transport), {
      setInterval: interval.setInterval,
      clearInterval: interval.clearInterval,
    });

    await controller.connect();
    const before = transport.written.filter((f) => f[1] === CMD.BATTERY).length;

    interval.fireAll();
    await tick(10); // requestBattery()'s write is a dangling async call

    const after = transport.written.filter((f) => f[1] === CMD.BATTERY).length;
    expect(after).toBeGreaterThan(before);
  });

  it('a drop clears batteryPercent synchronously and stops the poll from issuing further queries', async () => {
    const transport = connectedFake();
    const interval = fakeIntervalPair();
    const controller = createDeviceController(() => new HuionNoteBLE(transport), {
      setInterval: interval.setInterval,
      clearInterval: interval.clearInterval,
    });

    await controller.connect();
    transport.emit(batteryFrame(60));
    expect(controller.getState().batteryPercent).toBe(60);

    transport.dropConnection();
    // Synchronous with the drop - not waiting on the next poll tick.
    expect(controller.getState().batteryPercent).toBeNull();

    const before = transport.written.filter((f) => f[1] === CMD.BATTERY).length;
    interval.fireAll();
    await tick(10);
    const after = transport.written.filter((f) => f[1] === CMD.BATTERY).length;
    expect(after).toBe(before);
  });

  it('a successful reconnect resumes the periodic poll', async () => {
    const transport = pageCountFake(() => 0);
    const interval = fakeIntervalPair();
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      { setInterval: interval.setInterval, clearInterval: interval.clearInterval, reconnect: { delaysMs: [10] } },
    );

    await controller.connect();
    // The reconnect chase (and therefore its onSuccess, which restarts the
    // battery poll) only engages while capturing - handleDrop() is a no-op
    // otherwise, same as every other reconnect test in this file.
    await controller.startCapture();
    const beforeDrop = interval.callbacks.length;

    transport.dropConnection();
    // The reconnect handshake includes a real ~100ms sleep (VERIFY_RESPONSE
    // -> MAX_INFO); 300ms comfortably covers the 10ms retry delay plus that.
    await tick(300);

    expect(interval.callbacks.length).toBeGreaterThan(beforeDrop);

    const before = transport.written.filter((f) => f[1] === CMD.BATTERY).length;
    interval.fireAll();
    await tick(10);
    const after = transport.written.filter((f) => f[1] === CMD.BATTERY).length;
    // The *new* (post-reconnect) interval callback is live and issues a query.
    expect(after).toBeGreaterThan(before);
    controller.stopCapture();
  });
});

describe('paced write queue in the composition', () => {
  it('drives a full drop-and-reconnect cycle through the paced transport', async () => {
    // createPacedTransport is otherwise applied only in HuionNoteBLE's
    // `transport === undefined` branch, and every driver and controller test
    // injects a fake explicitly - so the queue was never in the system under
    // test. This wires it in for real: handshake, capture, streaming, a
    // transport-level drop and the reconnect (which goes through the paced
    // reopen(), the path that now flushes the dead session's queue) all pass
    // through it.
    const inner = pageCountFake(() => 0);
    const paced = createPacedTransport(inner, { minGapMs: 30 });
    const controller = createDeviceController(
      () => new HuionNoteBLE(paced),
      { reconnect: { delaysMs: [10] }, pageTurn: { pollIntervalMs: 60_000 } },
    );

    await controller.connect();
    await controller.startStreaming();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(true);

    inner.dropConnection();
    expect(controller.getState().isStreaming).toBe(false);
    // Paced handshake + streaming restore: the driver's own sleeps (~500ms)
    // plus the queue's floor on roughly a dozen frames.
    await tick(1500);
    controller.stopCapture();

    expect(controller.getState().isConnected).toBe(true);
    expect(controller.getState().isStreaming).toBe(true);

    // Nothing ever reached the radio faster than the floor, across every
    // caller in the composition at once.
    const gaps = inner.writtenAt.slice(1).map((t, i) => t - inner.writtenAt[i]);
    expect(gaps.filter((g) => g < 25)).toEqual([]);
  }, 10_000);
});

describe('page count single-flight', () => {
  it('coalesces concurrent getStoredPageCount callers into one driver call', async () => {
    // The driver's own getStoredPageCount() is single-flight and throws on a
    // second concurrent call - this composition now has three independent
    // callers of it (detector poll, watchdog ping, this public method), so
    // without coalescing this would reject instead of resolving both.
    const count = 7;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    await controller.connect();

    const [a, b] = await Promise.all([
      controller.getStoredPageCount(),
      controller.getStoredPageCount(),
    ]);

    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(transport.written.filter((frame) => frame[1] === CMD.CURRENT_PAGE)).toHaveLength(1);
  });
});

describe('watchdog-detected drop', () => {
  it('does not double-diagnose an ordinary drop that lands on an in-flight ping', async () => {
    // The driver's handleDisconnect() calls setStatus('Disconnected') BEFORE
    // it rejects a pending page-count read. So on a perfectly ordinary
    // transport drop the order is: status -> handleDrop() -> watchdog.stop(),
    // and only then does the watchdog's outstanding ping reject. Without a
    // generation guard in liveness.ts that rejection still fired onDead(),
    // `capturing` was still true, and the controller logged "Link is silent
    // and unresponsive" and pushed a redundant reportLinkDead() into an
    // already-arming chase - corrupting the probe's marker timeline, which is
    // this phase's deliverable.
    const transport = pageCountFake(() => 0);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      {
        // idleMs 0: every check tick wants to ping, so one is reliably
        // outstanding when the drop lands.
        liveness: { idleMs: 0, checkIntervalMs: 10 },
        pageTurn: { pollIntervalMs: 60_000 },
        // Long enough that the chase cannot actually reconnect and muddy the
        // log during the test.
        reconnect: { delaysMs: [10_000] },
      },
    );
    const logs: string[] = [];
    controller.subscribeLog((line) => logs.push(line));

    await controller.connect();
    await controller.startCapture();

    // The device goes quiet on CURRENT_PAGE: the write still lands, the reply
    // never comes, so the ping pends exactly as it does in the field.
    transport.on(CMD.CURRENT_PAGE, () => []);
    await tick(60);

    transport.dropConnection();
    await tick(60);
    controller.stopCapture();

    expect(logs.filter((l) => l.includes('Link is silent'))).toEqual([]);
    // The ordinary drop path still arms the chase - exactly once.
    expect(logs.filter((l) => l.includes('Reconnect attempt'))).toHaveLength(1);
  });


  it('clears isStreaming honestly on drop, then genuinely restores it on reconnect', async () => {
    // The link looks nominally connected (no transport-level disconnect) but
    // stops answering CURRENT_PAGE - exactly what the liveness watchdog
    // exists to catch, as opposed to a real drop (which the other tests in
    // this file cover via transport.dropConnection()).
    const transport = pageCountFake(() => 0);
    let failPing = false;
    const originalWrite = transport.write.bind(transport);
    transport.write = async (data: Uint8Array): Promise<void> => {
      if (failPing && data[1] === CMD.CURRENT_PAGE) {
        throw new Error('simulated unresponsive link');
      }
      await originalWrite(data);
    };

    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      {
        liveness: { idleMs: 0, checkIntervalMs: 10 },
        // Far longer than the test, so only the watchdog's own ping (via
        // CURRENT_PAGE) can possibly trip the failure - not the detector's
        // unrelated background poll.
        pageTurn: { pollIntervalMs: 60_000 },
        reconnect: { delaysMs: [10] },
      },
    );
    const states: { isConnected: boolean; isStreaming: boolean }[] = [];
    controller.subscribeState((s) => states.push({ isConnected: s.isConnected, isStreaming: s.isStreaming }));

    await controller.connect();
    await controller.startStreaming();
    await controller.startCapture();
    expect(controller.getState().isStreaming).toBe(true);

    // Only states from here on are relevant: the initial connect handshake
    // legitimately passes through isConnected: false (e.g. 'Handshaking...')
    // on its way up, which is not the drop this test is about.
    const baseline = states.length;

    failPing = true; // the link now looks connected but never answers a ping
    // Long enough for the watchdog to detect the silence, for at least one
    // full reconnect handshake (which includes a real 100ms sleep) to run to
    // completion, AND (Task 8) for the streaming-restore sequence that
    // follows a successful reconnect (~400ms of its own sleeps) to finish.
    // Because `failPing` never resets, the watchdog keeps re-killing the
    // link after each restore, so this window may catch more than one
    // drop/restore cycle - the assertions below only rely on "restore
    // happened at least once", not on where the window happens to end, so
    // that oscillation doesn't make the test flaky.
    await tick(900);
    controller.stopCapture();

    const afterCapture = states.slice(baseline);
    const dropIndex = afterCapture.findIndex((s) => s.isConnected === false);
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    // Right at the drop, isStreaming must already be false - not stale from
    // before the watchdog killed the link. This is the original bug this
    // test covered: a watchdog-detected drop that left `streaming` (and
    // therefore `isStreaming`) untouched, so reconnecting could report
    // streaming as still active with no pen data arriving.
    expect(afterCapture[dropIndex].isStreaming).toBe(false);
    // Task 8: streaming was active before the drop, so a successful
    // reconnect restores it - genuinely, by re-issuing the enable sequence,
    // not by leaving a stale flag. Proven two ways: the state eventually
    // reports isStreaming true again, and the enable frames were actually
    // written a second time (a stale-flag bug would flip the state without
    // ever writing anything new).
    expect(afterCapture.slice(dropIndex).some((s) => s.isStreaming === true)).toBe(true);
    const enableFrames = transport.written.filter((f) => f[1] === CMD.ONLINE_ENABLE);
    expect(enableFrames.length).toBeGreaterThanOrEqual(4);
  });
});
