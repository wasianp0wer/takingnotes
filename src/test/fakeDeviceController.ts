import type { DeviceController, DeviceState } from '@/device/controller';
import { createEmitter } from '@/device/emitter';
import type { HuionPage, HuionPenPoint } from '@/utils/huionBLE';

/** What `emitPen` fills in for you. Only `x` and `y` are ever interesting. */
export interface FakePenPoint {
  x: number;
  y: number;
  /** 0 = pen up, 1-7 = down. Defaults to 1 (down). */
  status?: number;
  pressure?: number;
  timestamp?: number;
}

export interface FakeDeviceController extends DeviceController {
  /** Names of the `DeviceController` methods called on this fake, in order. */
  readonly calls: string[];
  /** True between `startCapture()` and `stopCapture()`. */
  readonly isCapturing: boolean;
  /** Delivers one pen point and returns exactly what subscribers received. */
  emitPen(point: FakePenPoint): HuionPenPoint;
  /**
   * Fires a page-turn event. Pass `storedPageCount` to also move the count,
   * as a real ROM-committed page would, but the count itself no longer
   * drives the turn (K28/K29): the two are independent here, matching the
   * real controller.
   */
  emitPageTurn(opts?: { storedPageCount?: number }): void;
  emitLog(line: string): void;
  /** Pushes an arbitrary state change, as a connect or a drop would. */
  setDeviceState(patch: Partial<DeviceState>): void;
  /** What `getStoredPageCount()` resolves with. */
  setStoredPageCount(count: number): void;
}

const idleState: DeviceState = {
  isConnected: false,
  isStreaming: false,
  isReconnecting: false,
  deviceName: '',
  status: 'Disconnected',
  storedPageCount: 0,
  batteryPercent: null,
};

/**
 * In-memory stand-in for the real `DeviceController`, so anything above the
 * device layer (the capture engine, `usePageTurnCapture`, the app shell) can be
 * tested without Bluetooth or the driver's frame timing.
 *
 * Deliberately synchronous: `emitPen`/`emitPageTurn` deliver before they
 * return, unlike `createDeviceController`, where a pen point arrives a few
 * microtasks after the transport frame. A consumer whose correctness depends on
 * that delay belongs in a test driven by `FakeHuionTransport` instead.
 */
export function createFakeDeviceController(
  initial: Partial<DeviceState> = {},
): FakeDeviceController {
  const stateEmitter = createEmitter<DeviceState>();
  const penEmitter = createEmitter<HuionPenPoint>();
  const pageTurnEmitter = createEmitter<void>();
  const logEmitter = createEmitter<string>();

  const calls: string[] = [];
  let state: DeviceState = { ...idleState, ...initial };
  let storedPageCount = state.storedPageCount;
  let capturing = false;

  // Replaces the whole object rather than mutating it: `useSyncExternalStore`
  // needs a new reference per change and a stable one in between.
  function setState(patch: Partial<DeviceState>) {
    state = { ...state, ...patch };
    stateEmitter.emit(state);
  }

  return {
    calls,
    get isCapturing() {
      return capturing;
    },

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
      calls.push('connect');
      setState({ isConnected: true, deviceName: 'Fake Huion Note', status: 'Connected' });
    },
    async disconnect() {
      calls.push('disconnect');
      capturing = false;
      setState({
        isConnected: false,
        isStreaming: false,
        isReconnecting: false,
        status: 'Disconnected',
      });
    },
    async startStreaming() {
      calls.push('startStreaming');
      setState({ isStreaming: true, status: 'Live streaming' });
    },
    async stopStreaming() {
      calls.push('stopStreaming');
      setState({ isStreaming: false, status: 'Connected' });
    },
    async startCapture() {
      calls.push('startCapture');
      capturing = true;
      setState({ storedPageCount });
    },
    stopCapture() {
      calls.push('stopCapture');
      capturing = false;
    },
    async getStoredPageCount() {
      calls.push('getStoredPageCount');
      return storedPageCount;
    },
    async downloadPage(pageNum): Promise<HuionPage> {
      calls.push('downloadPage');
      return { pageNum, strokes: [] };
    },

    emitPen(point) {
      const full: HuionPenPoint = {
        x: point.x,
        y: point.y,
        pressure: point.pressure ?? 0.5,
        status: point.status ?? 1,
        timestamp: point.timestamp ?? Date.now(),
      };
      penEmitter.emit(full);
      return full;
    },
    emitPageTurn(opts = {}) {
      if (opts.storedPageCount !== undefined) {
        storedPageCount = opts.storedPageCount;
        setState({ storedPageCount });
      }
      pageTurnEmitter.emit();
    },
    emitLog(line) {
      logEmitter.emit(line);
    },
    setDeviceState(patch) {
      if (patch.storedPageCount !== undefined) storedPageCount = patch.storedPageCount;
      setState(patch);
    },
    setStoredPageCount(count) {
      storedPageCount = count;
    },
  };
}
