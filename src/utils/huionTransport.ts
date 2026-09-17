import { NOTIFY_UUID, SERVICE_UUID, WRITE_UUID } from '@/utils/huionProtocol';

/**
 * A raw byte pipe to a Huion device. Everything above this interface is
 * protocol; everything below it is radio. The split exists so the protocol
 * state machine can be driven in tests without Bluetooth.
 */
export interface HuionTransport {
  /** Human-readable device name, once connected. */
  readonly deviceName: string;
  /** Stable per-device identifier, used to build the notebook UUID. */
  readonly deviceId: string;
  /** Opens the pipe. Resolves once bytes can flow in both directions. */
  open(): Promise<void>;
  /**
   * Reconnects to the device a previous `open()` selected, skipping device
   * selection. Web Bluetooth requires a user gesture for `requestDevice()`
   * but not for `gatt.connect()` on an already-permitted device, which is
   * what makes silent auto-reconnect possible. Rejects if never opened.
   */
  reopen(): Promise<void>;
  /** Sends one frame. */
  write(data: Uint8Array): Promise<void>;
  /** Registers the inbound byte handler. Called once, before `open()`. */
  onNotify(handler: (data: Uint8Array) => void): void;
  /** Registers a disconnect handler. Called once, before `open()`. */
  onDisconnect(handler: () => void): void;
  /** Closes the pipe. Safe to call when already closed. */
  close(): Promise<void>;
}

export const HUION_BLE_FILTERS: BluetoothRequestDeviceFilter[] = [
  { namePrefix: 'Huion' },
  { namePrefix: 'HUION' },
  { namePrefix: 'Note' },
];

export const HUION_OPTIONAL_SERVICES = [SERVICE_UUID, 'battery_service'];

export { NOTIFY_UUID, WRITE_UUID };

type LogFn = (msg: string) => void;

