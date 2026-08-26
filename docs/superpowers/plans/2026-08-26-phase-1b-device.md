# Phase 1B — Device Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Huion driver testable and reusable — extract its pure protocol logic, put a seam between protocol and Bluetooth so it can be driven without hardware, add the three device operations Phase 2 needs, and expose the device through a provider that multiple consumers can subscribe to.

**Architecture:** Three layers, bottom-up. `huionProtocol.ts` holds pure frame/decode functions with no I/O. `huionTransport.ts` is a byte pipe — one real Web Bluetooth implementation, one scriptable fake for tests. `HuionNoteBLE` keeps the protocol state machine and now talks to a transport instead of directly to characteristics. Above it, a plain `deviceController` owns the driver and fans events out to many subscribers; `TabletProvider` is a thin React wrapper over it.

**Tech Stack:** TypeScript (strict), Web Bluetooth, Vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-08-25-note-capture-app.md`

## Global Constraints

- Node `>=20 <23`.
- TypeScript `strict`, plus `noUnusedLocals` and `noUnusedParameters` — the build fails on unused symbols.
- `verbatimModuleSyntax: true` — type-only imports **must** use `import type { … }`.
- `erasableSyntaxOnly: true` — **no `enum`, no parameter properties, no namespaces.** String-literal unions only.
- Path alias `@/*` → `./src/*`.
- **Lint baseline is 53 problems (1 error, 52 warnings), all pre-existing in studio files.** Do not fix them. The bar is: introduce no NEW lint problems.
- The existing studio app must keep working and building. `src/components/TabletPanel.tsx` still uses `HuionNoteBLE` and must continue to function unchanged.
- **Huion only.** Do not wire up `wacomBLE.ts` or `tabletUSB.ts`. Do not delete them.
- No new runtime dependencies. No new dev dependencies — Task 7 is deliberately structured to avoid needing `@testing-library/react`.
- `DB_VERSION` and everything under `src/storage/` are out of scope; Phase 1A owns them.

## The risk this plan is shaped around

`src/utils/huionBLE.ts` is 953 lines of working, reverse-engineered protocol code that talks to real hardware. **No automated test can exercise real Bluetooth.** Tasks 1 and 2 restructure it, and a regression there breaks the one part of this project that already works.

Two mitigations, both mandatory:

1. **Tasks 1 and 2 are strictly behaviour-preserving.** No protocol change, no timing change, no reordering of writes. Only where code lives.
2. **`probe.html` is the hardware smoke test.** It was committed in `9f68fa6` and drives connect → stream → page-turn → download against a real device. After Task 2, and again at the end of the phase, a human runs it and confirms nothing regressed. This is called out as a phase exit criterion and cannot be satisfied headlessly.

---

### Task 1: Extract pure protocol helpers

Behaviour-preserving move. Everything extracted here is already pure — it just isn't reachable from a test.

**Files:**
- Create: `src/utils/huionProtocol.ts`
- Create: `src/utils/huionProtocol.test.ts`
- Modify: `src/utils/huionBLE.ts` (delete the moved definitions, import them instead)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SERVICE_UUID`, `NOTIFY_UUID`, `WRITE_UUID` (strings)
  - `CMD` (the command byte map)
  - `HUION_DEFAULT_PAGE_WIDTH_A5`, `HUION_DEFAULT_PAGE_HEIGHT_A5`, `HUION_DEFAULT_PAGE_WIDTH_A4`, `HUION_DEFAULT_PAGE_HEIGHT_A4`
  - `makeFrame(cmd: number, p1?: number, p2?: number, p3?: number, p4?: number): Uint8Array`
  - `verifyChecksum(data: Uint8Array): boolean`
  - `computeAuthResponse(a: number, b: number, c: number): [number, number, number]`
  - `clamp(value: number, min: number, max: number): number`

- [ ] **Step 1: Write the failing test**

Create `src/utils/huionProtocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  clamp,
  CMD,
  computeAuthResponse,
  makeFrame,
  verifyChecksum,
} from '@/utils/huionProtocol';

describe('makeFrame', () => {
  it('builds the documented 8-byte command frame', () => {
    // Frame format: [0xCD] [CMD] [0x08] [P1] [P2] [P3] [P4] [0xED]
    expect(Array.from(makeFrame(CMD.VERIFY_CONNECT))).toEqual([
      0xcd, 0x81, 0x08, 0, 0, 0, 0, 0xed,
    ]);
  });

  it('places all four parameters', () => {
    expect(Array.from(makeFrame(CMD.SET_PACKET_DISTANCE, 1, 3, 0, 0))).toEqual([
      0xcd, 0x96, 0x08, 1, 3, 0, 0, 0xed,
    ]);
  });
});

describe('verifyChecksum', () => {
  it('accepts a frame whose last byte is the sum of the rest', () => {
    // 0x01 + 0x02 + 0x03 = 0x06
    expect(verifyChecksum(new Uint8Array([0x01, 0x02, 0x03, 0x06]))).toBe(true);
  });

  it('wraps the sum at one byte', () => {
    // 0xFF + 0x02 = 0x101, truncated to 0x01
    expect(verifyChecksum(new Uint8Array([0xff, 0x02, 0x01]))).toBe(true);
  });

  it('rejects a corrupted frame', () => {
    expect(verifyChecksum(new Uint8Array([0x01, 0x02, 0x03, 0x07]))).toBe(false);
  });

  it('rejects a frame too short to contain a checksum', () => {
    expect(verifyChecksum(new Uint8Array([0x01]))).toBe(false);
  });
});

describe('computeAuthResponse', () => {
  it('applies the documented handshake formula', () => {
    // ((a+b)<<2)%255, ((b+c)<<2)%255, ((c+10)<<2)%255
    expect(computeAuthResponse(1, 2, 3)).toEqual([12, 20, 52]);
  });

  it('wraps each component at 255', () => {
    // (100+100)<<2 = 800; 800 % 255 = 35
    expect(computeAuthResponse(100, 100, 0)[0]).toBe(35);
  });
});

describe('clamp', () => {
  it('passes a value already inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps both directions', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/huionProtocol.test.ts`
Expected: FAIL — cannot resolve `@/utils/huionProtocol`.

- [ ] **Step 3: Create the module**

Create `src/utils/huionProtocol.ts`. **Move** — do not retype — the following from `src/utils/huionBLE.ts`, adding `export` to each: the three UUID constants, the `CMD` object, the four page-size constants, `makeFrame`, `verifyChecksum`, `computeAuthResponse`, and `clamp`. Keep the existing explanatory comments with them, including the protocol header block describing the frame format and auth formula.

- [ ] **Step 4: Update the driver to import them**

In `src/utils/huionBLE.ts`, delete the moved definitions and add at the top:

```ts
import {
  clamp,
  CMD,
  computeAuthResponse,
  HUION_DEFAULT_PAGE_HEIGHT_A4,
  HUION_DEFAULT_PAGE_HEIGHT_A5,
  HUION_DEFAULT_PAGE_WIDTH_A4,
  HUION_DEFAULT_PAGE_WIDTH_A5,
  makeFrame,
  NOTIFY_UUID,
  SERVICE_UUID,
  verifyChecksum,
  WRITE_UUID,
} from '@/utils/huionProtocol';
```

Import only what the file actually still uses — `noUnusedLocals` fails the build on an unused import.

- [ ] **Step 5: Run the tests and the build**

```bash
npx vitest run src/utils/huionProtocol.test.ts
npm test
npm run build
npm run lint
```
Expected: new tests pass, full suite passes, build succeeds, lint still reports exactly 53 problems.

- [ ] **Step 6: Commit**

```bash
git add src/utils/huionProtocol.ts src/utils/huionProtocol.test.ts src/utils/huionBLE.ts
git commit -m "refactor(huion): extract pure protocol helpers"
```

---

### Task 2: Introduce the transport seam

The reason the driver is untestable is that `connect()` reaches straight for `navigator.bluetooth`, and `write()` reaches straight for a GATT characteristic. This task puts an interface between the protocol state machine and the radio.

**Strictly behaviour-preserving.** The same bytes must go out in the same order with the same delays. Do not "improve" the handshake, the 500 ms settle, or the dual-notification setup while moving them.

**Files:**
- Create: `src/utils/huionTransport.ts`
- Create: `src/test/fakeHuionTransport.ts`
- Create: `src/utils/huionBLE.test.ts`
- Modify: `src/utils/huionBLE.ts`

**Interfaces:**
- Consumes: `SERVICE_UUID`, `NOTIFY_UUID`, `WRITE_UUID`, `makeFrame`, `CMD` from Task 1.
- Produces:
  - `HuionTransport` interface
  - `BleHuionTransport` — the real Web Bluetooth implementation
  - `FakeHuionTransport` — scriptable test double
  - `HuionNoteBLE` constructor now accepts an optional transport

- [ ] **Step 1: Define the transport interface**

Create `src/utils/huionTransport.ts`:

```ts
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
  /** Sends one frame. */
  write(data: Uint8Array): Promise<void>;
  /** Registers the inbound byte handler. Called once, before `open()`. */
  onNotify(handler: (data: Uint8Array) => void): void;
  /** Registers a disconnect handler. Called once, before `open()`. */
  onDisconnect(handler: () => void): void;
  /** Closes the pipe. Safe to call when already closed. */
  close(): Promise<void>;
}

