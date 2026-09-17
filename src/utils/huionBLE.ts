import type { TabletBackendCapabilities } from '@/types/memory';
import {
  clamp,
  CMD,
  computeAuthResponse,
  HUION_DEFAULT_PAGE_HEIGHT_A4,
  HUION_DEFAULT_PAGE_HEIGHT_A5,
  HUION_DEFAULT_PAGE_WIDTH_A4,
  HUION_DEFAULT_PAGE_WIDTH_A5,
  makeFrame,
  verifyChecksum,
} from '@/utils/huionProtocol';
import { BleHuionTransport, type HuionTransport } from '@/utils/huionTransport';
import { createPacedTransport } from '@/utils/pacedTransport';

export interface HuionPenPoint {
  x: number;
  y: number;
  pressure: number;
  status: number; // 0=up, 1-7=down
  timestamp: number;
}

export interface HuionPage {
  pageNum: number;
  strokes: { points: HuionPenPoint[] }[];
}

export interface HuionDeviceConfig {
  maxX: number;
  maxY: number;
  maxPressure: number;
  pageWidth: number;
  pageHeight: number;
  /** True if A4-size device — requires axis swap + Y flip (from APK BluetoothLeService) */
  isA4: boolean;
  /** Battery percentage 0-100, or -1 if unknown */
  battery: number;
  /** Device model name from 0x91 query */
  modelName: string;
}

type PenCallback = (point: HuionPenPoint) => void;
type LogCallback = (msg: string) => void;
type StatusCallback = (status: string) => void;
type PageCallback = (pages: HuionPage[]) => void;

/** Max times to re-request a single package before giving up */
const MAX_PACKAGE_RETRIES = 3;
/** Download timeout per page (ms) */
const PAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
/** Huion app waits about 1s for the page stream to go idle before gap recovery */
const PACKAGE_RETRY_IDLE_MS = 1_000;
/** Timeout for a standalone CURRENT_PAGE (0x85) page-count query (ms) */
const PAGE_COUNT_TIMEOUT_MS = 5_000;
/** Handshake completion timeout (ms) */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** APK-derived offline pressure threshold (percent) */
const FILTER_PRESS_PERCENT = 7;
/** APK PointFilter distance threshold in logical page units */
const OFFLINE_POINT_FILTER_DISTANCE = 2.5;
/** APK pressure smoothing floor between accepted offline points */
const OFFLINE_PRESSURE_FALLOFF_LIMIT = 15;
/** PenPath.dealWithPress() lower clamp when nibProgress=100, pressProgress=50 */
const OFFLINE_MIN_PRESSURE_PERCENT = 5;

interface DecodedOfflinePoint {
  pageX: number;
  pageY: number;
  normalizedX: number;
  normalizedY: number;
  pressurePercent: number;
  status: number;
}

export class HuionNoteBLE implements TabletBackendCapabilities {
  private transport: HuionTransport;

  constructor(transport?: HuionTransport) {
    this.transport = transport ?? createPacedTransport(new BleHuionTransport(
      (msg) => this.log(msg),
      (status) => this.setStatus(status),
    ));
  }

  private challenge: [number, number, number] | null = null;
  private authenticated = false;
  private streaming = false;

  config: HuionDeviceConfig = {
    maxX: 32767, maxY: 32767, maxPressure: 8191,
    pageWidth: HUION_DEFAULT_PAGE_WIDTH_A5, pageHeight: HUION_DEFAULT_PAGE_HEIGHT_A5,
    isA4: false,
    battery: -1,
    modelName: '',
  };

  // Page download state
  private pagePackages: Map<number, Uint8Array[]> = new Map();
  private packageRetries: Map<number, number> = new Map(); // pkgNum → retry count
  private expectedPackageCount = 0;
  private currentDownloadPage = 0;
  private pageResolve: ((pages: HuionPage[]) => void) | null = null;
  private singlePageResolve: ((page: HuionPage) => void) | null = null;
  private pageCountResolve: ((count: number) => void) | null = null;
  private pageCountReject: ((err: Error) => void) | null = null;
  private pageCountTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Explicit mutual-exclusion state for the two download paths. Neither
   * `downloadPage()` nor `downloadPages()` may start while the other (or
   * another instance of itself) is in flight - both check this at entry and
   * reset it to 'idle' on every one of their exit paths. The ROM_INFO and
   * CURRENT_PAGE handlers also gate their bulk-orchestration branches on
   * this being exactly 'bulk', so a single-page pull cannot be hijacked by
   * an unsolicited ROM_INFO/CURRENT_PAGE frame (the device is known to send
   * unsolicited frames - see the CMD.NEXT_PAGE case below).
   */
  private downloadMode: 'idle' | 'single' | 'bulk' = 'idle';
  private downloadedPages: HuionPage[] = [];
  private totalPages = 0;
  private romUsed = 0;
  private romTotal = 0;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private pageRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a recovery pass is walking the missing-package list. The pass
   *  is a long `write; sleep(40)` loop - over a thousand packages it runs for
   *  ~45s - and it is (re)scheduled on EVERY inbound package, so without this
   *  guard passes stack up and each one writes independently. Four overlapping
   *  passes is ~90 writes/sec, which overruns the controller and kills the
   *  link. clearPageRetryTimer() cannot help: it cancels a queued timer, not a
   *  loop that is already running. */
  private recoveryInFlight = false;
  /** Set when a verification request arrives while a pass is in flight, so the
   *  wakeup is deferred rather than dropped. */
  private recoveryWakeupPending = false;
  /**
   * Status line as it stood before the in-flight single-page pull started, so
   * the pull can put it back instead of hardcoding 'Connected' - a Phase 2
   * page-turn download happens *during* a live session, and hardcoding would
   * claim streaming had stopped while pen data was still arriving.
   */
  private statusBeforeDownload: string | null = null;
  private currentStatus = 'Disconnected';

  // Callbacks
  onPen: PenCallback | null = null;
  onLog: LogCallback | null = null;
  onStatus: StatusCallback | null = null;
  onPages: PageCallback | null = null;
  onNextPage: (() => void) | null = null;
  /** Fires for every inbound frame. Used by the liveness watchdog. */
  onFrame: (() => void) | null = null;

