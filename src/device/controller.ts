import { createEmitter } from '@/device/emitter';
import type { HuionPage, HuionPenPoint } from '@/utils/huionBLE';
import { HuionNoteBLE } from '@/utils/huionBLE';

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
}

const initialState: DeviceState = {
  isConnected: false,
  isStreaming: false,
  deviceName: '',
  status: 'Disconnected',
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

  device.onPen = (point) => penEmitter.emit(point);
  device.onNextPage = () => pageTurnEmitter.emit();
  device.onLog = (line) => logEmitter.emit(line);
  device.onStatus = (status) => {
    setState({
      status,
      isConnected: device.isConnected,
      isStreaming: device.isStreaming,
      deviceName: device.deviceName,
    });
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
    getStoredPageCount() {
      return device.getStoredPageCount();
    },
    downloadPage(pageNum) {
      return device.downloadPage(pageNum);
    },
  };
}
