import { createEmitter } from '@/device/emitter';
import { createLivenessWatchdog, type LivenessOptions } from '@/device/liveness';
import { createPageTurnDetector, type PageTurnOptions } from '@/device/pageTurnDetector';
import { createReconnectPolicy, type ReconnectOptions } from '@/device/reconnect';
import type { HuionPage, HuionPenPoint } from '@/utils/huionBLE';
import { HuionNoteBLE } from '@/utils/huionBLE';

export interface DeviceState {
  isConnected: boolean;
  isStreaming: boolean;
  isReconnecting: boolean;
  deviceName: string;
  status: string;
  storedPageCount: number;
  /** K26: null before the first reply and while disconnected - never a stale number shown as current (K27). */
  batteryPercent: number | null;
}

export interface DeviceControllerOptions {
  reconnect?: ReconnectOptions;
  liveness?: LivenessOptions;
  pageTurn?: PageTurnOptions;
  /** K27: how often to refresh the battery level while connected. Default 5 minutes. */
  batteryPollMs?: number;
  /** K31: dedupe window for a direct 0x8A page turn. Default 300ms. */
  pageTurnDedupeMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
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
  /** Begins page-turn polling, liveness checking and auto-reconnect. */
  startCapture(): Promise<void>;
  /** Ends all three. Does not disconnect. */
  stopCapture(): void;
  getStoredPageCount(): Promise<number>;
  downloadPage(pageNum: number): Promise<HuionPage>;
}

const initialState: DeviceState = {
  isConnected: false,
  isStreaming: false,
  isReconnecting: false,
  deviceName: '',
  status: 'Disconnected',
  storedPageCount: 0,
  batteryPercent: null,
};

/** K27 default: refresh the battery level every 5 minutes while connected. */
const DEFAULT_BATTERY_POLL_MS = 5 * 60_000;
/** K31 default: a 300ms dedupe window for a direct 0x8A page turn. */
const DEFAULT_PAGE_TURN_DEDUPE_MS = 300;

/**
 * Owns exactly one `HuionNoteBLE` instance and claims all four of its
 * single-slot callbacks (`onPen`, `onLog`, `onStatus`, `onNextPage`),
 * re-emitting each through a multi-subscriber emitter. Those callback slots
 * are single-assignment on the driver itself - anything that set them
 * directly (rather than subscribing here) would silently clobber whoever
 * else needed them.
 *
 * Deliberately does not expose `deletePage`/`clearCache`: they're
 * destructive, their wire format is unverified against hardware, and spec
 * decision D3 requires a confirmation dialog that lands in Phase 2.
 */