export const HUION_BLE_FILTERS: BluetoothLEScanFilter[] = [
  { namePrefix: 'Huion' },
  { namePrefix: 'HUION' },
  { namePrefix: 'Note' },
];

export const HUION_OPTIONAL_SERVICES = [SERVICE_UUID, 'battery_service'];

export { NOTIFY_UUID, WRITE_UUID };
```

`BleHuionTransport` is added in Step 2 by moving existing code, not written from
scratch here — a stub in this step would either ship a throwing method or
duplicate ~100 lines of Bluetooth setup that already exist and work.

- [ ] **Step 2: Move the Bluetooth code into `BleHuionTransport`**

Add the class to `src/utils/huionTransport.ts` with this shape, then fill the
three method bodies by **moving** code — do not retype it:

```ts
type LogFn = (msg: string) => void;

/** The real Web Bluetooth transport. */
export class BleHuionTransport implements HuionTransport {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyHandler: ((data: Uint8Array) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  // A field + constructor-body assignment, NOT `constructor(private log: LogFn)`.
  // Parameter properties are TypeScript-only syntax and `erasableSyntaxOnly`
  // rejects them; the build fails.
  private readonly log: LogFn;

  constructor(log: LogFn = () => {}) {
    this.log = log;
  }

  get deviceName(): string { return this.device?.name ?? 'Unknown'; }
  get deviceId(): string { return this.device?.id || this.device?.name || 'unknown'; }

  onNotify(handler: (data: Uint8Array) => void): void { this.notifyHandler = handler; }
  onDisconnect(handler: () => void): void { this.disconnectHandler = handler; }

  async open(): Promise<void> { /* moved, see below */ }
  async write(data: Uint8Array): Promise<void> { /* moved, see below */ }

  async close(): Promise<void> {
    this.device?.gatt?.disconnect();
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
  }
}
```

From `src/utils/huionBLE.ts`:

- Move the body of `connect()` **up to and including the 500 ms settle sleep** (currently `[1/7]` through the `await this.sleep(500)` line) into `BleHuionTransport.open()`. Replace `this.handleNotification(...)` in the FFE1 listener with `this.notifyHandler?.(bytes)`. Replace the `gattserverdisconnected` listener body with `this.disconnectHandler?.()`.
- Move the body of the private `write()` method — the three-way `writeValueWithoutResponse` / `writeValueWithResponse` / `writeValue` fallback — into `BleHuionTransport.write()`, keeping all three fallbacks and the TX hex log.
- The handshake (`[6/7]`, the `connectResolve`/`connectReject` promise, the 10 s timeout, and the initial `VERIFY_CONNECT` write) **stays in the driver** — it is protocol, not transport.

- [ ] **Step 3: Rewire `HuionNoteBLE` onto the transport**

In `src/utils/huionBLE.ts`:

```ts
export class HuionNoteBLE implements TabletBackendCapabilities {
  private transport: HuionTransport;

