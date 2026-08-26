import { describe, expect, it } from 'vitest';

import { FakeHuionTransport } from '@/test/fakeHuionTransport';

/**
 * The fake's reply ordering is load-bearing: driver paths like `downloadPages()`
 * await `write()` and only afterwards assign the resolver that the notification
 * handler reads. If a reply arrives before `write()` settles, those paths see a
 * null resolver and stall — a fake-only artefact that looks exactly like a
 * driver bug, and would tempt a reorder of hardware-proven code to "fix" it.
 */
describe('FakeHuionTransport reply ordering', () => {
  it('settles write() before delivering the reply', async () => {
    const events: string[] = [];
    const transport = new FakeHuionTransport();
    transport.onNotify(() => { events.push('reply delivered'); });
    transport.on(0x81, () => [new Uint8Array([0xcd, 0x81, 0x08])]);
    await transport.open();

    await transport.write(new Uint8Array([0xcd, 0x81, 0x08, 0, 0, 0, 0, 0xed]));
    events.push('write() settled');

    // Let the queued macrotask run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(['write() settled', 'reply delivered']);
  });

  it('invokes a responder once, synchronously, and queues every frame in order', async () => {
    const transport = new FakeHuionTransport();
    const received: number[] = [];
    let responderCalls = 0;
    transport.onNotify((frame) => { received.push(frame[3]); });
    transport.on(0x86, () => {
      responderCalls += 1;
      return [
        new Uint8Array([0xcd, 0x86, 0x08, 1]),
        new Uint8Array([0xcd, 0x86, 0x08, 2]),
        new Uint8Array([0xcd, 0x86, 0x08, 3]),
      ];
    });
    await transport.open();

    await transport.write(new Uint8Array([0xcd, 0x86, 0x08, 0, 0, 0, 0, 0xed]));

    expect(responderCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([1, 2, 3]);
  });

  it('rejects a write before open', async () => {
    const transport = new FakeHuionTransport();
    await expect(transport.write(new Uint8Array([0xcd]))).rejects.toThrow('write before open');
  });
});
