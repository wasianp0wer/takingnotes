import { describe, expect, it, vi } from 'vitest';
import { createReconnectPolicy } from '@/device/reconnect';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createReconnectPolicy', () => {
  it('retries with increasing delays until it succeeds', async () => {
    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('still down');
    });
    const onSuccess = vi.fn();
    const policy = createReconnectPolicy(
      { reconnect, onSuccess },
      { delaysMs: [5, 10, 20] },
    );

    policy.start();
    await tick(200);

    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(policy.isReconnecting).toBe(false);
  });

  it('repeats the final delay rather than giving up', async () => {
    const seen: number[] = [];
    const policy = createReconnectPolicy(
      { reconnect: async () => { throw new Error('down'); },
        onAttempt: (_a, delayMs) => seen.push(delayMs) },
      { delaysMs: [5, 10], maxAttempts: 4 },
    );

    policy.start();
    await tick(200);

    expect(seen).toEqual([5, 10, 10, 10]);
  });

  it('stop() prevents any further attempt', async () => {
    const reconnect = vi.fn(async () => { throw new Error('down'); });
    const policy = createReconnectPolicy({ reconnect }, { delaysMs: [5] });

    policy.start();
    await tick(20);
    policy.stop();
    const countAtStop = reconnect.mock.calls.length;
    await tick(60);

    expect(reconnect.mock.calls.length).toBe(countAtStop);
    expect(policy.isReconnecting).toBe(false);
  });

  it('start() while already running does not start a second loop', async () => {
    const reconnect = vi.fn(async () => { throw new Error('down'); });
    const policy = createReconnectPolicy({ reconnect }, { delaysMs: [10], maxAttempts: 3 });

    policy.start();
    policy.start();
    policy.start();
    await tick(120);

    expect(reconnect).toHaveBeenCalledTimes(3); // not 9
  });

  it('calls onGiveUp when maxAttempts is exhausted', async () => {
    const onGiveUp = vi.fn();
    const policy = createReconnectPolicy(
      { reconnect: async () => { throw new Error('down'); }, onGiveUp },
      { delaysMs: [5], maxAttempts: 2 },
    );

    policy.start();
    await tick(80);

    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('does not fire callbacks for a stale loop after stop and restart', async () => {
    let releaseFirst: () => void = () => {};
    const firstHung = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        // First attempt hangs
        await firstHung;
      }
      // Second and later attempts succeed
    });

    const onSuccess = vi.fn();
    const policy = createReconnectPolicy(
      { reconnect, onSuccess },
      { delaysMs: [5] },
    );

    policy.start(); // Loop A
    await tick(20);
    policy.stop(); // Stop loop A while it is hung in reconnect()
    policy.start(); // Loop B
    await tick(20);
    releaseFirst(); // Release loop A's hung reconnect
    await tick(50);

    // Loop A should not have fired onSuccess even though its reconnect succeeded.
    // Only loop B should fire onSuccess.
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(policy.isReconnecting).toBe(false);
  });

  it('continues retrying if onAttempt throws', async () => {
    const reconnect = vi.fn(async () => { throw new Error('down'); });
    const onAttempt = vi.fn(() => { throw new Error('boom'); });
    const policy = createReconnectPolicy(
      { reconnect, onAttempt },
      { delaysMs: [5], maxAttempts: 3 },
    );

    policy.start();
    await tick(100);

    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(policy.isReconnecting).toBe(false);
  });

  it('does not fire onSuccess if stop() is called while reconnect is hung', async () => {
    let releaseHang: () => void = () => {};
    const hung = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    let calls = 0;
    const reconnect = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        // First attempt hangs
        await hung;
      }
      // If called again, would succeed
    });

    const onSuccess = vi.fn();
    const policy = createReconnectPolicy(
      { reconnect, onSuccess },
      { delaysMs: [5] },
    );

    policy.start();
    await tick(20);
    policy.stop(); // Stop while reconnect is hung, no subsequent start()
    releaseHang(); // Release the hung reconnect
    await tick(50);

    // Even though reconnect() eventually succeeded, onSuccess must not fire
    // because the loop was stopped before it could settle
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(0);
    expect(policy.isReconnecting).toBe(false);
  });
});
