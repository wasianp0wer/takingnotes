import { useEffect } from 'react';

import { useCaptureEngine } from '@/capture/CaptureContext';
import { attachPageTurnCapture } from '@/capture/pageTurnCapture';
import { useHuionDevice } from '@/device/TabletProvider';

/**
 * F4 (docs/architecture.md §3.5). Mounted once by `AppShell`. While the pad is
 * connected and streaming it keeps the controller's capture running (page-turn
 * polling, liveness, reconnect) and forwards every page-turn event to
 * `engine.newPage('device-turn')`. All the logic lives in
 * `attachPageTurnCapture`; this only ties it to the component's lifetime.
 *
 * Under StrictMode's double effect a connected pad sees startCapture,
 * stopCapture, startCapture - never two live subscriptions.
 */
export function usePageTurnCapture(): void {
  const { controller } = useHuionDevice();
  const engine = useCaptureEngine();

  useEffect(() => attachPageTurnCapture({ controller, engine }), [controller, engine]);
}