/** The real Web Bluetooth transport. */
export class BleHuionTransport implements HuionTransport {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyHandler: ((data: Uint8Array) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  // Fields + constructor-body assignment, NOT `constructor(private log: LogFn)`.
  // Parameter properties are TypeScript-only syntax and `erasableSyntaxOnly`
  // rejects them; the build fails.
  private readonly log: LogFn;
  // `setStatus` is here only so the status line reads exactly as it did before
  // the transport seam was introduced — `open()` moved two status updates
  // ('Scanning...', 'Connecting GATT...') out of the driver with it.
  private readonly setStatus: LogFn;

  // Device identity is cached at open() and deliberately survives close().
  // `notebookUuid` (built from deviceId) is the storage key for everything
  // downloaded from this device, and callers legitimately read it *after* the
  // link has dropped - the session engine finalises a session once the device
  // may already be gone, and the driver's own `handleDisconnect` reports
  // `deviceName` from inside the disconnect callback. Nulling `this.device`
  // in close() without this cache would regress both to 'Unknown'/'unknown'
  // and silently key notes as `huion:unknown`.
  private cachedName = 'Unknown';
  private cachedId = 'unknown';

  constructor(log: LogFn = () => {}, setStatus: LogFn = () => {}) {
    this.log = log;
    this.setStatus = setStatus;
  }

  get deviceName(): string { return this.device?.name ?? this.cachedName; }
  get deviceId(): string { return this.device?.id || this.device?.name || this.cachedId; }

  onNotify(handler: (data: Uint8Array) => void): void { this.notifyHandler = handler; }
  onDisconnect(handler: () => void): void { this.disconnectHandler = handler; }

  async open(): Promise<void> {
    this.setStatus('Scanning...');
    this.log('[1/7] Requesting BLE device (filters: Huion, HUION, Note)...');

    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: HUION_BLE_FILTERS,
        optionalServices: HUION_OPTIONAL_SERVICES,
      });
    } catch (e: any) {
      throw new Error(`BLE device request failed: ${e?.message ?? e}. Is the device on and in range? Did you pick it in the Chrome popup?`);
    }

    this.cachedName = this.device.name ?? 'Unknown';
    this.cachedId = this.device.id || this.device.name || 'unknown';

    this.log(`[2/7] Device selected: ${this.device.name ?? 'unnamed'} (${this.device.id})`);

    // Registered once, against the device (not the server), so it survives
    // `establish()` being re-run on reopen(). Must NOT be re-registered
    // there, or a single physical drop would fire the disconnect handler
    // once per reconnect that has ever happened.
    this.device.addEventListener('gattserverdisconnected', () => {
      this.disconnectHandler?.();
    });

    await this.establish();
  }

  async reopen(): Promise<void> {
    if (!this.device) throw new Error('Transport was never opened; cannot reopen');
    this.log('Reconnecting to previously selected device (no user gesture needed)');
    await this.establish();
  }

  /** The GATT half of connecting: everything after device selection. */
  private async establish(): Promise<void> {
    this.setStatus('Connecting GATT...');
    this.log('[3/7] Connecting GATT server...');

    try {
      this.server = await this.device!.gatt!.connect();
    } catch (e: any) {
      throw new Error(`GATT connect failed: ${e?.message ?? e}`);
    }

    this.log('[4/7] GATT connected, discovering service FFE0...');

    try {
      const svc = await this.server.getPrimaryService(SERVICE_UUID);
      this.writeChar = await svc.getCharacteristic(WRITE_UUID);
      this.notifyChar = await svc.getCharacteristic(NOTIFY_UUID);
    } catch (e: any) {
      throw new Error(`Service/characteristic discovery failed: ${e?.message ?? e}. Is this a Huion Note device?`);
    }

    this.log('[5/7] FFE0/FFE1/FFE2 found, enabling notifications...');

    // Attach listener BEFORE startNotifications to avoid missing early packets
    this.notifyChar.addEventListener('characteristicvaluechanged', (e: Event) => {
      const val = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      this.notifyHandler?.(new Uint8Array(val.buffer, val.byteOffset, val.byteLength));
    });

    try {
      await this.notifyChar.startNotifications();
      this.log('FFE1 notifications enabled');
    } catch (e: any) {
      throw new Error(`Failed to start FFE1 notifications: ${e?.message ?? e}`);
    }

    // The Huion APK also enables notifications on FFE2 (the write char).
    // This is unusual but was observed in the decomp — some firmware versions
    // may send responses on FFE2 or need the CCCD written on both.
    try {
      this.writeChar.addEventListener('characteristicvaluechanged', (e: Event) => {
        const val = (e.target as BluetoothRemoteGATTCharacteristic).value!;
        const bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
        this.log(`RX (FFE2): ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')} [log only, not processed]`);
      });
      await this.writeChar.startNotifications();
      this.log('FFE2 notifications also enabled (log only)');
    } catch {
      this.log('FFE2 notifications not supported (normal)');
    }

    // Wait for BLE stack to settle — the APK waits ~2.1s after service discovery
    await this.sleep(500);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error('Not connected');
    const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    this.log(`TX: ${hex}`);
    const payload = new Uint8Array(data);
    // Try write-without-response first (most BLE devices prefer this),
    // fall back to write-with-response, then deprecated writeValue
    try {
      if (this.writeChar.writeValueWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(payload);
      } else {
        throw new Error('writeValueWithoutResponse unavailable');
      }
    } catch {
      try {
        if (this.writeChar.writeValueWithResponse) {
          await this.writeChar.writeValueWithResponse(payload);
        } else {
          throw new Error('writeValueWithResponse unavailable');
        }
      } catch {
        await this.writeChar.writeValue(payload);
      }
    }
  }

  async close(): Promise<void> {
    this.device?.gatt?.disconnect();
    // `this.device` is deliberately NOT nulled: reopen() needs the handle, and
    // nulling it would force a user gesture for every reconnect. The GATT
    // objects below are per-connection and must go.
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