  constructor(transport?: HuionTransport) {
    this.transport = transport ?? new BleHuionTransport((msg) => this.log(msg));
  }

  get deviceName() { return this.transport.deviceName; }

  get notebookUuid() { return `huion:${this.transport.deviceId}`; }

  private write(data: Uint8Array): Promise<void> {
    return this.transport.write(data);
  }

  async connect(): Promise<void> {
    this.transport.onNotify((bytes) => {
      this.handleNotification(bytes).catch((err) =>
        this.log(`Notification handler error: ${err?.message ?? err}`),
      );
    });
    this.transport.onDisconnect(() => this.handleDisconnect());
    await this.transport.open();
    await this.performHandshake();   // the moved [6/7] block
  }

  async disconnect(): Promise<void> {
    if (this.streaming) await this.stopStreaming();
    this.clearPageRetryTimer();
    await this.transport.close();
    this.authenticated = false;
    this.streaming = false;
    this.setStatus('Disconnected');
  }
}
```

Extract the existing `gattserverdisconnected` handler body into a private `handleDisconnect()` — unchanged logic, just relocated so the transport can invoke it.

- [ ] **Step 4: Write the fake transport**

Create `src/test/fakeHuionTransport.ts`:

```ts
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
```

- [ ] **Step 5: Write the shared test fixtures**

Both this task's tests and Task 7's need the same two helpers. Define them once.

Create `src/test/huionFixtures.ts`:

```ts
import { FakeHuionTransport } from '@/test/fakeHuionTransport';
import { CMD } from '@/utils/huionProtocol';

/** Appends the protocol's one-byte sum checksum, as a real device would. */
export function withChecksum(bytes: number[]): Uint8Array {
  const sum = bytes.reduce((total, byte) => total + byte, 0) & 0xff;
  return new Uint8Array([...bytes, sum]);
}

/**
 * A transport that completes the auth handshake the way a real device does,
 * so a test can start from a connected driver in one line.
 */
export function connectedFake(): FakeHuionTransport {
  const transport = new FakeHuionTransport();
  // Device issues challenge (a,b,c) = (1,2,3).
  transport.on(CMD.VERIFY_CONNECT, () => [
    withChecksum([0xcd, CMD.VERIFY_CONNECT, 0x08, 1, 2, 3, 0]),
  ]);
  // Device accepts the response.
  transport.on(CMD.VERIFY_RESPONSE, () => [
    withChecksum([0xcd, CMD.VERIFY_RESPONSE, 0x08, 1, 0, 0, 0]),
  ]);
  return transport;
}
```

- [ ] **Step 6: Write the driver test**

Create `src/utils/huionBLE.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { FakeHuionTransport } from '@/test/fakeHuionTransport';
import { connectedFake, withChecksum } from '@/test/huionFixtures';
import { HuionNoteBLE } from '@/utils/huionBLE';
import { CMD, computeAuthResponse } from '@/utils/huionProtocol';

describe('HuionNoteBLE handshake', () => {
  it('replies to the auth challenge with the computed response', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);

    await device.connect();

    const reply = transport.written.find((frame) => frame[1] === CMD.VERIFY_RESPONSE);
    expect(reply).toBeDefined();
    const [r1, r2, r3] = computeAuthResponse(1, 2, 3);
    expect([reply![3], reply![4], reply![5]]).toEqual([r1, r2, r3]);
    expect(device.isConnected).toBe(true);
  });

