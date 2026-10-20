import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { DeviceController, DeviceState } from '@/device/controller';
import { cn } from '@/lib/utils';

/**
 * Takes the controller and its state as props rather than calling
 * `useHuionDevice()` itself, so it can be tested against
 * `createFakeDeviceController()` without a provider. `AppShell` reads the hook
 * once and passes both down.
 */
export function DeviceStatus({
  controller,
  state,
}: {
  controller: DeviceController;
  state: DeviceState;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      // The common case is the user dismissing the browser's Bluetooth chooser,
      // which rejects. Surfacing it beats a button that silently does nothing.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    run(async () => {
      await controller.connect();
      // Streaming is what makes the pen arrive; connecting without it looks
      // connected but captures nothing.
      await controller.startStreaming();
    });

  const disconnect = () => run(() => controller.disconnect());

  const dot = state.isReconnecting
    ? 'bg-status-warn'
    : state.isConnected
      ? 'bg-status-ok'
      : 'bg-muted-foreground/40';

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full', dot, state.isReconnecting && 'animate-pulse')}
      />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-xs font-medium">
          {state.isReconnecting
            ? 'Reconnecting...'
            : state.isConnected
              ? state.deviceName || 'Connected'
              : 'Not connected'}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {error ?? state.status}
          {state.isConnected && ` · ${state.storedPageCount} pages on device`}
          {/* K26/K27: hidden entirely when unknown - before the first reply, or while disconnected. */}
          {state.batteryPercent !== null && ` · ${state.batteryPercent}% battery`}
        </div>
      </div>
      <Button
        size="sm"
        variant={state.isConnected ? 'outline' : 'default'}
        disabled={busy}
        onClick={state.isConnected ? disconnect : connect}
      >
        {state.isConnected ? 'Disconnect' : busy ? 'Connecting...' : 'Connect'}
      </Button>
    </div>
  );
}
