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
}

export interface DeviceControllerOptions {
  reconnect?: ReconnectOptions;
  liveness?: LivenessOptions;
  pageTurn?: PageTurnOptions;
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
};

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

  // Declared in dependency order - detector, then watchdog, then
  // reconnectPolicy - so nothing below ever refers to a `const` that hasn't
  // been initialized yet. `handleDrop` is the only thing referenced before
  // its own declaration (from watchdog's `onDead` and from `onStatus`
  // below), which is safe only because it is a hoisted `function`
  // declaration, not a `const`: those closures don't run until well after
  // this whole function body has finished executing.
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

  // Hoisted function declaration (see the comment above `detector`): safe to
  // reference from callbacks constructed before this line.
  function handleDrop() {
    if (!capturing) return;
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
  // Demoted to a hint: the notification is unreliable (a field capture
  // logged four presses and zero detections), so it only makes the detector
  // look sooner. The detector - backed by the ROM page count - decides what
  // a page turn actually is.
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
      return device.getStoredPageCount();
    },
    downloadPage(pageNum) {
      return device.downloadPage(pageNum);
    },
  };
}
