import type { CaptureEngine } from '@/capture/types';
import type { DeviceController, DeviceState } from '@/device/controller';

export interface PageTurnCaptureDeps {
  controller: DeviceController;
  engine: Pick<CaptureEngine, 'newPage'>;
  /** Defaults to `console.error` with a `[page-turn]` prefix. */
  onError?: (message: string, error: unknown) => void;
}

function logError(message: string, error: unknown) {
  console.error(`[page-turn] ${message}`, error);
}

/**
 * Keeps the controller's capture (page-turn poll, liveness, auto-reconnect)
 * running while the pad is connected and streaming, and turns every page-turn
 * event into `engine.newPage('device-turn')`. Returns a detach function.
 *
 * Lifecycle rules (docs/features/f4-spec.md):
 * - Start on connected AND streaming. `isConnected` goes true at
 *   'Authenticated', mid-handshake; streaming only starts after connect()
 *   resolves, so the first page-count poll never interleaves with the handshake.
 * - Never stop while reconnecting. The controller keeps its detector running
 *   through a drop so turns made while the link was down are recovered from the
 *   count; stopping would end the reconnect and re-anchor that baseline.
 * - Stop only on a full disconnect (not connected, not reconnecting): an app
 *   disconnect() or the reconnect policy giving up.
 */
export function attachPageTurnCapture(deps: PageTurnCaptureDeps): () => void {
  const { controller, engine } = deps;
  const onError = deps.onError ?? logError;

  let attached = true;
  // True between our startCapture() and our stopCapture(). Set before calling
  // the controller, because both calls publish state synchronously and land
  // back in evaluate() below.
  let owned = false;
  // Which start a late startCapture() failure belongs to.
  let attempt = 0;
  // Set while we clean up a failed start: the state that stopCapture()
  // publishes must not trigger an immediate retry (an endless loop when
  // startCapture throws synchronously).
  let recovering = false;

  function stop() {
    try {
      controller.stopCapture();
    } catch (error) {
      onError('stopCapture failed', error);
    }
  }

  function start() {
    owned = true;
    const myAttempt = ++attempt;
    const fail = (error: unknown) => {
      onError('startCapture failed', error);
      // Detached, stopped since, or superseded by a newer start: not ours to undo.
      if (!attached || !owned || myAttempt !== attempt) return;
      owned = false;
      recovering = true;
      try {
        stop();
      } finally {
        recovering = false;
      }
    };
    try {
      controller.startCapture().catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  function evaluate(state: DeviceState) {
    if (!attached || recovering) return;
    if (!owned && state.isConnected && state.isStreaming) {
      start();
    } else if (owned && !state.isConnected && !state.isReconnecting) {
      owned = false;
      stop();
    }
  }

  function onPageTurn() {
    if (!attached) return;
    try {
      // A null result means no active note (A7): nothing to do.
      Promise.resolve(engine.newPage('device-turn')).catch((error: unknown) => {
        onError('newPage failed', error);
      });
    } catch (error) {
      onError('newPage failed', error);
    }
  }

  // Page turns first, so no turn can slip between capture starting and the
  // subscription existing.
  const unsubscribeTurns = controller.subscribePageTurn(onPageTurn);
  const unsubscribeState = controller.subscribeState(evaluate);
  evaluate(controller.getState());

  return () => {
    if (!attached) return;
    attached = false;
    unsubscribeTurns();
    unsubscribeState();
    if (owned) {
      owned = false;
      stop();
    }
  };
}
