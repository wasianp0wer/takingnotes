/**
 * Phase 0 placeholder for F4 (docs/architecture.md §3.5). Mounted once by
 * `AppShell`, so the wiring exists before the behaviour does.
 *
 * F4 fills this in: while the pad is connected it keeps the controller's
 * capture running (`startCapture`/`stopCapture`: page-turn polling, liveness,
 * reconnect) and forwards every `controller.subscribePageTurn` event to
 * `engine.newPage('device-turn')`.
 */
export function usePageTurnCapture(): void {
  // No-op until F4.
}
