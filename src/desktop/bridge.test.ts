import { afterEach, describe, expect, it } from 'vitest';
import { getDesktopBridge, type DesktopBridge } from './bridge';

type BridgeWindow = Window & { takingnotesDesktop?: unknown };

afterEach(() => {
  delete (window as BridgeWindow).takingnotesDesktop;
});

describe('getDesktopBridge', () => {
  it('getDesktopBridge returns null without window.takingnotesDesktop', () => {
    expect(getDesktopBridge()).toBeNull();
  });

  it('returns the preload bridge when the desktop shell exposed one', () => {
    const bridge: DesktopBridge = {
      platform: 'darwin',
      devices: {
        onChooser: () => () => {},
        select: () => {},
        cancel: () => {},
      },
      probeOllama: async () => false,
    };
    (window as BridgeWindow).takingnotesDesktop = bridge;
    expect(getDesktopBridge()).toBe(bridge);
  });
});
