import { describe, expect, it } from 'vitest';
import { createPacedTransport } from '@/utils/pacedTransport';
import { FakeHuionTransport } from '@/test/fakeHuionTransport';

describe('createPacedTransport', () => {
  it('serializes bursts to the minimum gap', async () => {
    const inner = new FakeHuionTransport();
    const paced = createPacedTransport(inner, { minGapMs: 30 });
    await paced.open();

    await Promise.all([1, 2, 3, 4].map((n) => paced.write(new Uint8Array([n]))));

    expect(inner.written.map((f) => f[0])).toEqual([1, 2, 3, 4]); // FIFO
    const gaps = inner.writtenAt.slice(1).map((t, i) => t - inner.writtenAt[i]);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(25); // 30ms less timer slop
  });

  it('does not delay a caller already slower than the floor', async () => {
    const inner = new FakeHuionTransport();
    const paced = createPacedTransport(inner, { minGapMs: 20 });
    await paced.open();

    const started = Date.now();
    for (const n of [1, 2, 3]) {
      await paced.write(new Uint8Array([n]));
      await new Promise((r) => setTimeout(r, 40));
    }
    // 3 writes at 40ms self-pacing = ~120ms. If the queue compounded, ~180ms.
    expect(Date.now() - started).toBeLessThan(170);
  });

  it('rejects queued writes on close instead of stranding them', async () => {
    const inner = new FakeHuionTransport();
    const paced = createPacedTransport(inner, { minGapMs: 50 });
    await paced.open();

    const first = paced.write(new Uint8Array([1]));
    const queued = paced.write(new Uint8Array([2]));
    const settled = queued.then(() => 'resolved').catch(() => 'rejected');
    await paced.close();

    await first.catch(() => {});
    expect(await settled).toBe('rejected');
  });

  it('keeps draining after one write throws', async () => {
    const inner = new FakeHuionTransport();
    await inner.open();
    const paced = createPacedTransport(inner, { minGapMs: 5 });
    let calls = 0;
    const realWrite = inner.write.bind(inner);
    inner.write = async (data: Uint8Array) => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return realWrite(data);
    };

    const failed = paced.write(new Uint8Array([1])).catch(() => 'rejected');
    const after = paced.write(new Uint8Array([2]));

    expect(await failed).toBe('rejected');
    await after; // must not be stranded behind the failure
    expect(inner.written.map((f) => f[0])).toEqual([2]);
  });

  it('passes identity and handlers through to the inner transport', async () => {
    const inner = new FakeHuionTransport();
    const paced = createPacedTransport(inner);
    const seen: Uint8Array[] = [];
    paced.onNotify((d) => seen.push(d));
    await paced.open();
    inner.emit(new Uint8Array([0xcd]));

    expect(paced.deviceName).toBe(inner.deviceName);
    expect(paced.deviceId).toBe(inner.deviceId);
    expect(seen).toHaveLength(1);
  });
});