  // Every consumer callback below is invoked defensively. `log()` and
  // `setStatus()` are called from all over `handleCommand`, which runs inside
  // handleNotification's blanket try - a throwing consumer there would reach
  // `failInFlightDownload` and silently settle an unrelated in-flight
  // download with partial data. The driver must be unbreakable by consumer
  // code it does not control (TabletPanel/ProbeApp assign these slots raw).
  private log(msg: string) {
    // Deliberately no logging in the catch: the thing that threw *is* the
    // logger, so re-entering it would recurse.
    try { this.onLog?.(msg); } catch { /* consumer's problem, not the driver's */ }
  }

  private setStatus(s: string) {
    this.currentStatus = s;
    try {
      this.onStatus?.(s);
    } catch (err) {
      this.log(`onStatus handler threw: ${err instanceof Error ? err.message : err}`);
    }
  }

  get isConnected() { return this.authenticated; }
  get isStreaming() { return this.streaming; }
  get deviceName() { return this.transport.deviceName; }
  get notebookUuid() { return `huion:${this.transport.deviceId}`; }
  get capabilities() {
    return { paper: true, tablet: true } as const;
  }

  // Connection completion promise
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Releases the handshake slot and, crucially, its 10s timer. Every path
   * that stops caring about the handshake promise goes through here so a
   * successful connect doesn't leave a stray timer pending for 10s (which is
   * also where the "pending timers" noise in the test suite came from).
   */
  private settleHandshake() {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.connectResolve = null;
    this.connectReject = null;
  }

  /** Releases the page-count query slot and its timer. */
  private settlePageCount() {
    if (this.pageCountTimer) {
      clearTimeout(this.pageCountTimer);
      this.pageCountTimer = null;
    }
    this.pageCountResolve = null;
    this.pageCountReject = null;
  }

  async connect(): Promise<void> {
    this.transport.onNotify((bytes) => {
      this.handleNotification(bytes)
        .catch((err) => this.log(`Notification handler error: ${err?.message ?? err}`));
    });
    this.transport.onDisconnect(() => this.handleDisconnect());
    await this.transport.open();
    await this.performHandshake();
  }

  /**
   * Re-establishes the link after an unexpected drop and re-runs the
   * handshake. Unlike `connect()` this needs no user gesture, because the
   * transport reuses the already-permitted device.
   */
  async reconnect(): Promise<void> {
    await this.transport.reopen();
    await this.performHandshake();
  }

  private handleDisconnect() {
    this.authenticated = false;
    this.streaming = false;
    this.setStatus('Disconnected');
    this.log('Device disconnected');
    if (this.connectReject) {
      const rejectConnect = this.connectReject;
      this.settleHandshake();
      rejectConnect(new Error('Device disconnected during handshake'));
    }
    if (this.pageCountReject) {
      // Without this a pending getStoredPageCount() would sit out its full
      // 5s timeout after the link has already provably gone away.
      const rejectPageCount = this.pageCountReject;
      this.settlePageCount();
      this.log('Page count query interrupted by disconnect');
      rejectPageCount(new Error('Device disconnected during page count query'));
    }
    if (this.singlePageResolve) {
      this.log('Single-page download interrupted by disconnect');
      const packages = this.pagePackages.get(this.currentDownloadPage) || [];
      const page = this.decodePage(this.currentDownloadPage, packages);
      const resolvePage = this.singlePageResolve;
      this.singlePageResolve = null;
      this.clearPageRetryTimer();
      if (this.downloadTimer) {
        clearTimeout(this.downloadTimer);
        this.downloadTimer = null;
      }
      this.downloadMode = 'idle';
      resolvePage(page);
    } else if (this.pageResolve) {
      this.log('Download interrupted by disconnect');
      const pages = [...this.downloadedPages];
      this.pageResolve(pages);
      this.pageResolve = null;
      this.clearPageRetryTimer();
      if (this.downloadTimer) {
        clearTimeout(this.downloadTimer);
        this.downloadTimer = null;
      }
      this.downloadMode = 'idle';
    }
  }

  private async performHandshake(): Promise<void> {
    this.log('[6/7] Notifications ready, starting handshake (CD 81 08 ...)...');
    this.setStatus('Handshaking...');

    // Wait for full handshake + MAX_INFO to complete
    await new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (this.connectResolve === resolve) {
          this.settleHandshake();
          reject(new Error('Handshake timeout (10s). Device found but auth did not complete. Check protocol log for details.'));
        }
      }, HANDSHAKE_TIMEOUT_MS);
      this.write(makeFrame(CMD.VERIFY_CONNECT)).catch((err) => {
        if (this.connectResolve === resolve) this.settleHandshake();
        reject(err);
      });
    });

    this.log('[7/7] Handshake complete, connected!');
  }

  async disconnect(): Promise<void> {
    if (this.streaming) await this.stopStreaming();
    this.clearPageRetryTimer();
    await this.transport.close();
    // `gattserverdisconnected` does NOT fire for a disconnect we initiated
    // ourselves while GATT is already down, so handleDisconnect() may never
    // run - settle any in-flight download here or it hangs to its own
    // (up-to-15s-per-page) timeout with downloadMode still held.
    this.failInFlightDownload(new Error('Disconnected'));
    this.authenticated = false;
    this.streaming = false;
    this.setStatus('Disconnected');
  }

  async startStreaming(): Promise<void> {
    if (!this.authenticated) throw new Error('Not authenticated');
    // Configure streaming parameters (from APK decompilation):
    // CMD 0x96 (1, 3, 0, 0) = set sampling mode / report rate
    // CMD 0x96 (3, 2, 0, 0) = set minimum point distance filter
    await this.write(makeFrame(CMD.SET_PACKET_DISTANCE, 1, 3, 0, 0));
    await this.sleep(100);
    await this.write(makeFrame(CMD.SET_PACKET_DISTANCE, 3, 2, 0, 0));
    await this.sleep(100);
    // Capture-proven two-step enable sequence:
    //   Step 1: send 0x8d mode=3, wait for ack (cd 8d 04 01)
    //   Step 2: send 0x8d mode=1, wait for ack (cd 8d 04 01)
    // The captures show mode 3 is sent first (possibly "prepare" mode),
    // then mode 1 starts the actual pen data stream.
    await this.write(makeFrame(CMD.ONLINE_ENABLE, 3, 0, 0, 0));
    await this.sleep(200);
    await this.write(makeFrame(CMD.ONLINE_ENABLE, 1, 0, 0, 0));
    this.streaming = true;
    this.setStatus('Live streaming');
    this.log('Live streaming started');
  }

  async stopStreaming(): Promise<void> {
    await this.write(makeFrame(CMD.ONLINE_ENABLE, 0, 0, 0, 0));
    this.streaming = false;
    this.setStatus('Connected');
    this.log('Live streaming stopped');
  }

  async downloadPages(): Promise<HuionPage[]> {
    if (!this.authenticated) throw new Error('Not authenticated');
    if (this.downloadMode !== 'idle') {
      throw new Error(`Cannot start bulk download: a ${this.downloadMode} download is already in progress`);
    }
    this.downloadMode = 'bulk';
    this.log('Requesting ROM info...');
    this.packageRetries.clear();
    this.pagePackages.clear();
    this.expectedPackageCount = 0;
    this.clearPageRetryTimer();
    this.downloadedPages = [];

    // Mirrors downloadPage()'s structure deliberately: the resolver and the
    // timer are installed *inside* the executor, before the ROM_INFO write is
    // issued. Assigning pageResolve only after awaiting the write left a
    // window in which downloadMode was already 'bulk' with no pending
    // promise, so (a) a disconnect found neither resolver and left the mutex
    // stuck at 'bulk' forever, (b) failInFlightDownload found no resolver and
    // released a mutex this starting download still owned, admitting a
    // concurrent downloadPage() that would then share currentDownloadPage and
    // pagePackages, and (c) a ROM_INFO reply landing before the write settled
    // was dropped by the `pageResolve` guard, stalling to the 15s timeout.
    // The write's failure is routed through .catch below, so the method still
    // rejects with the same error it did before.
    return new Promise<HuionPage[]>((resolve, reject) => {
      this.pageResolve = resolve;
      // Timeout scales with expected work: base 15s + 15s per page
      // Will be reset when we know the actual page count (in ROM_INFO handler)
      this.downloadTimer = setTimeout(() => {
        if (this.pageResolve === resolve) {
          this.log('Page download timed out');
          const pages = [...this.downloadedPages];
          this.clearPageRetryTimer();
          this.pageResolve = null;
          this.downloadTimer = null;
          this.downloadMode = 'idle';
          resolve(pages);
        }
      }, PAGE_DOWNLOAD_TIMEOUT_MS);

      this.write(makeFrame(CMD.ROM_INFO)).catch((err) => {
        // Only tear down if this call still owns the in-flight slot - a
        // notification handler may already have settled it (and handed the
        // mutex to someone else) while the write was outstanding.
        if (this.pageResolve === resolve) {
          this.pageResolve = null;
          this.clearPageRetryTimer();
          if (this.downloadTimer) {
            clearTimeout(this.downloadTimer);
            this.downloadTimer = null;
          }
          this.downloadMode = 'idle';
        }
        reject(err);
      });
    });
  }

  /**
   * Pull a single page (per spec finding C1/C2: pages commit to device
   * memory on page turn, and bulk download is slow and flaky, so the
   * session engine wants to pull pages one at a time as they commit).
   * Reuses the same request/package-assembly machinery as downloadPages(),
   * but resolves with just this page instead of walking the whole book.
   */
  async downloadPage(pageNum: number): Promise<HuionPage> {
    if (!this.authenticated) throw new Error('Not authenticated');
    if (this.downloadMode !== 'idle') {
      throw new Error(`Cannot start single-page download: a ${this.downloadMode} download is already in progress`);
    }
    this.downloadMode = 'single';
    // Not needed for isolation between consecutive single-page pulls -
    // requestPageDownload() below already resets packageRetries,
    // expectedPackageCount, and pagePackages's entry for the *current* page
    // key on every call, which is sufficient since nothing ever reads a
    // pagePackages entry for any page other than currentDownloadPage. This
    // clear() is kept anyway to bound pagePackages's size across a long
    // session that pulls many single pages one at a time (Phase 2's use
    // case) - see the deferred "pagePackages.clear() vs per-key reset
    // inconsistency" note; downloadPages() has the same clear() at its own
    // entry for the same reason.
    this.pagePackages.clear();
    this.clearPageRetryTimer();

    return new Promise<HuionPage>((resolve, reject) => {
      // Assigned before requestPageDownload's write() is even called, so
      // there is no dependency on the fake transport's macrotask-vs-microtask
      // reply timing here (unlike downloadPages(), which assigns pageResolve
      // only after awaiting its write - see huionFixtures.ts / FakeHuionTransport).
      // scheduleOfflinePageVerification()/verifyAndRecoverOfflinePage() gate
      // on `downloadMode !== 'idle'` to know a download is in flight, so no
      // placeholder pageResolve is needed here - pageResolve stays untouched
      // (and null) for the whole single-page path.
      this.singlePageResolve = resolve;
      this.statusBeforeDownload = this.currentStatus;
      this.downloadTimer = setTimeout(() => {
        if (this.singlePageResolve === resolve) {
          this.log(`Page ${pageNum} download timed out`);
          const packages = this.pagePackages.get(this.currentDownloadPage) || [];
          const page = this.decodePage(this.currentDownloadPage, packages);
          const resolvePage = this.singlePageResolve;
          this.singlePageResolve = null;
          this.clearPageRetryTimer();
          this.downloadTimer = null;
          this.downloadMode = 'idle';
          resolvePage(page);
        }
      }, PAGE_DOWNLOAD_TIMEOUT_MS);

      this.requestPageDownload(pageNum).catch((err) => {
        // Guarded on still owning the in-flight slot: an earlier settle path
        // (disconnect, or failInFlightDownload from a notification handler)
        // may already have released the mutex and let another download start,
        // and this stale catch must not then clear *its* resolver, kill *its*
        // timer, or release a mutex it no longer holds. reject() is a no-op
        // in that case - the promise has already been settled.
        if (this.singlePageResolve === resolve) {
          this.singlePageResolve = null;
          this.clearPageRetryTimer();
          if (this.downloadTimer) {
            clearTimeout(this.downloadTimer);
            this.downloadTimer = null;
          }
          this.downloadMode = 'idle';
        }
        reject(err);
      });
    });
  }

  /**
   * Standalone CURRENT_PAGE (0x85) query. Used as the session page baseline:
   * a session's pages are the ones from this index onward.
   */
  async getStoredPageCount(): Promise<number> {
    if (!this.authenticated) throw new Error('Not authenticated');
    // Single-flight, like the two download paths: there is exactly one
    // resolver slot, so a second concurrent call used to silently overwrite
    // the first (which then never settled short of its own timeout).
    if (this.pageCountResolve) {
      throw new Error('Cannot start page count query: one is already in progress');
    }
    return new Promise<number>((resolve, reject) => {
      this.pageCountResolve = resolve;
      this.pageCountReject = reject;
      this.pageCountTimer = setTimeout(() => {
        // Only release the slot if this call still owns it. The old code
        // nulled `pageCountResolve` unconditionally, so a late-firing timer
        // from an abandoned call would wipe out a *later* call's resolver.
        if (this.pageCountResolve === resolve) this.settlePageCount();
        reject(new Error('Page count query timed out'));
      }, PAGE_COUNT_TIMEOUT_MS);
      this.write(makeFrame(CMD.CURRENT_PAGE)).catch((err) => {
        if (this.pageCountResolve === resolve) this.settlePageCount();
        reject(err);
      });
    });
  }

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

  // --- Private ---

  private write(data: Uint8Array): Promise<void> {
    return this.transport.write(data);
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  private clearPageRetryTimer() {
    if (this.pageRetryTimer) {
      clearTimeout(this.pageRetryTimer);
      this.pageRetryTimer = null;
    }
  }

  /**
   * Aborts whatever download is in flight: clears the download and retry
   * timers, releases the `downloadMode` mutex, and settles the pending
   * promise using the same partial-data convention as the existing
   * timeout/disconnect paths (resolve with whatever was decoded so far -
   * never reject once a download has already started exchanging packets).
   * A no-op (beyond making sure downloadMode is 'idle') if nothing is
   * actually in flight, so it's safe to call defensively.
   *
   * Every write failure that happens *after* a download's own initial
   * request has already succeeded - the ROM_INFO handler's CURRENT_PAGE
   * query, the CURRENT_PAGE handler's initial requestPageDownload(0),
   * finishCurrentPageDownload()'s page-to-page continuation, and the
   * REGET_PACKAGE retry writes in handleOfflinePackageResponse() and
   * verifyAndRecoverOfflinePage() - must route through here. The spec
   * calls bulk download "flaky", so a transient write failure there is
   * realistic, not hypothetical. Leaving downloadMode set after one of
   * these fails would wedge every later downloadPage()/downloadPages()
   * call behind whatever's left of the current downloadTimer (which, for
   * a failure mid-way through a multi-page bulk walk, could be most of
   * that walk's whole timeout budget) instead of recovering immediately.
   */
  private failInFlightDownload(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.clearPageRetryTimer();
    if (this.downloadTimer) {
      clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
    }

    if (this.singlePageResolve) {
      this.log(`Single-page download aborted: ${message}`);
      const resolvePage = this.singlePageResolve;
      this.singlePageResolve = null;
      this.downloadMode = 'idle';
      const packages = this.pagePackages.get(this.currentDownloadPage) || [];
      resolvePage(this.decodePage(this.currentDownloadPage, packages));
      return;
    }

    if (this.pageResolve) {
      this.log(`Bulk download aborted: ${message}`);
      const resolvePages = this.pageResolve;
      this.pageResolve = null;
      this.downloadMode = 'idle';
      resolvePages([...this.downloadedPages]);
      return;
    }

    // Nothing in flight (already settled by something else, or never
    // started) - still make sure the mutex isn't left held.
    this.downloadMode = 'idle';
  }

  private scheduleOfflinePageVerification() {
    this.clearPageRetryTimer();
    if (this.downloadMode === 'idle' || this.expectedPackageCount <= 0) {
      return;
    }
    this.pageRetryTimer = setTimeout(() => {
      void this.verifyAndRecoverOfflinePage().catch((err) => {
        this.log(`Offline page verification failed: ${err?.message ?? err}`);
        this.failInFlightDownload(err);
      });
    }, PACKAGE_RETRY_IDLE_MS);
  }

  private async requestPageDownload(pageNum: number) {
    this.currentDownloadPage = pageNum;
    this.expectedPackageCount = 0;
    this.pagePackages.set(pageNum, []);
    this.packageRetries.clear();
    this.clearPageRetryTimer();
    // `totalPages` is only meaningful for a bulk walk, which learns it from
    // its own CURRENT_PAGE query. A single-page pull never runs that query,
    // so the old unconditional `N/${this.totalPages}` read as "page 4/0" on a
    // fresh connection, or "page 4/3" using a previous bulk run's stale count.
    this.setStatus(this.downloadMode === 'bulk' && this.totalPages > 0
      ? `Downloading page ${pageNum + 1}/${this.totalPages}`
      : `Downloading page ${pageNum + 1}`);
    await this.write(makeFrame(CMD.REQUEST_PAGE, pageNum & 0xFF, (pageNum >> 8) & 0xFF, 0, 0));
  }

  private countReceivedPackages(packages: Uint8Array[]) {
    if (this.expectedPackageCount <= 0) {
      return 0;
    }

    let received = 0;
    for (let pkgNum = 1; pkgNum <= this.expectedPackageCount; pkgNum++) {
      if (packages[pkgNum]) {
        received++;
      }
    }
    return received;
  }

  private async verifyAndRecoverOfflinePage() {
    this.pageRetryTimer = null;
    if (this.downloadMode === 'idle' || this.expectedPackageCount <= 0) {
      return;
    }
    if (this.recoveryInFlight) {
      // A pass is already walking the list; it will pick up anything that has
      // arrived since. Remember that we were asked so the wakeup isn't lost.
      this.recoveryWakeupPending = true;
      return;
    }

    this.recoveryInFlight = true;
    this.recoveryWakeupPending = false;
    try {
      await this.runRecoveryPass();
    } finally {
      this.recoveryInFlight = false;
      if (this.recoveryWakeupPending) {
        this.recoveryWakeupPending = false;
        this.scheduleOfflinePageVerification();
      }
    }
  }

  private async runRecoveryPass() {
    // The page this pass is recovering. A pass outlives plenty of state
    // changes - a disconnect, a bulk walk moving on - so every iteration
    // re-checks rather than trusting the entry condition.
    const page = this.currentDownloadPage;

    const packages = this.pagePackages.get(this.currentDownloadPage) || [];
    const missing: number[] = [];
    for (let pkgNum = 1; pkgNum <= this.expectedPackageCount; pkgNum++) {
      if (!packages[pkgNum]) {
        missing.push(pkgNum);
      }
    }

    if (missing.length === 0) {
      await this.finishCurrentPageDownload();
      return;
    }

    let requested = 0;
    for (const pkgNum of missing) {
      const retries = this.packageRetries.get(pkgNum) ?? 0;
      if (retries >= MAX_PACKAGE_RETRIES) {
        continue;
      }

      if (this.downloadMode === 'idle' || this.currentDownloadPage !== page) {
        // Link dropped or the download moved on while we were sleeping.
        // Writing now either throws into a dead GATT connection or corrupts
        // whatever download took our place.
        return;
      }

      this.packageRetries.set(pkgNum, retries + 1);
      requested++;
      this.log(`Page ${this.currentDownloadPage} pkg ${pkgNum}: missing, re-requesting (${retries + 1}/${MAX_PACKAGE_RETRIES})`);
      await this.write(makeFrame(
        CMD.REGET_PACKAGE,
        this.currentDownloadPage & 0xFF,
        (this.currentDownloadPage >> 8) & 0xFF,
        pkgNum & 0xFF,
        (pkgNum >> 8) & 0xFF,
      ));
      await this.sleep(40);
    }

    if (requested > 0) {
      this.scheduleOfflinePageVerification();
      return;
    }

    this.log(`Page ${this.currentDownloadPage}: ${missing.length} package(s) still missing after ${MAX_PACKAGE_RETRIES} retries, decoding partial page`);
    await this.finishCurrentPageDownload();
  }

  private async finishCurrentPageDownload() {
    this.clearPageRetryTimer();
    const packages = this.pagePackages.get(this.currentDownloadPage) || [];
    const received = this.countReceivedPackages(packages);
    if (received < this.expectedPackageCount) {
      this.log(`Page ${this.currentDownloadPage}: decoding partial data (${received}/${this.expectedPackageCount} packages)`);
    } else {
      this.log(`Page ${this.currentDownloadPage}: all ${received} packages received`);
    }

    const page = this.decodePage(this.currentDownloadPage, packages);

    if (this.singlePageResolve) {
      const resolvePage = this.singlePageResolve;
      this.singlePageResolve = null;
      if (this.downloadTimer) {
        clearTimeout(this.downloadTimer);
        this.downloadTimer = null;
      }
      this.downloadMode = 'idle';
      // Restore, don't hardcode: a Phase 2 page-turn pull runs *during* a
      // live session, and 'Connected' would claim streaming had stopped while
      // pen data was still arriving.
      const restored = this.statusBeforeDownload;
      this.statusBeforeDownload = null;
      this.setStatus(restored || 'Connected');
      resolvePage(page);
      return;
    }

    this.downloadedPages.push(page);

    if (this.currentDownloadPage + 1 < this.totalPages) {
      await this.requestPageDownload(this.currentDownloadPage + 1);
      return;
    }

    this.log(`All ${this.downloadedPages.length} pages downloaded`);
    this.setStatus('Connected');
    if (this.downloadTimer) {
      clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
    }
    // Copy, matching the other three settle paths (timeout, disconnect,
    // failInFlightDownload): handing out the live array let a later download
    // on the same instance mutate a caller's already-returned result.
    this.pageResolve?.([...this.downloadedPages]);
    this.pageResolve = null;
    this.downloadMode = 'idle';
  }

  private async handleOfflinePackageResponse(pkgNum: number, data: Uint8Array, source: 'stream' | 'reget') {
    if (pkgNum <= 0) {
      this.log(`Page ${this.currentDownloadPage}: ignoring invalid package number ${pkgNum} from ${source}`);
      return;
    }

    if (!verifyChecksum(data)) {
      const retries = (this.packageRetries.get(pkgNum) ?? 0) + 1;
      this.packageRetries.set(pkgNum, retries);
      if (retries <= MAX_PACKAGE_RETRIES) {
        this.log(`Page ${this.currentDownloadPage} pkg ${pkgNum}: checksum FAILED (${source}, attempt ${retries}/${MAX_PACKAGE_RETRIES}), re-requesting`);
        await this.write(makeFrame(
          CMD.REGET_PACKAGE,
          this.currentDownloadPage & 0xFF,
          (this.currentDownloadPage >> 8) & 0xFF,
          pkgNum & 0xFF,
          (pkgNum >> 8) & 0xFF,
        ));
        this.scheduleOfflinePageVerification();
      } else {
        this.log(`Page ${this.currentDownloadPage} pkg ${pkgNum}: checksum FAILED after ${MAX_PACKAGE_RETRIES} retries, leaving gap`);
      }
      return;
    }

    const packages = this.pagePackages.get(this.currentDownloadPage) || [];
    packages[pkgNum] = data;
    this.pagePackages.set(this.currentDownloadPage, packages);

    const received = this.countReceivedPackages(packages);
    if (received >= this.expectedPackageCount) {
      await this.finishCurrentPageDownload();
      return;
    }

    if (source === 'stream' && pkgNum === this.expectedPackageCount) {
      await this.verifyAndRecoverOfflinePage();
      return;
    }

    this.scheduleOfflinePageVerification();
  }

  private async handleNotification(data: Uint8Array) {
    try {
      this.onFrame?.();
    } catch (err) {
      this.log(`onFrame handler threw: ${err instanceof Error ? err.message : err}`);
    }
    // Log all incoming packets (skip logging flood of live pen data during streaming)
    if (!this.streaming || data.length < 11 || data[1] !== CMD.ONLINE_ENABLE) {
      const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
      this.log(`RX: ${hex} (${data.length}b)`);
    }
    // Framed command response
    if (data.length >= 3 && data[0] === 0xCD) {
      const cmd = data[1];
      try {
        await this.handleCommand(cmd, data);
      } catch (err) {
        // Single choke point for every write failure that can occur inside
        // handleCommand's cascades (ROM_INFO's CURRENT_PAGE query,
        // CURRENT_PAGE's requestPageDownload(0), finishCurrentPageDownload's
        // page-to-page continuation, and the REGET_PACKAGE retry writes) -
        // failInFlightDownload() is a no-op unless a download is actually
        // in flight, so this is safe for non-download failures too (e.g. a
        // handshake write, though those already have their own handling).
        // Rethrown so the existing generic logger at the call site below
        // still logs it, preserving prior behaviour.
        this.failInFlightDownload(err);
        throw err;
      }
      // Also check if it's an 11-byte live packet disguised as 0x8D
      if (cmd === CMD.ONLINE_ENABLE && data.length >= 11 && data[data.length - 1] !== 0xED) {
        this.handleOnlineData(data);
      }
      return;
    }
    // Raw 11-byte or 22-byte live packet
    if (data.length === 11 || data.length === 22) {
      this.handleOnlineData(data);
    }
  }

  private async handleCommand(cmd: number, data: Uint8Array) {
    switch (cmd) {
      case CMD.VERIFY_CONNECT: {
        if (data.length >= 6) {
          this.challenge = [data[3], data[4], data[5]];
          const [x, y, z] = computeAuthResponse(...this.challenge);
          this.log(`Challenge: ${this.challenge} → Response: ${x},${y},${z}`);
          await this.write(makeFrame(CMD.VERIFY_RESPONSE, x, y, z, 0));
        }
        break;
      }
      case CMD.VERIFY_RESPONSE: {
        this.authenticated = true;
        this.setStatus('Authenticated');
        this.log('Handshake complete!');
        await this.sleep(100);
        await this.write(makeFrame(CMD.MAX_INFO));
        break;
      }
      case CMD.MAX_INFO: {
        if (data.length >= 11) {
          this.config.maxX = (data[5] << 16) | (data[4] << 8) | data[3];
          this.config.maxY = (data[8] << 16) | (data[7] << 8) | data[6];
          this.config.maxPressure = (data[10] << 8) | data[9];
          // Detect A4 format: physical size > ~180mm in both axes (assuming 5080 DPI)
          // A4 = ~210x297mm, A5 = ~148x210mm — threshold at 180mm ≈ 36,000 units
          const physW = this.config.maxX / 5080 * 25.4;
          const physH = this.config.maxY / 5080 * 25.4;
          this.config.isA4 = physW > 180 && physH > 250;
          this.config.pageWidth = this.config.isA4 ? HUION_DEFAULT_PAGE_WIDTH_A4 : HUION_DEFAULT_PAGE_WIDTH_A5;
          this.config.pageHeight = this.config.isA4 ? HUION_DEFAULT_PAGE_HEIGHT_A4 : HUION_DEFAULT_PAGE_HEIGHT_A5;
          this.log(`MAX X=${this.config.maxX} Y=${this.config.maxY} P=${this.config.maxPressure} ${this.config.isA4 ? '(A4 detected)' : '(A5)'}`);
          this.log(`Page size ≈ ${this.config.pageWidth}x${this.config.pageHeight}`);
          this.setStatus('Connected');
          if (this.connectResolve) {
            const resolveConnect = this.connectResolve;
            // Clears the 10s handshake timer too - on success it used to be
            // left armed, leaving a stray pending timer after every connect.
            this.settleHandshake();
            resolveConnect();
          }
          // Query battery and device name sequentially (GATT can only handle one at a time)
          try {
            await this.sleep(350);
            await this.write(makeFrame(CMD.BATTERY));
            await this.sleep(350);
            await this.write(makeFrame(CMD.DEVICE_NAME));
          } catch { /* non-critical */ }
        }
        break;
      }
      case CMD.BATTERY: {
        // Capture-proven: cd 8e 04 XX — byte 3 is battery percentage
        if (data.length >= 4) {
          this.config.battery = data[3];
          this.log(`Battery: ${this.config.battery}%`);
        }
        break;
      }
      case CMD.DEVICE_NAME: {
        // Capture-proven: cd 91 XX ... — bytes 3+ are ASCII device name
        if (data.length > 3) {
          // Decode from byte 3 onward, strip null bytes
          const nameBytes = data.slice(3);
          this.config.modelName = new TextDecoder().decode(nameBytes).replace(/\0/g, '').trim();
          this.log(`Device name: ${this.config.modelName}`);
          // Check for A4/T910 device by name (from APK: "Huion Tablet_T910" = A4)
          if (this.config.modelName.includes('T910')) {
            this.config.isA4 = true;
            this.config.pageWidth = HUION_DEFAULT_PAGE_WIDTH_A4;
            this.config.pageHeight = HUION_DEFAULT_PAGE_HEIGHT_A4;
            this.log('A4 device detected from device name (T910)');
          }
        }
        break;
      }
      case CMD.NEXT_PAGE: {
        // Capture-proven: unsolicited cd 8a 06 XX 00 00 — physical notebook button press = new page
        this.log(`Notebook button: new page (${Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ')})`);
        // Consumer code, invoked inside handleNotification's blanket try. A
        // throw here would reach failInFlightDownload and silently settle an
        // in-flight download with partial data - and Phase 2 downloads a page
        // on every page turn, so a page-turn handler and an in-flight
        // download routinely coexist. TabletPanel/ProbeApp assign onNextPage
        // raw (only DeviceController routes it through the swallowing
        // emitter), so the driver has to contain the throw itself.
        try {
          this.onNextPage?.();
        } catch (err) {
          this.log(`onNextPage handler threw: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case CMD.ROM_INFO: {
        if (data.length >= 7) {
          // Capture-proven: cd 8f 08 XX XX XX XX XX — state/status bytes
          // Exact field meaning is unknown from captures alone.
          // The actual page count comes from CURRENT_PAGE (0x85).
          this.romUsed = (data[4] << 8) | data[3];
          this.romTotal = (data[6] << 8) | data[5];
          this.log(`ROM state: [${Array.from(data.slice(3, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
          this.log(`ROM usage: ${this.romUsed}/${this.romTotal}`);
          // Now query actual page count. Gated on downloadMode === 'bulk'
          // (not just pageResolve truthiness) so an unsolicited ROM_INFO
          // frame arriving mid single-page pull can't hijack it into
          // restarting a bulk walk.
          if (this.downloadMode === 'bulk' && this.pageResolve) {
            await this.write(makeFrame(CMD.CURRENT_PAGE));
          }
        }
        break;
      }
      case CMD.CURRENT_PAGE: {
        // 0x85 reply: page count at bytes 3-4 (little-endian)
        if (data.length >= 5) {
          // Gated on downloadMode: a bulk download issues its own
          // CURRENT_PAGE query, and an overlapping page-count query used to
          // intercept that reply, stalling the download to its 15s timeout.
          // The page-count caller instead falls through to its own (much
          // shorter) 5s timeout, which is the strictly better failure.
          if (this.pageCountResolve && this.downloadMode !== 'bulk') {
            const resolvePageCount = this.pageCountResolve;
            this.settlePageCount();
            resolvePageCount((data[4] << 8) | data[3]);
            break;
          }
          this.totalPages = (data[4] << 8) | data[3];
          this.log(`Stored pages: ${this.totalPages}`);
          // Gated on downloadMode === 'bulk' (not just pageResolve
          // truthiness) for the same reason as the ROM_INFO case above: a
          // single-page pull never wants this branch, even if an
          // unsolicited CURRENT_PAGE frame arrives while one is in flight.
          if (this.totalPages > 0 && this.downloadMode === 'bulk' && this.pageResolve) {
            if (this.downloadTimer) clearTimeout(this.downloadTimer);
            const timeoutMs = PAGE_DOWNLOAD_TIMEOUT_MS * Math.max(1, this.totalPages);
            this.downloadTimer = setTimeout(() => {
              if (this.pageResolve) {
                this.log(`Page download timed out after ${timeoutMs}ms`);
                const pages = [...this.downloadedPages];
                this.clearPageRetryTimer();
                this.pageResolve(pages);
                this.pageResolve = null;
                this.downloadTimer = null;
                this.downloadMode = 'idle';
              }
            }, timeoutMs);
            // Captures show page request starts with page 0: cd 86 08 00 00 00 00 ed
            await this.requestPageDownload(0);
          } else if (this.downloadMode === 'bulk' && this.pageResolve) {
            this.log('No pages stored on device');
            this.clearPageRetryTimer();
            if (this.downloadTimer) { clearTimeout(this.downloadTimer); this.downloadTimer = null; }
            this.pageResolve([]);
            this.pageResolve = null;
            this.downloadMode = 'idle';
          }
        }
        break;
      }
      case CMD.REQUEST_PAGE: {
        if (data.length >= 5) {
          this.expectedPackageCount = (data[4] << 8) | data[3];
          this.pagePackages.set(this.currentDownloadPage, []);
          this.packageRetries.clear();
          this.log(`Page ${this.currentDownloadPage}: expecting ${this.expectedPackageCount} packages`);
          if (this.expectedPackageCount === 0) {
            this.log(`Page ${this.currentDownloadPage}: empty page`);
            await this.finishCurrentPageDownload();
          } else {
            this.scheduleOfflinePageVerification();
          }
        }
        break;
      }
      case CMD.PAGE_PACKAGE: {
        if (data.length > 5) {
          const pkgNum = (data[4] << 8) | data[3];
          await this.handleOfflinePackageResponse(pkgNum, data, 'stream');
        }
        break;
      }
      case CMD.REGET_PACKAGE: {
        if (data.length > 5) {
          const pkgNum = (data[4] << 8) | data[3];
          await this.handleOfflinePackageResponse(pkgNum, data, 'reget');
        }
        break;
      }
    }
  }

  private handleOnlineData(data: Uint8Array) {
    const packets: Uint8Array[] = [];
    if (data.length === 11) {
      packets.push(data);
    } else if (data.length === 22) {
      const p1 = new Uint8Array(data.slice(0, 11));
      p1[2] = 11;
      packets.push(p1);
      packets.push(new Uint8Array(data.slice(11)));
    }

    for (const pkt of packets) {
      const point = this.decodeLivePacket(pkt);
      if (!point) continue;
      // Same reasoning as onNextPage: a throwing consumer must not take out
      // the rest of the batch (a 22-byte frame carries two points) or escape
      // into handleNotification's error path.
      try {
        this.onPen?.(point);
      } catch (err) {
        this.log(`onPen handler threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private decodeLivePacket(pkt: Uint8Array): HuionPenPoint | null {
    if (pkt.length !== 11) return null;
    if (!verifyChecksum(pkt)) return null;
    // 11-byte live layout: [hdr0-3] [Xlo:4] [Xhi:5] [Ylo:6] [Yhi:7] [Plo:8] [Phi|st:9] [chk:10]
    const rawX = (pkt[5] << 8) | pkt[4];
    const rawY = (pkt[7] << 8) | pkt[6];
    const pressureRaw = ((pkt[9] & 0x1F) << 8) | pkt[8];
    const rawStatus = (pkt[9] >> 5) & 0x07;
    const maxP = this.config.maxPressure || 8191;
    const scaledPoint = this.scaleRawPoint(rawX, rawY);
    const pressurePercent = (pressureRaw / maxP) * 100;
    const penActive = rawStatus > 0 && pressurePercent >= FILTER_PRESS_PERCENT;

    return {
      x: scaledPoint.normalizedX,
      y: scaledPoint.normalizedY,
      pressure: penActive ? clamp(pressureRaw / maxP, 0, 1) : 0,
      status: penActive ? rawStatus : 0,
      timestamp: Date.now(),
    };
  }

  private decodePage(pageNum: number, packages: Uint8Array[]): HuionPage {
    const decodedPoints: Array<DecodedOfflinePoint | null> = [];
    const strokes: { points: HuionPenPoint[] }[] = [];
    let currentStroke: HuionPenPoint[] = [];
    const packageCount = Math.max(this.expectedPackageCount, packages.length - 1);

    for (let pkgNum = 1; pkgNum <= packageCount; pkgNum++) {
      const pkg = packages[pkgNum];
      if (!pkg || pkg.length <= 6) {
        decodedPoints.push(null);
        continue;
      }
      // Skip 5-byte header, 1-byte checksum at end
      const pointData = pkg.slice(5, pkg.length - 1);
      // 6-byte point records: [Xlo Xhi Ylo Yhi Plo Phi|status]
      for (let i = 0; i + 5 < pointData.length; i += 6) {
        const xRaw = (pointData[i + 1] << 8) | pointData[i];
        const yRaw = (pointData[i + 3] << 8) | pointData[i + 2];
        const pressureRaw = ((pointData[i + 5] & 0x1F) << 8) | pointData[i + 4];
        const status = (pointData[i + 5] >> 5) & 0x07;
        decodedPoints.push(this.decodeOfflinePoint(xRaw, yRaw, pressureRaw, status));
      }
    }

    let lastAcceptedPressurePercent = 0;
    let previousAcceptedPoint: DecodedOfflinePoint | null = null;

    for (let i = 0; i < decodedPoints.length; i++) {
      const point = decodedPoints[i];
      if (!point) {
        if (currentStroke.length > 0) {
          strokes.push({ points: [...currentStroke] });
          currentStroke = [];
        }
        previousAcceptedPoint = null;
        lastAcceptedPressurePercent = 0;
        continue;
      }
      const isLastPoint = i === decodedPoints.length - 1;
      const isActivePoint = point.pressurePercent !== 0 && point.status !== 0;

      if (isActivePoint && !isLastPoint) {
        if (currentStroke.length === 0) {
          currentStroke = [this.makeStoredPoint(point)];
          previousAcceptedPoint = { ...point };
          lastAcceptedPressurePercent = point.pressurePercent;
        } else {
          const candidate: DecodedOfflinePoint = {
            ...point,
            pressurePercent: this.applyOfflinePressureCurve(point.pressurePercent),
          };

          if (!this.shouldFilterOfflinePoint(previousAcceptedPoint, candidate, currentStroke)) {
            const pressureFloor = lastAcceptedPressurePercent - OFFLINE_PRESSURE_FALLOFF_LIMIT;
            if (candidate.pressurePercent < pressureFloor) {
              candidate.pressurePercent = pressureFloor;
            }

            currentStroke.push(this.makeStoredPoint(candidate));
            previousAcceptedPoint = { ...candidate };
            lastAcceptedPressurePercent = candidate.pressurePercent;
          }
        }
        continue;
      }

      if (currentStroke.length === 0) {
        previousAcceptedPoint = null;
        lastAcceptedPressurePercent = 0;
        continue;
      }

      if (isLastPoint) {
        const finalPoint: DecodedOfflinePoint = {
          ...point,
          pressurePercent: this.applyOfflinePressureCurve(point.pressurePercent),
        };
        if (!this.shouldFilterOfflinePoint(previousAcceptedPoint, finalPoint, currentStroke)) {
          currentStroke.push(this.makeStoredPoint(finalPoint));
        }
      }

      strokes.push({ points: [...currentStroke] });
      currentStroke = [];
      previousAcceptedPoint = null;
      lastAcceptedPressurePercent = 0;
    }

    if (currentStroke.length > 0) {
      strokes.push({ points: [...currentStroke] });
    }

    return { pageNum, strokes };
  }

  private scaleRawPoint(rawX: number, rawY: number) {
    const maxX = this.config.maxX || 32767;
    const maxY = this.config.maxY || 32767;
    const logicalPageWidth = this.config.pageWidth || HUION_DEFAULT_PAGE_WIDTH_A5;
    const logicalPageHeight = this.config.pageHeight || HUION_DEFAULT_PAGE_HEIGHT_A5;

    if (this.config.isA4) {
      const rotatedX = maxY - rawY;
      const rotatedY = rawX;
      const normalizedX = clamp(rotatedX / maxY, 0, 1);
      const normalizedY = clamp(rotatedY / maxX, 0, 1);
      return {
        normalizedX,
        normalizedY,
        pageX: normalizedX * logicalPageWidth,
        pageY: normalizedY * logicalPageHeight,
      };
    }

    const normalizedX = clamp(rawX / maxX, 0, 1);
    const normalizedY = clamp(rawY / maxY, 0, 1);
    return {
      normalizedX,
      normalizedY,
      pageX: normalizedX * logicalPageWidth,
      pageY: normalizedY * logicalPageHeight,
    };
  }

  private decodeOfflinePoint(rawX: number, rawY: number, pressureRaw: number, status: number): DecodedOfflinePoint {
    const scaledPoint = this.scaleRawPoint(rawX, rawY);
    const maxP = this.config.maxPressure || 8191;
    const pressurePercent = (pressureRaw / maxP) * 100;
    const penActive = status > 0 && pressurePercent >= FILTER_PRESS_PERCENT;

    return {
      ...scaledPoint,
      pressurePercent: penActive ? pressurePercent : 0,
      status: penActive ? status : 0,
    };
  }

  private applyOfflinePressureCurve(pressurePercent: number): number {
    return clamp(pressurePercent, OFFLINE_MIN_PRESSURE_PERCENT, 100);
  }

  private makeStoredPoint(point: DecodedOfflinePoint): HuionPenPoint {
    return {
      x: point.normalizedX,
      y: point.normalizedY,
      pressure: point.pressurePercent / 100,
      status: point.status,
      timestamp: Date.now(),
    };
  }

  private shouldFilterOfflinePoint(
    previousAcceptedPoint: DecodedOfflinePoint | null,
    candidate: DecodedOfflinePoint,
    currentStroke: HuionPenPoint[],
  ): boolean {
    if (!previousAcceptedPoint) {
      return false;
    }

    const distance = Math.hypot(
      previousAcceptedPoint.pageX - candidate.pageX,
      previousAcceptedPoint.pageY - candidate.pageY,
    );
    if (distance >= OFFLINE_POINT_FILTER_DISTANCE) {
      return false;
    }

    if (previousAcceptedPoint.pressurePercent >= candidate.pressurePercent) {
      return true;
    }

    previousAcceptedPoint.pressurePercent = candidate.pressurePercent;
    const lastPoint = currentStroke[currentStroke.length - 1];
    if (lastPoint) {
      lastPoint.pressure = candidate.pressurePercent / 100;
    }
    return true;
  }
}
