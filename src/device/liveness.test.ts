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

  it('stop() ends all checking, and a ping still in flight cannot report dead', async () => {
    // The previous version of this test used a synchronously-resolving ping,
    // so nothing was ever in flight at stop() and it could only prove that no
    // FURTHER pings are issued - which clearing the interval already
    // guaranteed. This version holds a ping open across stop() and rejects it
    // afterwards, which is the case that actually happens: the driver fires
    // 'Disconnected' (-> controller.handleDrop -> watchdog.stop()) BEFORE it
    // rejects the in-flight page-count read the ping is waiting on.
    let rejectPing!: (err: Error) => void;
    const ping = vi.fn(() => new Promise<number>((_resolve, reject) => { rejectPing = reject; }));
    const onDead = vi.fn();
    const dog = createLivenessWatchdog(
      { ping, onDead },
      { idleMs: 10, checkIntervalMs: 10 },
    );
    dog.start();
    await tick(40);
    expect(ping).toHaveBeenCalledTimes(1); // a ping is genuinely outstanding

    dog.stop();
    const count = ping.mock.calls.length;
    rejectPing(new Error('link gone'));
    await tick(80);

    expect(onDead).not.toHaveBeenCalled();
    expect(ping.mock.calls.length).toBe(count); // still no further pings
  });

  it('a ping outstanding across stop()+start() cannot kill the new session', async () => {
    // stopCapture() then startCapture() inside the ping's timeout window. The
    // stale ping settles while the new session is live and `capturing` is
    // true again; without a generation guard its rejection tears down a
    // healthy link, and its resolution backdates the new idle window.
    const rejects: Array<(err: Error) => void> = [];
    const ping = vi.fn(() => new Promise<number>((_resolve, reject) => { rejects.push(reject); }));
    const onDead = vi.fn();
    const dog = createLivenessWatchdog(
      { ping, onDead },
      { idleMs: 10, checkIntervalMs: 10 },
    );
    dog.start();
    await tick(40);
    expect(rejects).toHaveLength(1);

    dog.stop();
    dog.start();
    await tick(40);
    // The new session must not be locked out by the stale ping's slot.
    expect(ping.mock.calls.length).toBeGreaterThan(1);

    rejects[0](new Error('stale ping from the stopped session'));
    await tick(40);
    expect(onDead).not.toHaveBeenCalled();

    // The live session's own ping still reports dead normally.
    rejects[rejects.length - 1](new Error('link gone'));
    await tick(40);
    expect(onDead).toHaveBeenCalledTimes(1);

    dog.stop();
  });
});
