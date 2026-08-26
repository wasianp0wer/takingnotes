import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { DeviceController, DeviceState } from '@/device/controller';
import { createDeviceController } from '@/device/controller';

const TabletContext = createContext<DeviceController | null>(null);

/**
 * Holds one `DeviceController` for the app's lifetime. Thin by design - all
 * device orchestration lives in `controller.ts`; this component only wires
 * it into React context and mirrors its state into React state via
 * `subscribeState` so consumers can render on changes.
 *
 * Not mounted anywhere yet: Phase 4 builds the shell that uses it. Mounting
 * it today would start a second live `HuionNoteBLE` alongside the studio's
 * still-mounted `TabletPanel`, and both would fight over one Bluetooth
 * device.
 */
export function TabletProvider({ children }: { children: ReactNode }) {
  const [controller] = useState<DeviceController>(() => createDeviceController());

  return (
    <TabletContext.Provider value={controller}>
      {children}
    </TabletContext.Provider>
  );
}

/** Returns the app's single device controller plus its live connection state. */
export function useHuionDevice(): { controller: DeviceController; state: DeviceState } {
  const controller = useContext(TabletContext);
  if (!controller) {
    throw new Error('useHuionDevice must be used within a TabletProvider');
  }

  const [state, setState] = useState<DeviceState>(() => controller.getState());

  useEffect(() => controller.subscribeState(setState), [controller]);

  return { controller, state };
}
