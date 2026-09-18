export interface LivenessDeps {
  /** A cheap read. Rejecting is taken as proof the link is dead. */
  ping: () => Promise<unknown>;
  onDead: () => void;
}

export interface LivenessOptions {
  /**
   * Silence after which the link is suspect.
   *
   * COUPLING, by design: in the device controller composition every inbound
   * frame reaches `noteFrame()`, and that includes the page-turn detector's
   * own `0x85` page-count reply - not just pen data. With the shipped
   * defaults (detector `pollIntervalMs` 5s, `idleMs` 15s) a healthy detector
   * therefore refreshes `lastFrameAt` about three times per idle window and
   * this watchdog never pings at all; it only wakes after roughly three
   * consecutive poll failures, and its own ping is then the same coalesced
   * page-count read (controller.ts's `readStoredPageCount`). That ordering is
   * deliberate - the watchdog is an escalation backstop behind the detector,
   * not a parallel sensor - but it holds ONLY while
   * `pollIntervalMs < idleMs`. Raising the detector's poll interval above
   * `idleMs` silently inverts the roles: the watchdog becomes the primary
   * liveness sensor and starts pinging on every quiet window. Change either
   * value with the other in mind.
   */
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
  // Bumped by both start() and stop() - the same shape reconnect.ts and
  // pageTurnDetector.ts use. Clearing the interval does NOT cancel a ping
  // that is already awaiting the radio: without this counter that ping
  // resolves or rejects after stop() and acts on a session that no longer
  // exists. Two concrete cases, both reachable through the controller:
  //
  //  - An ordinary drop. The driver's handleDisconnect() calls
  //    setStatus('Disconnected') BEFORE it rejects an in-flight page-count
  //    read, so controller.handleDrop() (and therefore stop()) runs first
  //    and the ping rejects a microtask later. `capturing` is still true, so
  //    onDead() would log "silent and unresponsive" and fire a second,
  //    redundant reportLinkDead() into an already-arming reconnect chase -
  //    corrupting the probe's marker timeline, which is this phase's
  //    deliverable.
  //  - stopCapture() then startCapture() inside the ping's 5s timeout
  //    window. Nothing rejects the outstanding read; by the time it times
  //    out `capturing` is true again and onDead() would tear down a link
  //    that is perfectly healthy.
  //
  // A boolean cannot tell "stopped" from "restarted"; a generation can.
  let generation = 0;

  async function check(myGen: number) {
    // One ping at a time: the check interval is shorter than a ping can take,
    // and piling pings onto a struggling link is how the write storm started.
    if (pinging) return;
    if (myGen !== generation) return;
    if (Date.now() - lastFrameAt < idleMs) return;
    pinging = true;
    try {
      await deps.ping();
      // A reply is itself proof of life even if no notification arrived - but
      // only for the session that asked. A late reply belonging to a stopped
      // or superseded session must not backdate a new session's idle window.
      if (myGen === generation) lastFrameAt = Date.now();
    } catch {
      if (myGen === generation) deps.onDead();
    } finally {
      // Only the generation that claimed the slot may release it: a stale
      // ping settling after a restart would otherwise free the slot out from
      // under the live session's own in-flight ping.
      if (myGen === generation) pinging = false;
    }
  }

  return {
    start() {
      if (timer) return;
      generation++;
      const myGen = generation;
      // A ping left in flight by the previous session no longer owns the
      // slot (its generation is stale), so clear it here or this session
      // could never ping at all.
      pinging = false;
      lastFrameAt = Date.now();
      timer = setInterval(() => { void check(myGen); }, checkIntervalMs);
    },
    stop() {
      generation++;
      pinging = false;
      if (timer) { clearInterval(timer); timer = null; }
    },
    noteFrame() {
      lastFrameAt = Date.now();
    },
  };
}
