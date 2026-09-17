# Phase 2A — Link Resilience and Page-Turn Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Huion link alive across drops, and detect every page turn even when the `0x8A` notification is lost.

**Architecture:** Three independent, injectable units in `src/device/`, each wrapping or observing the existing device layer rather than modifying the driver's protocol code. A paced transport decorator serializes all writes; a reconnect policy drives `transport.reopen()` with backoff; a page-turn detector polls the ROM page count and treats `0x8A` only as a hint to poll early. The `DeviceController` composes them.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`), Vitest, `FakeHuionTransport`.

**Spec:** `docs/superpowers/specs/2026-09-17-phase-2-session-engine-design.md` (§4, §5, §6) and `docs/superpowers/specs/2026-08-25-note-capture-app.md` (C6, C7, D9).

## Global Constraints

- **TypeScript config bans:** enums, parameter properties (`constructor(private x)`), namespaces (`erasableSyntaxOnly`). Type-only imports MUST use `import type` (`verbatimModuleSyntax`). No unused locals or parameters.
- **Every timing value is an injectable option with a default.** Tests must never wait on a real 5-second interval. Any unit with a timer takes `{ ... }` options.
- **No `Blob` in anything persisted** (D7). Not expected in this plan, but holds.
- **`npm run build` type-checks.** Green build is part of every task's definition of done.
- **Lint baseline is 53 problems (1 error, 52 warnings), all in studio files.** Do not add to it; do not "fix" the pre-existing error in `src/components/CanvasEngine.tsx:370`.
- **Existing test count entering this plan: 106 passing.** Never delete or weaken an existing test to make a new one pass.
- **Run from repo root:** `npx vitest run`, `npm run build`, `npx eslint .`

---

## Why pacing does not go in the driver

`huionBLE.ts`'s recovery loop already does `await this.write(...); await this.sleep(40)`. The paced transport added in Task 1 enforces a *minimum gap measured from the previous write's completion*, so a caller that is already slower than the floor is never delayed — the two do not compound, and the driver's `sleep(40)` stays exactly as it is.

**Critical consequence for Task 1:** the existing test `offline package recovery > paces re-requests instead of running overlapping recovery passes` measures write *pacing* as a proxy for *concurrency*. If that test's driver were given a paced transport, the queue would throttle overlapping passes to 40 ms and the test would pass even with the reentrancy bug reintroduced. That test MUST keep constructing `HuionNoteBLE` with a bare, unpaced `FakeHuionTransport`. Task 1 adds a comment saying so.

---

## File Structure

**Create:**
- `src/utils/pacedTransport.ts` — `createPacedTransport()`: FIFO serialized write queue with a minimum inter-write gap and reject-on-close. Lives in `utils/` beside `huionTransport.ts`, not in `device/`: it is a transport decorator, and `huionBLE.ts` (in `utils/`) imports it, so placing it in `device/` would make `utils/` depend on `device/` and invert the existing layering.
- `src/utils/pacedTransport.test.ts`
- `src/device/reconnect.ts` — `createReconnectPolicy()`: backoff loop calling a supplied reconnect function.
- `src/device/reconnect.test.ts`
- `src/device/liveness.ts` — `createLivenessWatchdog()`: fires when no inbound frame has arrived for too long.
- `src/device/liveness.test.ts`
- `src/device/pageTurnDetector.ts` — `createPageTurnDetector()`: page-count poll, authoritative; `0x8A` demoted to a hint.
- `src/device/pageTurnDetector.test.ts`

**Modify:**
- `src/utils/huionTransport.ts` — add `reopen()` to the interface; split `BleHuionTransport.open()` so the GATT half is reusable.
- `src/utils/huionBLE.ts` — add `reconnect()` and an `onFrame` hook.
- `src/test/fakeHuionTransport.ts` — implement `reopen()`.
- `src/device/controller.ts` — compose the four units; add reconnect/page-turn state.
- `src/probe/ProbeApp.tsx` — surface the new state for hardware verification.

---

### Task 1: Paced serialized write transport

**Files:**
- Create: `src/utils/pacedTransport.ts`
- Create: `src/utils/pacedTransport.test.ts`
- Modify: `src/utils/huionBLE.ts` (constructor default only)
- Modify: `src/utils/huionBLE.test.ts` (add an explanatory comment)

**Interfaces:**
- Consumes: `HuionTransport` from `@/utils/huionTransport`.
- Produces: `createPacedTransport(inner: HuionTransport, opts?: PacedTransportOptions): HuionTransport` where `PacedTransportOptions = { minGapMs?: number }` (default 40).

- [ ] **Step 1: Write the failing test**

Create `src/utils/pacedTransport.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/pacedTransport.test.ts`
Expected: FAIL — `Failed to resolve import "@/utils/pacedTransport"`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/pacedTransport.ts`:

```ts
import type { HuionTransport } from '@/utils/huionTransport';

export interface PacedTransportOptions {
  /** Minimum ms between the completion of one write and the start of the next. */
  minGapMs?: number;
}

