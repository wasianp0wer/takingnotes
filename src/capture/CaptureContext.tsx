import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { CaptureEngine, CaptureState } from '@/capture/types';

const CaptureContext = createContext<CaptureEngine | null>(null);

/**
 * Puts the app's single capture engine into context. Thin by design, and it
 * takes the engine rather than creating one: the engine needs the device
 * controller, which lives one level up in `TabletProvider`, and tests need to
 * pass a fake.
 */
export function CaptureProvider({
  engine,
  children,
}: {
  engine: CaptureEngine;
  children: ReactNode;
}) {
  return <CaptureContext.Provider value={engine}>{children}</CaptureContext.Provider>;
}

export function useCaptureEngine(): CaptureEngine {
  const engine = useContext(CaptureContext);
  if (!engine) {
    throw new Error('useCaptureEngine must be used within a CaptureProvider');
  }
  return engine;
}

/**
 * The live capture state. `useSyncExternalStore` for the same reason
 * `useHuionDevice` uses it: a `useState` + `useEffect(subscribe)` pair drops
 * any change that lands between render and effect commit, which is exactly the
 * window a note started by the first pen stroke falls into.
 */
export function useCaptureState(): CaptureState {
  const engine = useCaptureEngine();
  return useSyncExternalStore(engine.subscribe, engine.getState);
}
