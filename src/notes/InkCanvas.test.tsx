import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import type { PageStroke } from '@/storage/types';
import { BUILT_IN_THEMES } from '@/themes/builtins';
import { ThemeProvider, useThemes, type ThemesContextValue } from '@/themes/ThemeProvider';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';
import { InkCanvas } from './InkCanvas';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Node 25's global localStorage shadows happy-dom's; install a Map-backed one.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const dark = BUILT_IN_THEMES.find((t) => t.id === 'dark')!;
const light = BUILT_IN_THEMES.find((t) => t.id === 'light')!;
const stroke: PageStroke = {
  points: [
    { x: 0.1, y: 0.1, pressure: 0.5 },
    { x: 0.4, y: 0.4, pressure: 0.5 },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;
let sets: { prop: string; value: unknown }[];
let themes: ThemesContextValue | null;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

function recordingContext(): unknown {
  const noop = () => {};
  const ctx: Record<string, unknown> = {
    fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, arc: noop, fill: noop,
  };
  for (const prop of ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin']) {
    Object.defineProperty(ctx, prop, {
      get: () => undefined,
      set: (value: unknown) => void sets.push({ prop, value }),
    });
  }
  return ctx;
}

function Probe() {
  const value = useThemes();
  useEffect(() => {
    themes = value;
  });
  return null;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  vi.stubGlobal('localStorage', memoryStorage());
  sets = [];
  themes = null;
  HTMLCanvasElement.prototype.getContext = (() => recordingContext()) as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Probe />
        <CaptureProvider engine={engine}>
          <InkCanvas strokes={[stroke]} dims={{ pageWidth: null, pageHeight: null }} />
        </CaptureProvider>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
}

const first = (prop: string) => sets.find((s) => s.prop === prop)?.value;

describe('InkCanvas', () => {
  it('paints with the active theme canvas and ink colours, not the OCR raster colours', async () => {
    await mount();
    sets = [];
    await act(async () => {
      await themes!.setActive('dark');
    });
    expect(first('fillStyle')).toBe(dark.colors['canvas-bg']);
    expect(first('strokeStyle')).toBe(dark.colors.ink);
    const canvas = container.querySelector('canvas')!;
    expect(canvas.classList.contains('bg-white')).toBe(false);
    expect(canvas.classList.contains('bg-canvas')).toBe(true);
  });

  it('repaints when the theme changes', async () => {
    await mount();
    sets = [];
    await act(async () => {
      await themes!.setActive('dark');
    });
    expect(sets.some((s) => s.prop === 'fillStyle' && s.value === dark.colors['canvas-bg'])).toBe(true);
    expect(dark.colors['canvas-bg']).not.toBe(light.colors['canvas-bg']);
  });
});