interface QueueEntry {
  data: Uint8Array;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Serializes every write to the wrapped transport: one in flight at a time,
 * FIFO, with a floor on the gap between them.
 *
 * This exists because overlapping callers once drove ~90 writes/sec against a
 * design pace of 25/sec, overran the controller's buffer and killed the link
 * mid-transfer (fixed at the call site in 45b0f77). The guard there was
 * specific to one loop; this makes the whole class impossible no matter how
 * many timers and callers the device layer grows.
 *
 * The gap is measured from the PREVIOUS WRITE'S COMPLETION, so a caller that
 * already paces itself more slowly than the floor is never delayed - the
 * driver's own `sleep(40)` in the package-recovery loop and this queue do not
 * compound.
 */
export function createPacedTransport(
  inner: HuionTransport,
  opts: PacedTransportOptions = {},
): HuionTransport {
  const minGapMs = opts.minGapMs ?? 40;
  const queue: QueueEntry[] = [];
  let draining = false;
  let closed = false;
  let lastWriteEndedAt = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (closed) {
          entry.reject(new Error('Transport closed before write was sent'));
          continue;
        }
        const wait = minGapMs - (Date.now() - lastWriteEndedAt);
        if (wait > 0) await sleep(wait);
        // Re-check: close() can land while we were waiting out the gap.
        if (closed) {
          entry.reject(new Error('Transport closed before write was sent'));
          continue;
        }
        try {
          await inner.write(entry.data);
          entry.resolve();
        } catch (err) {
          // Reject only this write. Draining continues: one failed frame must
          // not strand every frame queued behind it.
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          lastWriteEndedAt = Date.now();
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    get deviceName() { return inner.deviceName; },
    get deviceId() { return inner.deviceId; },
    onNotify(handler) { inner.onNotify(handler); },
    onDisconnect(handler) { inner.onDisconnect(handler); },
    async open() {
      closed = false;
      await inner.open();
    },
    async reopen() {
      closed = false;
      await inner.reopen();
    },
    write(data) {
      if (closed) return Promise.reject(new Error('Transport closed'));
      return new Promise<void>((resolve, reject) => {
        queue.push({ data, resolve, reject });
        void drain();
      });
    },
    async close() {
      closed = true;
      // Anything still queued will be rejected by the drain loop; reject here
      // too in case no drain is running.
      while (queue.length > 0) {
        queue.shift()!.reject(new Error('Transport closed before write was sent'));
      }
      await inner.close();
    },
  };
}
```

**Note:** this references `inner.reopen()`, added to the interface in Task 2. Task 1 and Task 2 must land together, or Task 1's `reopen` passthrough will not type-check. Implement Task 2's Step 3 interface change first if you hit that.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/pacedTransport.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Use the paced transport by default in the driver**

In `src/utils/huionBLE.ts`, change the constructor default:

```ts
  constructor(transport?: HuionTransport) {
    this.transport = transport ?? createPacedTransport(new BleHuionTransport(
      (msg) => this.log(msg),
      (status) => this.setStatus(status),
    ));
  }
```

Add the import: `import { createPacedTransport } from '@/utils/pacedTransport';`

- [ ] **Step 6: Protect the reentrancy regression test**

In `src/utils/huionBLE.test.ts`, inside `describe('offline package recovery')`, add above `pendingRecovery`:

```ts
  // These tests deliberately use a BARE FakeHuionTransport, not a paced one.
  // They measure write pacing as a proxy for recovery-pass concurrency; a
  // paced transport would throttle overlapping passes to the floor and make
  // the test pass even with the reentrancy guard removed. Keep it unpaced.
```

- [ ] **Step 7: Run the full suite and build**

Run: `npx vitest run && npm run build && npx eslint .`
Expected: 111 tests pass, build succeeds, lint still at 53 problems.

- [ ] **Step 8: Commit**

```bash
git add src/utils/pacedTransport.ts src/utils/pacedTransport.test.ts src/utils/huionBLE.ts src/utils/huionBLE.test.ts
git commit -m "feat(device): serialize and pace all transport writes

Makes the write-storm class fixed pointwise in 45b0f77 structurally
impossible. Gap is measured from the previous write's completion, so
self-paced callers are never delayed and the driver's own sleep(40) does
not compound with it."
```

---

### Task 2: Transport reconnect without a user gesture

**Files:**
- Modify: `src/utils/huionTransport.ts`
- Modify: `src/test/fakeHuionTransport.ts`
- Create test: `src/utils/pacedTransport.test.ts` already covers passthrough; add fake coverage in `src/utils/huionBLE.test.ts`

**Interfaces:**
- Produces: `HuionTransport.reopen(): Promise<void>` — reconnects to the device selected by a previous `open()`, without `requestDevice()`. Rejects if `open()` was never called.

**Background the implementer needs:** Web Bluetooth requires a user gesture for `navigator.bluetooth.requestDevice()`, but **not** for `device.gatt.connect()` on a device the origin already has permission for. Automatic reconnect is therefore possible — but only if the `BluetoothDevice` object survives. `BleHuionTransport.close()` currently sets `this.device = null`, which destroys exactly that. It must keep the device handle while still tearing down the GATT objects.

- [ ] **Step 1: Write the failing test**

Append to `src/utils/huionBLE.test.ts`:

```ts
describe('transport reopen', () => {
  it('re-authenticates over a reopened transport', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    await device.connect();
    expect(device.isConnected).toBe(true);

    transport.dropConnection();
    expect(device.isConnected).toBe(false);

    await device.reconnect();
    expect(device.isConnected).toBe(true);
  });

  it('rejects reopen before any open', async () => {
    const transport = new FakeHuionTransport();
    await expect(transport.reopen()).rejects.toThrow(/never opened/i);
  });
});
```

Ensure `FakeHuionTransport` is imported in that file (it is, via `connectedFake`; add a direct import if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/huionBLE.test.ts -t "transport reopen"`
Expected: FAIL — `transport.reopen is not a function` and `device.reconnect is not a function`.