  it('exposes a notebook uuid derived from the device id', async () => {
    const device = new HuionNoteBLE(connectedFake());
    await device.connect();
    expect(device.notebookUuid).toBe('huion:fake-device-id');
  });

  it('reports disconnected when the transport drops', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    transport.dropConnection();

    expect(device.isConnected).toBe(false);
  });

  it('forwards the page-turn button event', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    let turns = 0;
    device.onNextPage = () => { turns += 1; };
    await device.connect();

    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

    expect(turns).toBe(1);
  });
});
```

If the driver's real handshake needs additional frames (`MAX_INFO`, `DEVICE_NAME`, `BATTERY`) before it resolves `connect()`, add responders for those to `connectedFake()` in `src/test/huionFixtures.ts` — read `handleNotification` to see exactly which replies it waits on. Do not change the driver to make the test easier.

- [ ] **Step 7: Verify**

```bash
npx vitest run src/utils/huionBLE.test.ts
npm test
npm run build
npm run lint
```
Expected: all pass; lint still exactly 53.

- [ ] **Step 8: HARDWARE SMOKE TEST — cannot be skipped or automated**

Report to the controller that this step is required and hand back the instructions below; a human must run it before Task 3 begins.

```
npm run dev
```
Open http://localhost:3000/probe.html, then: Connect → Snapshot ROM → Start streaming → write a few strokes and confirm they appear on the probe canvas → press the pad's page-turn button and confirm the log shows `PAGE TURN` → Stop streaming → Snapshot ROM.

All of that worked before this refactor. If any of it now fails, Task 2 introduced a regression — report it rather than proceeding.

- [ ] **Step 9: Commit**

```bash
git add src/utils/huionTransport.ts src/test/fakeHuionTransport.ts src/test/huionFixtures.ts src/utils/huionBLE.test.ts src/utils/huionBLE.ts
git commit -m "refactor(huion): put a transport seam between protocol and bluetooth"
```

---

### Task 3: `getStoredPageCount()`

The session page baseline. `CURRENT_PAGE (0x85)` is already sent and parsed, but only from inside `downloadPages()`.

**Files:**
- Modify: `src/utils/huionBLE.ts`
- Modify: `src/utils/huionBLE.test.ts`

**Interfaces:**
- Consumes: `FakeHuionTransport`, `CMD` from Task 2.
- Produces: `getStoredPageCount(): Promise<number>`

- [ ] **Step 1: Write the failing test**

Append to `src/utils/huionBLE.test.ts`:

```ts
describe('getStoredPageCount', () => {
  it('returns the page count the device reports', async () => {
    const transport = connectedFake();
    // 0x85 reply carries the count at bytes 3-4, little-endian.
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 7, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    expect(await device.getStoredPageCount()).toBe(7);
  });

  it('decodes a count above 255 from both bytes', async () => {
    const transport = connectedFake();
    // 300 = 0x012C -> low byte 0x2C, high byte 0x01
    transport.on(CMD.CURRENT_PAGE, () => [
      withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, 0x2c, 0x01, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    expect(await device.getStoredPageCount()).toBe(300);
  });

  it('rejects when not authenticated', async () => {
    const device = new HuionNoteBLE(new FakeHuionTransport());
    await expect(device.getStoredPageCount()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/utils/huionBLE.test.ts -t getStoredPageCount`
Expected: FAIL — `device.getStoredPageCount is not a function`.

- [ ] **Step 3: Implement**

Add to `HuionNoteBLE`. The `CURRENT_PAGE` branch of `handleNotification` currently assumes a download is in flight (it checks `this.pageResolve`); add a separate pending-resolver so a standalone query does not disturb download state:

```ts
private pageCountResolve: ((count: number) => void) | null = null;

/**
 * Standalone CURRENT_PAGE (0x85) query. Used as the session page baseline:
 * a session's pages are the ones from this index onward.
 */
async getStoredPageCount(): Promise<number> {
  if (!this.authenticated) throw new Error('Not authenticated');
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      this.pageCountResolve = null;
      reject(new Error('Page count query timed out'));
    }, 5000);
    this.pageCountResolve = (count) => {
      clearTimeout(timer);
      resolve(count);
    };
    this.write(makeFrame(CMD.CURRENT_PAGE)).catch(reject);
  });
}
```

In the `CMD.CURRENT_PAGE` branch of `handleNotification`, before the existing download logic:

```ts
if (this.pageCountResolve) {
  const resolvePageCount = this.pageCountResolve;
  this.pageCountResolve = null;
  resolvePageCount((data[4] << 8) | data[3]);
  break;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/utils/huionBLE.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/huionBLE.ts src/utils/huionBLE.test.ts
git commit -m "feat(huion): add standalone getStoredPageCount query"
```

---

### Task 4: `downloadPage(n)`

Per spec finding C2, bulk download is ~15 s per page and flaky. Because pages commit on page turn (C1), the session engine wants to pull each page as it commits rather than doing one long bulk read at the end.

**Files:**
- Modify: `src/utils/huionBLE.ts`
- Modify: `src/utils/huionBLE.test.ts`

**Interfaces:**
- Consumes: Task 2's fake transport.
- Produces: `downloadPage(pageNum: number): Promise<HuionPage>`

- [ ] **Step 1: Write the failing test**

Append to `src/utils/huionBLE.test.ts`:

```ts
describe('downloadPage', () => {
  it('requests the page it was asked for', async () => {
    const transport = connectedFake();
    transport.on(CMD.REQUEST_PAGE, () => [
      // Reply: zero packages -> an empty page, which the driver finishes immediately.
      withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    const page = await device.downloadPage(3);

    const request = transport.written.find((frame) => frame[1] === CMD.REQUEST_PAGE);
    expect(request![3]).toBe(3);
    expect(page.pageNum).toBe(3);
    expect(page.strokes).toEqual([]);
  });

  it('rejects when not authenticated', async () => {
    const device = new HuionNoteBLE(new FakeHuionTransport());
    await expect(device.downloadPage(0)).rejects.toThrow();
  });

  it('leaves bulk download state untouched', async () => {
    const transport = connectedFake();
    transport.on(CMD.REQUEST_PAGE, () => [
      withChecksum([0xcd, CMD.REQUEST_PAGE, 0x08, 0, 0, 0, 0]),
    ]);
    const device = new HuionNoteBLE(transport);
    await device.connect();

    await device.downloadPage(1);
    await device.downloadPage(2);

    // A second single-page pull must not inherit the first one's buffers.
    const requests = transport.written.filter((frame) => frame[1] === CMD.REQUEST_PAGE);
    expect(requests.map((frame) => frame[3])).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/utils/huionBLE.test.ts -t downloadPage`
Expected: FAIL — `device.downloadPage is not a function`.

- [ ] **Step 3: Implement**

Add a public `downloadPage(pageNum)` that reuses the existing `requestPageDownload` / package-assembly machinery but resolves with a single page. **Reset the per-page buffers (`pagePackages`, `packageRetries`, `expectedPackageCount`) at entry** so consecutive single-page pulls cannot contaminate each other — that is what the third test pins. Reuse `PAGE_DOWNLOAD_TIMEOUT_MS` for the timeout, and clear the retry timer on both success and failure paths exactly as `downloadPages()` does.

Do not change `downloadPages()`. The studio's `TabletPanel` still calls it and Phase 2 may still want a bulk path.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/utils/huionBLE.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/huionBLE.ts src/utils/huionBLE.test.ts
git commit -m "feat(huion): add single-page download"
```

---

### Task 5: `deletePage()` and `clearCache()`

`DELETE_PAGE (0x8B)` and `CLEAR_CACHE (0x8C)` are declared in the command map but have never been sent. **The wire format is therefore unverified** — these were read out of a decompiled APK, not observed on the wire.

**Files:**
- Modify: `src/utils/huionBLE.ts`
- Modify: `src/utils/huionBLE.test.ts`

**Interfaces:**
- Produces: `deletePage(pageNum: number): Promise<void>`, `clearCache(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `src/utils/huionBLE.test.ts`:

```ts
describe('destructive commands', () => {
  it('sends DELETE_PAGE with the page number', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    await device.deletePage(4);

    const frame = transport.written.find((sent) => sent[1] === CMD.DELETE_PAGE);
    expect(frame).toBeDefined();
    expect(frame![3]).toBe(4);
  });

  it('sends CLEAR_CACHE', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();

    await device.clearCache();

    expect(transport.written.some((sent) => sent[1] === CMD.CLEAR_CACHE)).toBe(true);
  });

  it('refuses to delete when not authenticated', async () => {
    const device = new HuionNoteBLE(new FakeHuionTransport());
    await expect(device.deletePage(0)).rejects.toThrow();
    await expect(device.clearCache()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/utils/huionBLE.test.ts -t "destructive commands"`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * Deletes one stored page from device memory. DESTRUCTIVE and irreversible.
 * Per spec D3 the caller must confirm with the user every time; this method
 * deliberately has no confirmation of its own so the prompt lives in the UI.
 *
 * The 0x8B wire format came from APK decompilation and has not been observed
 * on the wire - verify against hardware before relying on it.
 */
async deletePage(pageNum: number): Promise<void> {
  if (!this.authenticated) throw new Error('Not authenticated');
  this.log(`Deleting page ${pageNum} from device memory`);
  await this.write(makeFrame(CMD.DELETE_PAGE, pageNum & 0xff, (pageNum >> 8) & 0xff));
}

/** Clears ALL stored pages. DESTRUCTIVE and irreversible. See deletePage. */
async clearCache(): Promise<void> {
  if (!this.authenticated) throw new Error('Not authenticated');
  this.log('Clearing all stored pages from device memory');
  await this.write(makeFrame(CMD.CLEAR_CACHE));
}
```

**Wire nothing to any UI in this phase.** The confirmation dialog is task #18, in Phase 2.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/utils/huionBLE.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/huionBLE.ts src/utils/huionBLE.test.ts
git commit -m "feat(huion): implement DELETE_PAGE and CLEAR_CACHE"
```

---

### Task 6: Event fan-out

`HuionNoteBLE` exposes **single-slot** callbacks — `onPen`, `onLog`, `onStatus`, `onNextPage` are one function each. In Phase 2 both the live preview canvas and the session recorder need pen points. Without fan-out the second consumer silently replaces the first, with no error.

**Files:**
- Create: `src/device/emitter.ts`
- Create: `src/device/emitter.test.ts`

**Interfaces:**
- Produces: `createEmitter<T>(): Emitter<T>` with `subscribe(fn) => () => void` and `emit(value)`.

- [ ] **Step 1: Write the failing test**

Create `src/device/emitter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createEmitter } from '@/device/emitter';

describe('createEmitter', () => {
  it('delivers to every subscriber', () => {
    const emitter = createEmitter<number>();
    const first = vi.fn();
    const second = vi.fn();
    emitter.subscribe(first);
    emitter.subscribe(second);

    emitter.emit(42);

    expect(first).toHaveBeenCalledWith(42);
    expect(second).toHaveBeenCalledWith(42);
  });

  it('stops delivering after unsubscribe', () => {
    const emitter = createEmitter<number>();
    const listener = vi.fn();
    const unsubscribe = emitter.subscribe(listener);

    unsubscribe();
    emitter.emit(1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('is safe to unsubscribe twice', () => {
    const emitter = createEmitter<number>();
    const unsubscribe = emitter.subscribe(vi.fn());
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('keeps delivering to others when one subscriber throws', () => {
    const emitter = createEmitter<number>();
    const healthy = vi.fn();
    emitter.subscribe(() => { throw new Error('boom'); });
    emitter.subscribe(healthy);

    expect(() => emitter.emit(1)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(1);
  });

  it('is unaffected by a subscriber added during emit', () => {
    const emitter = createEmitter<number>();
    const late = vi.fn();
    emitter.subscribe(() => emitter.subscribe(late));

    emitter.emit(1);

    expect(late).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/device/emitter.test.ts`
Expected: FAIL — cannot resolve `@/device/emitter`.

- [ ] **Step 3: Implement**

Create `src/device/emitter.ts`:

```ts
export interface Emitter<T> {
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

/**
 * Minimal multi-subscriber fan-out. Exists because HuionNoteBLE's callbacks
 * are single-slot: a second consumer would silently replace the first.
 */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(value) {
      // Iterate a copy so a listener that subscribes or unsubscribes during
      // delivery cannot change who receives this event.
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          // One broken consumer must not stop the others - a thrown error in
          // the preview canvas cannot be allowed to halt session recording.
          console.error('[emitter] subscriber threw', error);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/device/emitter.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/device/emitter.ts src/device/emitter.test.ts
git commit -m "feat(device): add multi-subscriber event emitter"
```

---

### Task 7: Device controller and provider

The connection must survive screen navigation. Today that only works because `TabletPanel` is permanently mounted (`src/App.tsx:3784`) — a hack that will not survive the multi-screen shell in Phase 4. The driver belongs to a provider at app root.

The orchestration lives in a **plain module**, not in React, so it is testable without adding `@testing-library/react`. The provider is a thin wrapper.

**Files:**
- Create: `src/device/controller.ts`
- Create: `src/device/controller.test.ts`
- Create: `src/device/TabletProvider.tsx`

**Interfaces:**
- Consumes: `HuionNoteBLE` (Tasks 2–5), `createEmitter` (Task 6), `FakeHuionTransport` for tests.
- Produces:
  - `createDeviceController(makeDevice?: () => HuionNoteBLE): DeviceController`
  - `TabletProvider` component and `useHuionDevice()` hook

- [ ] **Step 1: Write the failing test**

Create `src/device/controller.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createDeviceController } from '@/device/controller';
import { connectedFake, withChecksum } from '@/test/huionFixtures';
import { HuionNoteBLE } from '@/utils/huionBLE';
import { CMD } from '@/utils/huionProtocol';

describe('device controller', () => {
  it('fans pen points out to every subscriber', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const preview = vi.fn();
    const recorder = vi.fn();
    controller.subscribePen(preview);
    controller.subscribePen(recorder);

    await controller.connect();
    controller.__emitPenForTest({ x: 0.5, y: 0.5, pressure: 1, status: 1, timestamp: 0 });

    expect(preview).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledTimes(1);
  });

  it('fans page turns out to every subscriber', async () => {
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const first = vi.fn();
    const second = vi.fn();
    controller.subscribePageTurn(first);
    controller.subscribePageTurn(second);

    await controller.connect();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

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
    const transport = connectedFake();
    const controller = createDeviceController(() => new HuionNoteBLE(transport));
    const listener = vi.fn();
    const unsubscribe = controller.subscribePageTurn(listener);
    await controller.connect();

    unsubscribe();
    transport.emit(withChecksum([0xcd, CMD.NEXT_PAGE, 0x06, 0, 0, 0]));

    expect(listener).not.toHaveBeenCalled();
  });
});
```

`__emitPenForTest` is a deliberate test seam — driving a live pen packet through the fake transport requires a valid 11-byte payload, and this task is about fan-out, not packet decoding (Task 1 covers that). Name it exactly as written so its purpose is obvious at every call site.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/device/controller.test.ts`
Expected: FAIL — cannot resolve `@/device/controller`.

- [ ] **Step 3: Implement the controller**

Create `src/device/controller.ts` exposing:

```ts
export interface DeviceState {
  isConnected: boolean;
  isStreaming: boolean;
  deviceName: string;
  status: string;
}

export interface DeviceController {
  getState(): DeviceState;
  subscribeState(fn: (state: DeviceState) => void): () => void;
  subscribePen(fn: (point: HuionPenPoint) => void): () => void;
  subscribePageTurn(fn: () => void): () => void;
  subscribeLog(fn: (line: string) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  startStreaming(): Promise<void>;
  stopStreaming(): Promise<void>;
  getStoredPageCount(): Promise<number>;
  downloadPage(pageNum: number): Promise<HuionPage>;
  /** Test seam - see controller.test.ts. */
  __emitPenForTest(point: HuionPenPoint): void;
}
```

The controller owns exactly one `HuionNoteBLE`, claims all four of its single-slot callbacks, and re-emits each through its own emitter. `makeDevice` defaults to `() => new HuionNoteBLE()` so production wiring needs no argument.

**Do not expose `deletePage`/`clearCache` on the controller in this phase.** They land with the confirmation dialog (task #18) in Phase 2, so nothing can reach them from UI code yet.

- [ ] **Step 4: Implement the provider**

Create `src/device/TabletProvider.tsx` — a React context holding one controller for the app's lifetime, plus a `useHuionDevice()` hook returning it along with the current `DeviceState` kept in React state via `subscribeState`. Keep it thin: no device logic here, it belongs in the controller.

Do not mount `TabletProvider` anywhere yet. Phase 4 builds the shell that uses it; mounting it now would mean two live drivers alongside the studio's `TabletPanel`.

- [ ] **Step 5: Run the full suite**

```bash
npm test
npm run build
npm run lint
```
Expected: all pass; lint still exactly 53.

- [ ] **Step 6: Commit**

```bash
git add src/device/controller.ts src/device/controller.test.ts src/device/TabletProvider.tsx
git commit -m "feat(device): add device controller with event fan-out and provider"
```

---

## Phase exit criteria

- [ ] `npm test` passes — Phase 1A's 51 tests plus this phase's.
- [ ] `npm run lint` introduces no new problems (baseline: 53 — 1 error, 52 warnings).
- [ ] `npm run build` succeeds and the studio app still works.
- [ ] `TabletPanel` still connects, streams, and downloads through the refactored driver.
- [ ] The driver can be fully exercised in tests without hardware.
- [ ] **Hardware smoke test passed** — see below. Cannot be satisfied headlessly.

## Hardware verification (human only)

Automated tests use a fake transport. Nothing in CI can prove the real radio still works, and Tasks 1 and 2 restructure the code that talks to it.

Run **after Task 2** and again **at the end of the phase**:

1. `npm run dev`, open http://localhost:3000/probe.html
2. Connect → the log should reach `[7/7] Handshake complete, connected!`
3. Snapshot ROM → completes and reports a page count
4. Start streaming → strokes appear on the probe canvas as you write
5. Press the pad's page-turn button → the log shows `*** PAGE TURN button pressed (0x8A) ***`
6. Stop streaming → Snapshot ROM → the page you just wrote appears (per finding C1, it commits on the page turn)

Then confirm the studio still works: open http://localhost:3000, connect via the Pad tab, and draw.

**Optionally**, while the probe is open, settle the spec's open question — does the pad write to memory while streaming? Run experiments B and C from the probe's own instructions. It does not block this phase, but it would remove an unknown from Phase 2's reconciliation design.

**Task 5's delete commands are deliberately untested against hardware here** — their wire format is unverified APK-derived guesswork, and testing them destroys pages. They are verified in Phase 2 alongside the confirmation dialog, on a pad the user is willing to clear.
