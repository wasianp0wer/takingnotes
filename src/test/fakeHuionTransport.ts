import type { HuionTransport } from '@/utils/huionTransport';

/**
 * Scriptable stand-in for a Huion device. Tests register responders keyed by
 * command byte; when the driver writes a frame, the matching responder's
 * frames are delivered back through the notify handler on a microtask, which
 * is close enough to the real timing for the driver's state machine.
 */
export class FakeHuionTransport implements HuionTransport {
  readonly deviceName = 'Fake Huion Note';
  readonly deviceId = 'fake-device-id';

  /** Every frame the driver has written, in order. */
  readonly written: Uint8Array[] = [];

  private notifyHandler: ((data: Uint8Array) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private responders = new Map<number, (frame: Uint8Array) => Uint8Array[]>();
  private opened = false;

  /** Reply to command `cmd` with the frames `respond` returns. */
  on(cmd: number, respond: (frame: Uint8Array) => Uint8Array[]): void {
    this.responders.set(cmd, respond);
  }

  /** Push an unsolicited frame, e.g. a page-turn button press. */
  emit(frame: Uint8Array): void {
    this.notifyHandler?.(frame);
  }

  /** Simulate the device dropping the connection. */
  dropConnection(): void {
    this.opened = false;
    this.disconnectHandler?.();
  }

  onNotify(handler: (data: Uint8Array) => void): void {
    this.notifyHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error('FakeHuionTransport: write before open');
    this.written.push(new Uint8Array(data));
    const responder = this.responders.get(data[1]);
    if (!responder) return;
    for (const frame of responder(data)) {
      // Deliver asynchronously so the driver's await resolves first, matching
      // the real radio's ordering.
      await Promise.resolve();
      this.notifyHandler?.(frame);
    }
  }

  async close(): Promise<void> {
    this.opened = false;
  }
}