- [ ] **Step 3: Add `reopen()` to the interface**

In `src/utils/huionTransport.ts`, inside `interface HuionTransport`, after `open()`:

```ts
  /**
   * Reconnects to the device a previous `open()` selected, skipping device
   * selection. Web Bluetooth requires a user gesture for `requestDevice()`
   * but not for `gatt.connect()` on an already-permitted device, which is
   * what makes silent auto-reconnect possible. Rejects if never opened.
   */
  reopen(): Promise<void>;
```

- [ ] **Step 4: Split `BleHuionTransport.open()` and implement `reopen()`**

In `src/utils/huionTransport.ts`, restructure. Replace the body of `open()` from the `this.setStatus('Connecting GATT...')` line onward with a call to a new private `establish()`, and add `reopen()`:

```ts
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

    await this.sleep(500);
  }
```

Then change `close()` to keep the device handle:

```ts
  async close(): Promise<void> {
    this.device?.gatt?.disconnect();
    // `this.device` is deliberately NOT nulled: reopen() needs the handle, and
    // nulling it would force a user gesture for every reconnect. The GATT
    // objects below are per-connection and must go.
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
  }
```

**Note on the `gattserverdisconnected` listener:** it is registered once in `open()` against the device (not the server), so it survives `establish()` being called again and must not be re-registered in `establish()` — doing so would fire the disconnect handler N times per drop.

- [ ] **Step 5: Implement `reopen()` on the fake**

In `src/test/fakeHuionTransport.ts`, add a field and method:

```ts
  private everOpened = false;
```

In `open()`:

```ts
  async open(): Promise<void> {
    this.opened = true;
    this.everOpened = true;
  }

  async reopen(): Promise<void> {
    if (!this.everOpened) throw new Error('Transport was never opened; cannot reopen');
    this.opened = true;
  }
```

- [ ] **Step 6: Add `reconnect()` to the driver**

In `src/utils/huionBLE.ts`, after `connect()`:

```ts
  /**
   * Re-establishes the link after an unexpected drop and re-runs the
   * handshake. Unlike `connect()` this needs no user gesture, because the
   * transport reuses the already-permitted device.
   */
  async reconnect(): Promise<void> {
    await this.transport.reopen();
    await this.performHandshake();
  }
```

`connect()` already registers `onNotify`/`onDisconnect` handlers on the transport, and both the BLE and fake transports keep those handlers across `close()`/`reopen()`, so they must NOT be re-registered here.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/utils/huionBLE.test.ts -t "transport reopen"`
Expected: PASS (2 tests).

- [ ] **Step 8: Run the full suite and build**

Run: `npx vitest run && npm run build && npx eslint .`
Expected: 113 tests pass, build succeeds, lint at 53.

- [ ] **Step 9: Commit**

```bash
git add src/utils/huionTransport.ts src/utils/huionBLE.ts src/utils/huionBLE.test.ts src/test/fakeHuionTransport.ts
git commit -m "feat(device): reconnect without a user gesture

Splits BleHuionTransport.open() so the GATT half is reusable and stops
close() from nulling the BluetoothDevice handle, which reopen() needs.
requestDevice() needs a user gesture; gatt.connect() on an
already-permitted device does not."
```

---

### Task 3: Reconnect policy with backoff

**Files:**
- Create: `src/device/reconnect.ts`
- Create: `src/device/reconnect.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ReconnectPolicy {
    start(): void;            // begin attempting; idempotent while running
    stop(): void;             // cancel; no further attempts or callbacks
    readonly isReconnecting: boolean;
  }
  interface ReconnectDeps {
    reconnect: () => Promise<void>;
    onAttempt?: (attempt: number, delayMs: number) => void;
    onSuccess?: () => void;
    onGiveUp?: () => void;
  }
  interface ReconnectOptions {
    delaysMs?: number[];      // default [1000, 2000, 4000, 8000, 16000, 30000]
    maxAttempts?: number;     // default Infinity
  }
  createReconnectPolicy(deps: ReconnectDeps, opts?: ReconnectOptions): ReconnectPolicy
  ```

**Design note for the implementer:** the last entry of `delaysMs` repeats forever once exhausted. `maxAttempts` defaults to `Infinity` because the user's decision is that a session stays open as long as possible — a drop must never end a session by itself. `maxAttempts` exists only so tests can bound the loop.

- [ ] **Step 1: Write the failing test**

Create `src/device/reconnect.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/device/reconnect.test.ts`
Expected: FAIL — cannot resolve `@/device/reconnect`.

- [ ] **Step 3: Write the implementation**

Create `src/device/reconnect.ts`:

```ts
export interface ReconnectDeps {
  /** Attempts one reconnection. Rejecting means "not yet". */
  reconnect: () => Promise<void>;
  onAttempt?: (attempt: number, delayMs: number) => void;
  onSuccess?: () => void;
  onGiveUp?: () => void;
}

export interface ReconnectOptions {
  /** Backoff ladder; the final entry repeats indefinitely. */
  delaysMs?: number[];
  /** Bound on attempts. Defaults to Infinity - a drop must never end a session. */
  maxAttempts?: number;
}

export interface ReconnectPolicy {
  start(): void;
  stop(): void;
  readonly isReconnecting: boolean;
}

const DEFAULT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Drives `deps.reconnect()` on a backoff ladder until it succeeds.
 *
 * Defaults to retrying forever: the user's decision is that a session stays
 * open as long as possible, so a dropped link must never be what ends one.
 * `maxAttempts` exists so tests can bound the loop.
 */