export function createDeviceController(
  makeDevice: () => HuionNoteBLE = () => new HuionNoteBLE(),
  opts: DeviceControllerOptions = {},
): DeviceController {
  const device = makeDevice();

  const stateEmitter = createEmitter<DeviceState>();
  const penEmitter = createEmitter<HuionPenPoint>();
  const pageTurnEmitter = createEmitter<void>();
  const logEmitter = createEmitter<string>();

  let state: DeviceState = { ...initialState };

  function setState(patch: Partial<DeviceState>) {
    state = { ...state, ...patch };
    stateEmitter.emit(state);
  }

  // True only between startCapture() and stopCapture(). Everything below that
  // reacts to a dropped link (handleDrop, via either the watchdog or a raw
  // 'Disconnected' status) is gated on it, so an app-initiated disconnect()
  // never triggers a reconnect chase - see endCapture()/disconnect() below.
  let capturing = false;

  const nowFn = opts.now ?? Date.now;
  const setIntervalFn = opts.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clearIntervalFn = opts.clearInterval ?? ((handle: unknown) => globalThis.clearInterval(handle as number));
  const batteryPollMs = opts.batteryPollMs ?? DEFAULT_BATTERY_POLL_MS;
  const pageTurnDedupeMs = opts.pageTurnDedupeMs ?? DEFAULT_PAGE_TURN_DEDUPE_MS;

  // K27: a poll must not outlive its connection. `stopBatteryPoll()` is
  // called everywhere the link stops being connected (explicit disconnect,
  // any detected drop), and `batteryPercent` is reset to null in the same
  // place - never left showing a stale number while disconnected.
  let batteryTimer: unknown = null;
  function stopBatteryPoll(): void {
    if (batteryTimer !== null) {
      clearIntervalFn(batteryTimer);
      batteryTimer = null;
    }
  }
  function requestBattery(): void {
    device.requestBattery().catch((err: unknown) => {
      logEmitter.emit(`Battery query failed: ${String(err)}`);
    });
  }
  function startBatteryPoll(): void {
    stopBatteryPoll();
    batteryTimer = setIntervalFn(requestBattery, batteryPollMs);
  }

  // K28/K31: a 0x8A notification is the page-turn trigger directly, guarded
  // by a dedupe window against one physical press producing a doubled
  // frame. Gated on `capturing` the same way `detector.hint()` was
  // implicitly gated before (a no-op unless `detector.start()` had run).
  let lastPageTurnAt = -Infinity;
  function emitPageTurn(): void {
    if (!capturing) return;
    const t = nowFn();
    if (t - lastPageTurnAt < pageTurnDedupeMs) return;
    lastPageTurnAt = t;
    pageTurnEmitter.emit();
  }

  // Shared by the detector's poll, the watchdog's ping and the public
  // getStoredPageCount() below: this composition gives `device.
  // getStoredPageCount()` three independent callers, but the driver itself
  // is single-flight (huionBLE.ts throws "one is already in progress" on a
  // second concurrent call). A caller that arrives while one is already
  // outstanding joins that same in-flight call instead of issuing its own,
  // so the driver's single-flight is never violated from here - without
  // this, a hint()-triggered poll landing on an occupied slot logs an error
  // to the user, and worse, a watchdog ping that loses the race sees that
  // same "already in progress" rejection and (liveness.ts's catch does not
  // discriminate error kind) treats it as proof the link is dead.
  let pendingPageCount: Promise<number> | null = null;
  function readStoredPageCount(): Promise<number> {
    if (!pendingPageCount) {
      pendingPageCount = device.getStoredPageCount().finally(() => {
        pendingPageCount = null;
      });
    }
    return pendingPageCount;
  }

  // Declared in dependency order - detector, then watchdog, then
  // reconnectPolicy - so nothing below ever refers to a `const` that hasn't
  // been initialized yet. `handleDrop` is the only thing referenced before
  // its own declaration (from watchdog's `onDead` and from `onStatus`
  // below), which is safe only because it is a hoisted `function`
  // declaration, not a `const`: those closures don't run until well after
  // this whole function body has finished executing.
  const detector = createPageTurnDetector(
    {
      getStoredPageCount: () => readStoredPageCount(),
      // K29: the poll keeps running as the liveness heartbeat and as the
      // source of storedPageCount (engine.devicePageNum() reads it) - but a
      // rising count no longer emits a page turn itself (K28 moves that to
      // the 0x8A notification directly).
      onPageTurn: (count) => {
        setState({ storedPageCount: count });
      },
      onError: (err) => logEmitter.emit(`Page count poll failed: ${String(err)}`),
    },
    opts.pageTurn,
  );

  const watchdog = createLivenessWatchdog(
    {
      ping: () => readStoredPageCount(),
      onDead: () => {
        if (!capturing) return;
        logEmitter.emit('Link is silent and unresponsive; treating as dropped');
        // Runs the driver's own disconnect bookkeeping (authenticated/
        // streaming flip to false) and fires 'Disconnected', which is what
        // actually triggers handleDrop() below - through the onStatus
        // wiring, not a second direct call here. Without this, a
        // watchdog-detected drop left the driver's authenticated/streaming
        // flags untouched, so a session could come back from reconnect
        // reporting isStreaming: true with no pen data arriving.
        //
        // Not awaited - onDead() is a synchronous callback - so attach a
        // catch: reportLinkDead() cannot reject today (it swallows its own
        // close() error, and handleDisconnect() is synchronous with every
        // consumer callback guarded), but the first `await` added inside
        // handleDisconnect() would turn this into an unhandled rejection.
        void device.reportLinkDead().catch((err: unknown) => {
          logEmitter.emit(`Reporting the link dead failed: ${String(err)}`);
        });
      },
    },
    opts.liveness,
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
        //
        // This hint() can still be dropped if the detector's own poll is
        // already in flight (pageTurnDetector.ts's readCount() is
        // single-flight). On a transport-level drop that's effectively
        // impossible: handleDisconnect() clears `authenticated`, so any
        // detector poll attempted during the outage fails on an immediate
        // throw rather than a real write, releasing the slot almost
        // instantly - long before reconnect's own handshake (which includes
        // a real 100ms sleep) can complete. On the watchdog path, though,
        // nothing clears `authenticated` until the watchdog's own ping
        // times out, so a detector poll that started earlier in that same
        // window is issuing a real write and can still be genuinely waiting
        // out the full PAGE_COUNT_TIMEOUT_MS (5s) when reconnect succeeds -
        // this hint() would then be silently dropped. That is a latency
        // loss only, not a correctness one: `known` is untouched, so the
        // next scheduled poll still finds the turn.
        detector.hint();
        // K27: the poll was stopped on the drop (onStatus's 'Disconnected'
        // handling below); a successful reconnect resumes it.
        startBatteryPoll();
      },
      onGiveUp: () => setState({ isReconnecting: false }),
    },
    opts.reconnect,
  );

  // Hoisted function declaration (see the comment above `detector`): safe to
  // reference from callbacks constructed before this line.
  function handleDrop() {
    if (!capturing) return;
    // Deliberately does not call detector.stop(): stopping and restarting
    // would re-anchor the baseline to whatever the count reads at the next
    // start() (see pageTurnDetector.ts's `start()`), silently swallowing
    // exactly the page turns this whole feature exists to recover - the
    // ones that happened while the link was down. Leaving it running is
    // safe: every poll attempt during the gap fails harmlessly (caught by
    // readStoredPageCount()'s rejection, reported via onError above) until
    // the link is back, at which point either the next interval tick or
    // reconnectPolicy's onSuccess hint() picks up the true count.
    watchdog.stop();
    setState({ isReconnecting: true, isConnected: false });
    reconnectPolicy.start();
  }

  // Shared by stopCapture() and disconnect(), so an app-initiated disconnect
  // flips `capturing` off *before* device.disconnect() fires its own
  // onStatus('Disconnected'), which is what keeps that path from being
  // mistaken for an unexpected drop and chased by the reconnect policy.
  function endCapture() {
    capturing = false;
    detector.stop();
    watchdog.stop();
    reconnectPolicy.stop();
    setState({ isReconnecting: false });
  }

  device.onPen = (point) => penEmitter.emit(point);
  // K28: the pad does not commit pages to ROM while streaming, so the count
  // never rises during a live session - demoting this to a detector hint
  // (as it used to be) made every physical press invisible in practice. The
  // owner's probe confirmed the notification itself is reliable enough to
  // act on directly (K30 accepts its ~20% miss rate rather than
  // compensating for it: a missed press costs one app page boundary and is
  // recovered by pressing again).
  device.onNextPage = () => emitPageTurn();
  device.onFrame = () => watchdog.noteFrame();
  device.onBattery = (percent) => setState({ batteryPercent: percent });
  device.onLog = (line) => logEmitter.emit(line);
  device.onStatus = (status) => {
    setState({
      status,
      isConnected: device.isConnected,
      isStreaming: device.isStreaming,
      deviceName: device.deviceName,
    });
    if (status === 'Disconnected') {
      // K27: the poll must not outlive its connection, and a stale number
      // must never be shown as current - both happen synchronously with the
      // drop, not on whatever the next poll tick happens to be. Covers an
      // explicit disconnect() and every detected drop (transport-level and
      // watchdog-detected alike), since both funnel through this same
      // status transition.
      stopBatteryPoll();
      setState({ batteryPercent: null });
      handleDrop();
    }
  };

  return {
    getState() {
      return state;
    },
    subscribeState(fn) {
      return stateEmitter.subscribe(fn);
    },
    subscribePen(fn) {
      return penEmitter.subscribe(fn);
    },
    subscribePageTurn(fn) {
      return pageTurnEmitter.subscribe(fn);
    },
    subscribeLog(fn) {
      return logEmitter.subscribe(fn);
    },
    async connect() {
      // device.connect() itself calls onStatus('Authenticated') and then
      // onStatus('Connected') during the handshake - both with isConnected
      // already true - strictly before its promise resolves (VERIFY_RESPONSE
      // sets `authenticated = true` and calls setStatus, then MAX_INFO calls
      // setStatus('Connected') and only then resolves connectResolve()). The
      // shared onStatus handler above already picks both up, so no separate
      // setState is needed here, matching disconnect/startStreaming/stopStreaming.
      await device.connect();
      // K27: requested on connect (the driver's own handshake already
      // queries it once after MAX_INFO); this starts the periodic refresh.
      startBatteryPoll();
    },
    async disconnect() {
      // endCapture() first: device.disconnect() below fires onStatus
      // ('Disconnected') itself, and that handler calls handleDrop() - which
      // is a no-op once `capturing` is false. Without this ordering, an
      // app-initiated disconnect would look identical to an unexpected drop
      // and get chased by the reconnect policy.
      endCapture();
      // device.disconnect() flips its internal flags and calls onStatus
      // ('Disconnected') itself before returning, which already routes
      // through the onStatus handler above - no separate setState needed.
      await device.disconnect();
    },
    async startStreaming() {
      // Same as disconnect(): device.startStreaming() sets its streaming
      // flag and calls onStatus('Live streaming') before returning.
      await device.startStreaming();
    },
    async stopStreaming() {
      await device.stopStreaming();
    },
    async startCapture() {
      capturing = true;
      watchdog.start();
      await detector.start();
      setState({ storedPageCount: detector.pageCount });
    },
    stopCapture() {
      endCapture();
    },
    getStoredPageCount() {
      return readStoredPageCount();
    },
    downloadPage(pageNum) {
      return device.downloadPage(pageNum);
    },
  };
}
