import { vi } from 'vitest';

import type { ChooserMessage, DesktopBridge } from '@/desktop/bridge';

export interface FakeDesktopBridge {
  bridge: DesktopBridge;
  /** Delivers a chooser message to every live `onChooser` subscriber. */
  emit: (msg: ChooserMessage) => void;
  /** The live subscribers; its size is how many components are listening. */
  listeners: Set<(msg: ChooserMessage) => void>;
  select: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

/** A desktop bridge whose `onChooser` keeps live listeners, like the preload's. */
export function fakeDesktopBridge(): FakeDesktopBridge {
  const listeners = new Set<(msg: ChooserMessage) => void>();
  const select = vi.fn();
  const cancel = vi.fn();
  const bridge: DesktopBridge = {
    platform: 'darwin',
    devices: {
      onChooser(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      select,
      cancel,
    },
    probeOllama: async () => false,
    flushStorage: async () => {},
  };
  return { bridge, listeners, select, cancel, emit: (msg) => listeners.forEach((fn) => fn(msg)) };
}