export function createReconnectPolicy(
  deps: ReconnectDeps,
  opts: ReconnectOptions = {},
): ReconnectPolicy {
  const delays = opts.delaysMs?.length ? opts.delaysMs : DEFAULT_DELAYS;
  const maxAttempts = opts.maxAttempts ?? Infinity;

  let running = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wait = (ms: number) => new Promise<void>((resolve) => {
    timer = setTimeout(() => { timer = null; resolve(); }, ms);
  });

  async function loop() {
    let attempt = 0;
    while (!cancelled && attempt < maxAttempts) {
      const delayMs = delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      deps.onAttempt?.(attempt, delayMs);
      await wait(delayMs);
      if (cancelled) break;
      try {
        await deps.reconnect();
        if (cancelled) break;
        running = false;
        deps.onSuccess?.();
        return;
      } catch {
        // Still down. Fall through to the next rung of the ladder.
      }
    }
    running = false;
    if (!cancelled) deps.onGiveUp?.();
  }

  return {
    start() {
      // Guard against a second loop: a burst of disconnect events must not
      // multiply the attempt rate, which is the same failure shape as the
      // overlapping recovery passes fixed in 45b0f77.
      if (running) return;
      running = true;
      cancelled = false;
      void loop();
    },
    stop() {
      cancelled = true;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get isReconnecting() { return running; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/device/reconnect.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/device/reconnect.ts src/device/reconnect.test.ts
git commit -m "feat(device): reconnect policy with repeating backoff ladder

Retries indefinitely by default - a dropped link must never be what ends a
session. Guarded against concurrent loops so a burst of disconnect events
cannot multiply the attempt rate."
```

---

### Task 4: Liveness watchdog

**Files:**
- Create: `src/device/liveness.ts`
- Create: `src/device/liveness.test.ts`
- Modify: `src/utils/huionBLE.ts` (add `onFrame` hook)

**Interfaces:**
- Produces:
  ```ts
  interface LivenessWatchdog {
    start(): void;
    stop(): void;
    noteFrame(): void;      // call on every inbound frame
  }
  interface LivenessDeps {
    ping: () => Promise<unknown>;   // a cheap read; rejecting means dead
    onDead: () => void;
  }
  interface LivenessOptions {
    idleMs?: number;        // default 15000
    checkIntervalMs?: number; // default 5000
  }
  createLivenessWatchdog(deps: LivenessDeps, opts?: LivenessOptions): LivenessWatchdog
  ```
- On the driver: `onFrame: (() => void) | null` — fires for every inbound frame that reaches `handleNotification`.

**Why this is needed:** a GATT connection can report `connected` while nothing flows. The field log's drop showed the link dying while data was actively being exchanged, so "the OS says we're connected" is not evidence the link works.

- [ ] **Step 1: Write the failing test**

Create `src/device/liveness.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/device/liveness.test.ts`
Expected: FAIL — cannot resolve `@/device/liveness`.

- [ ] **Step 3: Write the implementation**

Create `src/device/liveness.ts`:

```ts
export interface LivenessDeps {
  /** A cheap read. Rejecting is taken as proof the link is dead. */
  ping: () => Promise<unknown>;
  onDead: () => void;
}

export interface LivenessOptions {
  /** Silence after which the link is suspect. */
  idleMs?: number;
  /** How often to evaluate that silence. */
  checkIntervalMs?: number;
}

export interface LivenessWatchdog {
  start(): void;
  stop(): void;
  /** Call for every inbound frame. */
  noteFrame(): void;
}

/**
 * Detects a link that is nominally connected but carrying nothing.
 *
 * `gatt.connected` is not evidence: the field drop that motivated this had its
 * last inbound frame 0s before the disconnect, i.e. the link died while
 * actively in use. Silence plus a failed cheap read is better evidence.
 */
export function createLivenessWatchdog(
  deps: LivenessDeps,
  opts: LivenessOptions = {},
): LivenessWatchdog {
  const idleMs = opts.idleMs ?? 15_000;
  const checkIntervalMs = opts.checkIntervalMs ?? 5_000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = Date.now();
  let pinging = false;

  async function check() {
    // One ping at a time: the check interval is shorter than a ping can take,
    // and piling pings onto a struggling link is how the write storm started.
    if (pinging) return;
    if (Date.now() - lastFrameAt < idleMs) return;
    pinging = true;
    try {
      await deps.ping();
      // A reply is itself proof of life even if no notification arrived.
      lastFrameAt = Date.now();
    } catch {
      deps.onDead();
    } finally {
      pinging = false;
    }
  }

  return {
    start() {
      if (timer) return;
      lastFrameAt = Date.now();
      timer = setInterval(() => { void check(); }, checkIntervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    noteFrame() {
      lastFrameAt = Date.now();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/device/liveness.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the `onFrame` hook to the driver**

In `src/utils/huionBLE.ts`, near the other callback slots (around line 145–150):

```ts
  /** Fires for every inbound frame. Used by the liveness watchdog. */
  onFrame: (() => void) | null = null;
```

In `handleNotification`, as the very first statement of the method body:

```ts
    try {
      this.onFrame?.();
    } catch (err) {
      this.log(`onFrame handler threw: ${err instanceof Error ? err.message : err}`);
    }
```

The try/catch matches the existing treatment of `onPen`/`onNextPage`: `handleNotification` has a blanket catch whose failure path settles in-flight downloads with partial data, so consumer throws must be contained here rather than allowed to reach it.

- [ ] **Step 6: Write the driver hook test**

Append to `src/utils/huionBLE.test.ts`. **First extend the existing import** —
that file imports `connectedFake, withChecksum` from `@/test/huionFixtures` but
not `LIVE_PEN_DOWN_PACKET`, which this test needs:

```ts
import { connectedFake, LIVE_PEN_DOWN_PACKET, withChecksum } from '@/test/huionFixtures';
```

```ts
describe('onFrame hook', () => {
  it('fires for inbound frames and survives a throwing handler', async () => {
    const transport = connectedFake();
    const device = new HuionNoteBLE(transport);
    let frames = 0;
    device.onFrame = () => { frames++; throw new Error('consumer blew up'); };
    await device.connect();

    const before = frames;
    transport.emit(LIVE_PEN_DOWN_PACKET);

    expect(frames).toBeGreaterThan(before);
    expect(device.isConnected).toBe(true); // the throw did not tear anything down
  });
});
```

- [ ] **Step 7: Run the full suite and build**

Run: `npx vitest run && npm run build && npx eslint .`
Expected: 124 tests pass, build succeeds, lint at 53.

- [ ] **Step 8: Commit**

```bash
git add src/device/liveness.ts src/device/liveness.test.ts src/utils/huionBLE.ts src/utils/huionBLE.test.ts
git commit -m "feat(device): liveness watchdog and driver onFrame hook

gatt.connected is not evidence the link works - the field drop had its last
inbound frame 0s before dying. Silence plus a failed cheap read is."
```

---

### Task 5: Page-turn detector

**Files:**
- Create: `src/device/pageTurnDetector.ts`
- Create: `src/device/pageTurnDetector.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PageTurnDetector {
    start(initialCount?: number): Promise<void>;
    stop(): void;
    hint(): void;                 // 0x8A arrived: poll now instead of waiting
    readonly pageCount: number;
  }
  interface PageTurnDeps {
    getStoredPageCount: () => Promise<number>;
    onPageTurn: (newCount: number, previousCount: number) => void;
    onError?: (err: unknown) => void;
  }
  interface PageTurnOptions { pollIntervalMs?: number }  // default 5000
  createPageTurnDetector(deps: PageTurnDeps, opts?: PageTurnOptions): PageTurnDetector
  ```

**Why polling is authoritative (do not "simplify" this to the notification):** finding C6 says a page commits to ROM exactly on page turn, so the ROM page count increments exactly on page turn — it is ground truth. The `0x8A` notification is not: the field log recorded `page turns: claimed 4 / detected 0`. Reading a 4-byte counter is unrelated to the bulk-transfer quality problems in C7; this is not "relying on device memory for data." A missed page turn merges two pages of writing in the live buffer with no way to repair it, because under D9 we do not re-download pages.

- [ ] **Step 1: Write the failing test**

Create `src/device/pageTurnDetector.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPageTurnDetector } from '@/device/pageTurnDetector';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createPageTurnDetector', () => {
  it('emits a page turn when the stored count rises, with no notification at all', async () => {
    let count = 3;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    expect(onPageTurn).not.toHaveBeenCalled(); // baseline, not a turn
    count = 4;
    await tick(60);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledWith(4, 3);
    expect(det.pageCount).toBe(4);
  });

  it('emits once per turn even when hint and poll both observe it', async () => {
    let count = 1;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    count = 2;
    det.hint();
    await tick(80);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledTimes(1);
  });

  it('reports a multi-page jump as one event carrying both counts', async () => {
    let count = 0;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    count = 3; // e.g. three turns while disconnected
    await tick(60);
    det.stop();

    expect(onPageTurn).toHaveBeenCalledWith(3, 0);
  });

  it('hint() polls sooner than the interval would', async () => {
    let count = 1;
    const getStoredPageCount = vi.fn(async () => count);
    const det = createPageTurnDetector(
      { getStoredPageCount, onPageTurn: () => {} },
      { pollIntervalMs: 10_000 },
    );

    await det.start();
    const afterStart = getStoredPageCount.mock.calls.length;
    det.hint();
    await tick(30);
    det.stop();

    expect(getStoredPageCount.mock.calls.length).toBeGreaterThan(afterStart);
  });

  it('never overlaps polls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const det = createPageTurnDetector(
      {
        getStoredPageCount: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick(40);
          inFlight--;
          return 1;
        },
        onPageTurn: () => {},
      },
      { pollIntervalMs: 5 },
    );

    await det.start();
    det.hint(); det.hint(); det.hint();
    await tick(200);
    det.stop();

    expect(maxInFlight).toBe(1);
  });

  it('survives a failing poll and keeps going', async () => {
    let count = 1;
    let fail = true;
    const onError = vi.fn();
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      {
        getStoredPageCount: async () => {
          if (fail) throw new Error('link down');
          return count;
        },
        onPageTurn,
        onError,
      },
      { pollIntervalMs: 10 },
    );

    await det.start().catch(() => {});
    await tick(40);
    fail = false;
    count = 5;
    await tick(60);
    det.stop();

    expect(onError).toHaveBeenCalled();
    expect(onPageTurn).toHaveBeenCalled(); // recovered
  });

  it('ignores a count that goes down (device cleared) without firing a turn', async () => {
    let count = 5;
    const onPageTurn = vi.fn();
    const det = createPageTurnDetector(
      { getStoredPageCount: async () => count, onPageTurn },
      { pollIntervalMs: 10 },
    );

    await det.start();
    count = 0;
    await tick(60);
    det.stop();

    expect(onPageTurn).not.toHaveBeenCalled();
    expect(det.pageCount).toBe(0); // baseline re-anchored
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/device/pageTurnDetector.test.ts`
Expected: FAIL — cannot resolve `@/device/pageTurnDetector`.

- [ ] **Step 3: Write the implementation**

Create `src/device/pageTurnDetector.ts`:

```ts
export interface PageTurnDeps {
  getStoredPageCount: () => Promise<number>;
  /** Fired when the count rises. A jump of more than one is still one event. */
  onPageTurn: (newCount: number, previousCount: number) => void;
  onError?: (err: unknown) => void;
}

export interface PageTurnOptions {
  pollIntervalMs?: number;
}

export interface PageTurnDetector {
  /** Anchors the baseline and begins polling. Does not fire a turn. */
  start(initialCount?: number): Promise<void>;
  stop(): void;
  /** A 0x8A arrived. Poll now rather than waiting out the interval. */
  hint(): void;
  readonly pageCount: number;
}

/**
 * Detects page turns from the ROM page count, treating the `0x8A`
 * notification only as a reason to look sooner.
 *
 * C6 makes the count ground truth: a page commits to ROM exactly on page
 * turn, so the count rises exactly on page turn. The notification is not
 * ground truth - a field run recorded four presses and zero detections.
 *
 * This is not "relying on device memory" in the sense D9 rejects: that is
 * about downloading stroke DATA, whose quality problems (C7) do not apply to
 * a 4-byte counter read.
 */
export function createPageTurnDetector(
  deps: PageTurnDeps,
  opts: PageTurnOptions = {},
): PageTurnDetector {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  let timer: ReturnType<typeof setInterval> | null = null;
  let known = 0;
  let polling = false;
  let running = false;

  async function poll() {
    // Single-flight. `getStoredPageCount` is itself single-flight on the
    // driver and throws on a second concurrent call, so overlapping polls
    // would produce spurious errors as well as extra traffic.
    if (polling || !running) return;
    polling = true;
    try {
      const count = await deps.getStoredPageCount();
      if (!running) return;
      if (count > known) {
        const previous = known;
        known = count;
        deps.onPageTurn(count, previous);
      } else if (count < known) {
        // The pad was cleared or renumbered. Re-anchor silently: this is not
        // a page turn, and treating it as one would invent pages.
        known = count;
      }
    } catch (err) {
      deps.onError?.(err);
    } finally {
      polling = false;
    }
  }

  return {
    async start(initialCount?: number) {
      if (running) return;
      running = true;
      if (initialCount !== undefined) {
        known = initialCount;
      } else {
        try {
          known = await deps.getStoredPageCount();
        } catch (err) {
          // Baseline unknown. Leave `known` at 0 and let the first successful
          // poll anchor it; firing a turn for that first reading would
          // invent one, so the first rise from 0 is reported only if the
          // device really does have pages appear later.
          deps.onError?.(err);
        }
      }
      timer = setInterval(() => { void poll(); }, pollIntervalMs);
    },
    stop() {
      running = false;
      if (timer) { clearInterval(timer); timer = null; }
    },
    hint() {
      void poll();
    },
    get pageCount() { return known; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/device/pageTurnDetector.test.ts`
Expected: PASS (7 tests).

**If the "failing poll" test fails:** check that `start()` anchors `known` to `0` when the initial read throws, and that the later successful poll returning 5 is therefore a rise.

- [ ] **Step 5: Commit**

```bash
git add src/device/pageTurnDetector.ts src/device/pageTurnDetector.test.ts
git commit -m "feat(device): poll-based page-turn detection

The ROM page count is ground truth per C6; the 0x8A notification is not (a
field run recorded 4 presses, 0 detections). Notification demoted to a hint
that triggers an early poll. A count that falls re-anchors silently rather
than inventing pages."
```

---

### Task 6: Compose into DeviceController

**Files:**
- Modify: `src/device/controller.ts`
- Modify: `src/device/controller.test.ts`

**Interfaces:**
- Consumes: `createReconnectPolicy`, `createLivenessWatchdog`, `createPageTurnDetector`.
- Produces, added to `DeviceState`:
  ```ts
  isReconnecting: boolean;
  storedPageCount: number;
  ```
  Added to `DeviceController`:
  ```ts
  startCapture(): Promise<void>;   // begin page-turn polling + liveness + auto-reconnect
  stopCapture(): void;             // end all three
  ```
  `createDeviceController` gains a second parameter:
  ```ts
  createDeviceController(
    makeDevice?: () => HuionNoteBLE,
    opts?: { reconnect?: ReconnectOptions; liveness?: LivenessOptions; pageTurn?: PageTurnOptions },
  ): DeviceController
  ```

**Behaviour required:**
- `subscribePageTurn` now delivers events from the **detector**, not from raw `onNextPage`. `device.onNextPage` is wired to `detector.hint()`.
- An unexpected disconnect while capture is active starts the reconnect policy; `disconnect()` called by the app does not.
- On successful reconnect, the detector re-polls immediately so page turns that happened while disconnected are found.

- [ ] **Step 1: Write the failing test**

Append to `src/device/controller.test.ts`. **Note:** that file has no mock-object
helper — every test drives a real `HuionNoteBLE` through `connectedFake()`.
Follow that pattern; do not introduce a hand-rolled device stub.

```ts
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** connectedFake() plus a settable stored-page count on the 0x85 reply. */
function pageCountFake(read: () => number) {
  const transport = connectedFake();
  transport.on(CMD.CURRENT_PAGE, () => [
    withChecksum([0xcd, CMD.CURRENT_PAGE, 0x08, read() & 0xff, (read() >> 8) & 0xff, 0, 0]),
  ]);
  return transport;
}

describe('capture lifecycle', () => {
  it('emits page turns from the count poll with no 0x8A involved', async () => {
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

    expect(turns).toHaveLength(1);
    expect(controller.getState().storedPageCount).toBe(2);
  });

  it('re-polls on reconnect so turns during the gap are found', async () => {
    let count = 0;
    const transport = pageCountFake(() => count);
    const controller = createDeviceController(
      () => new HuionNoteBLE(transport),
      // Poll interval far longer than the test: only the reconnect re-poll
      // can possibly find this turn, which is the point being proven.
      { pageTurn: { pollIntervalMs: 60_000 }, reconnect: { delaysMs: [10] } },
    );
    const turns: number[] = [];
    controller.subscribePageTurn(() => turns.push(1));

    await controller.connect();
    await controller.startCapture();
    transport.dropConnection();
    count = 3; // three page turns while the link was down
    await tick(400);
    controller.stopCapture();

    expect(turns).toHaveLength(1);
    expect(controller.getState().storedPageCount).toBe(3);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/device/controller.test.ts -t "capture lifecycle"`
Expected: FAIL — `controller.startCapture is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/device/controller.ts`:

Add imports:

```ts
import { createLivenessWatchdog, type LivenessOptions } from '@/device/liveness';
import { createPageTurnDetector, type PageTurnOptions } from '@/device/pageTurnDetector';
import { createReconnectPolicy, type ReconnectOptions } from '@/device/reconnect';
```

Extend `DeviceState`:

```ts
export interface DeviceState {
  isConnected: boolean;
  isStreaming: boolean;
  isReconnecting: boolean;
  deviceName: string;
  status: string;
  storedPageCount: number;
}
```

and `initialState`:

```ts
const initialState: DeviceState = {
  isConnected: false,
  isStreaming: false,
  isReconnecting: false,
  deviceName: '',
  status: 'Disconnected',
  storedPageCount: 0,
};
```

Extend the interface:

```ts
export interface DeviceControllerOptions {
  reconnect?: ReconnectOptions;
  liveness?: LivenessOptions;
  pageTurn?: PageTurnOptions;
}
```

Add to `DeviceController`:

```ts
  /** Begins page-turn polling, liveness checking and auto-reconnect. */
  startCapture(): Promise<void>;
  /** Ends all three. Does not disconnect. */
  stopCapture(): void;
```

Inside `createDeviceController`, after the emitters:

```ts
  // True only between startCapture() and stopCapture(). Everything that
  // reacts to a dropped link is gated on it, so an app-initiated
  // disconnect() never triggers a reconnect chase.
  let capturing = false;

  const detector = createPageTurnDetector(
    {
      getStoredPageCount: () => device.getStoredPageCount(),
      onPageTurn: (count) => {
        setState({ storedPageCount: count });
        pageTurnEmitter.emit();
      },
      onError: (err) => logEmitter.emit(`Page count poll failed: ${String(err)}`),
    },
    opts.pageTurn,
  );

  const reconnectPolicy = createReconnectPolicy(
    {
      reconnect: () => device.reconnect(),
      onAttempt: (attempt, delayMs) =>
        logEmitter.emit(`Reconnect attempt ${attempt} in ${delayMs}ms`),
      onSuccess: () => {
        setState({ isReconnecting: false });
        logEmitter.emit('Reconnected');
        watchdog.start();
        // Re-poll at once: page turns that happened while the link was down
        // are recoverable only because detection is count-based, not
        // event-based. An event-based design would have lost them.
        detector.hint();
      },
      onGiveUp: () => setState({ isReconnecting: false }),
    },
    opts.reconnect,
  );

  const watchdog = createLivenessWatchdog(
    {
      ping: () => device.getStoredPageCount(),
      onDead: () => {
        logEmitter.emit('Link is silent and unresponsive; treating as dropped');
        handleDrop();
      },
    },
    opts.liveness,
  );

  function handleDrop() {
    if (!capturing) return;
    watchdog.stop();
    setState({ isReconnecting: true, isConnected: false });
    reconnectPolicy.start();
  }
```

**Ordering note:** `reconnectPolicy`'s `onSuccess` references `watchdog`, which is declared after it. Because both are `const` and `onSuccess` only runs later, this is a TDZ hazard only if `onSuccess` could fire during construction — it cannot. If the implementer prefers, declare `watchdog` first; `watchdog.onDead` references `handleDrop`, which is a hoisted function declaration, so that order also works.

Wire the driver callbacks (replacing the existing `onNextPage` line):

```ts
  device.onPen = (point) => penEmitter.emit(point);
  // Demoted to a hint (design §5.2): the notification is unreliable, so it
  // only makes the detector look sooner. The detector decides what a page
  // turn is.
  device.onNextPage = () => detector.hint();
  device.onFrame = () => watchdog.noteFrame();
  device.onLog = (line) => logEmitter.emit(line);
  device.onStatus = (status) => {
    setState({
      status,
      isConnected: device.isConnected,
      isStreaming: device.isStreaming,
      deviceName: device.deviceName,
    });
    if (status === 'Disconnected') handleDrop();
  };
```

Add the two methods to the returned object:

```ts
    async startCapture() {
      capturing = true;
      watchdog.start();
      await detector.start();
      setState({ storedPageCount: detector.pageCount });
    },
    stopCapture() {
      endCapture();
    },
```

and change the signature:

```ts
export function createDeviceController(
  makeDevice: () => HuionNoteBLE = () => new HuionNoteBLE(),
  opts: DeviceControllerOptions = {},
): DeviceController {
```

Also make `disconnect()` stop capture first, so an intentional disconnect is never chased:

```ts
    async disconnect() {
      endCapture();
      await device.disconnect();
    },
```

where `endCapture` is a local function holding the teardown, so both the
returned `stopCapture()` and `disconnect()` call the same code. Define it above
the return:

```ts
  function endCapture() {
    capturing = false;
    detector.stop();
    watchdog.stop();
    reconnectPolicy.stop();
    setState({ isReconnecting: false });
  }
```

and have the returned `stopCapture()` call `endCapture()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/device/controller.test.ts`
Expected: PASS, including the 3 new tests.

- [ ] **Step 5: Run the full suite and build**

Run: `npx vitest run && npm run build && npx eslint .`
Expected: all tests pass, build succeeds, lint at 53.

- [ ] **Step 6: Commit**

```bash
git add src/device/controller.ts src/device/controller.test.ts
git commit -m "feat(device): compose reconnect, liveness and page-turn detection

subscribePageTurn now delivers detector events rather than raw 0x8A, and a
successful reconnect re-polls immediately so turns that happened during the
gap are still found - which only works because detection is count-based."
```

---

### Task 7: Surface it in the probe for hardware verification

**Files:**
- Modify: `src/probe/ProbeApp.tsx`

**Why:** every previous phase shipped device changes that could not be exercised against hardware from the probe, and Phase 1B needed a follow-up commit to fix exactly that. This plan's whole purpose is behaviour under real radio conditions, so the probe must be able to drive it before the branch merges.

- [ ] **Step 1: Add capture controls and state readout**

In `src/probe/ProbeApp.tsx`:

1. Add two buttons next to the existing streaming controls, following the existing `S.btn(...)` pattern: **Start capture** (calls `controller.startCapture()`) and **Stop capture** (calls `controller.stopCapture()`).
2. Add three `<Stat>` entries beside the existing `uptime` / `last frame` / `drops`: `reconnecting` (from `state.isReconnecting`), `stored pages` (from `state.storedPageCount`), and `detected turns` (a local counter incremented in the existing `subscribePageTurn` handler).
3. Keep the existing `claimed` / `I PRESSED` control unchanged — the claimed-vs-detected comparison is the measurement this plan exists to fix.

- [ ] **Step 2: Add markers for the new events**

Extend the existing `addMarker` calls so the exported timeline distinguishes them:

- On reconnect attempt: `addMarker('~~~ RECONNECT attempt N in Xms')`
- On reconnect success: `addMarker('+++ RECONNECTED after Xs down')`
- On a detector page turn: `addMarker('>>> PAGE TURN DETECTED (count A -> B)')`

The existing `>>> PAGE TURN DISPATCHED to app` marker should stay and now reflects the detector, so a log where `I PRESSED` appears without a following `PAGE TURN DETECTED` is unambiguous evidence the count never moved.

- [ ] **Step 3: Verify the probe builds and renders**

Run: `npm run build`
Expected: succeeds.

Run: `npm run dev`, open `http://localhost:5173/probe.html`, confirm the new buttons and stats render with no device connected (they should be disabled/zero, not crash).

- [ ] **Step 4: Commit**

```bash
git add src/probe/ProbeApp.tsx
git commit -m "feat(probe): expose capture lifecycle, reconnect and detected page turns

Makes this plan's behaviour drivable against real hardware, and makes
'I PRESSED with no PAGE TURN DETECTED' unambiguous in the exported timeline."
```

---

## Hardware verification (before merge)

Automated tests cannot prove any of this against a real radio. Run on the Note X10, with the pad paired and the tab focused:

1. **Page turn** — Start capture, write, press the physical button 5×, each preceded by the on-screen "I pressed". Every press must produce a `PAGE TURN DETECTED` marker. Record how many also produced a `0x8A PAGE-TURN FRAME ARRIVED` — that ratio is what decides whether the poll interval can be lengthened.
2. **Reconnect** — Start capture, then walk out of range (or switch the pad off) for ~30 s and return. Expect `RECONNECT attempt` markers, then `RECONNECTED`, with no Chrome pairing prompt. The session must not end.
3. **Turn during a gap** — Start capture, switch the pad off, turn the page physically, switch it on. On reconnect the count must catch up and a `PAGE TURN DETECTED` must fire. This is the behaviour that an event-based design could not provide.
4. **Sustained run** — Capture for 15+ minutes of intermittent writing. Expect zero unexplained drops. Compare against the pre-fix baseline in `logs/huion-probe-2026-09-14T23-40-37.txt`.

Export the log after each and save to `./logs/`.

---

## Self-review notes

**Spec coverage.** §4 write pacing → Task 1 (priority tiering deliberately omitted: under D9 the automatic path carries almost no traffic, so queue depth stays near zero — YAGNI, and re-addable without changing the interface). §5 page-turn detection → Tasks 5, 6. §6.1 reconnect → Tasks 2, 3, 6. §6.2 liveness → Task 4. §6.3 tab throttling → **deferred to Plan 2B**, because the visibility warning belongs with gap accounting (§9) and has no device-layer component. §7–§11 → Plan 2B.

**Deliberately out of scope for 2A:** session state machine, durable live buffer, gap accounting, rendering, manual ROM recovery, clear-device dialog.
