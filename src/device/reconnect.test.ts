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
});
