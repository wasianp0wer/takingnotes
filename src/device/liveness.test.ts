import { describe, expect, it, vi } from 'vitest';
import { createLivenessWatchdog } from '@/device/liveness';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createLivenessWatchdog', () => {
  it('does not ping while frames keep arriving', async () => {
    const ping = vi.fn(async () => 0);
    const dog = createLivenessWatchdog(
      { ping, onDead: () => {} },
      { idleMs: 60, checkIntervalMs: 10 },
    );
    dog.start();
    for (let i = 0; i < 8; i++) { dog.noteFrame(); await tick(20); }
    dog.stop();

    expect(ping).not.toHaveBeenCalled();
  });

  it('pings once the idle window elapses', async () => {
    const ping = vi.fn(async () => 0);
    const dog = createLivenessWatchdog(
      { ping, onDead: () => {} },
      { idleMs: 40, checkIntervalMs: 10 },
    );
    dog.start();
    await tick(120);
    dog.stop();

    expect(ping).toHaveBeenCalled();
  });

  it('reports dead when the ping rejects', async () => {
    const onDead = vi.fn();
    const dog = createLivenessWatchdog(
      { ping: async () => { throw new Error('gone'); }, onDead },
      { idleMs: 20, checkIntervalMs: 10 },
    );
    dog.start();
    await tick(120);
    dog.stop();

    expect(onDead).toHaveBeenCalled();
  });

  it('does not overlap pings', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dog = createLivenessWatchdog(
      {
        ping: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick(50);
          inFlight--;
        },
        onDead: () => {},
      },
      { idleMs: 10, checkIntervalMs: 10 },
    );
    dog.start();
    await tick(200);
    dog.stop();

    expect(maxInFlight).toBe(1);
  });

  it('stop() ends all checking', async () => {
    const ping = vi.fn(async () => 0);
    const dog = createLivenessWatchdog(
      { ping, onDead: () => {} },
      { idleMs: 10, checkIntervalMs: 10 },
    );
    dog.start();
    await tick(50);
    dog.stop();
    const count = ping.mock.calls.length;
    await tick(80);

    expect(ping.mock.calls.length).toBe(count);
  });
});
