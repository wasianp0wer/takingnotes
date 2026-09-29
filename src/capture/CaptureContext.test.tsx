import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaptureProvider, useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { CaptureEngine } from '@/capture/types';
import { createFakeDeviceController } from '@/test/fakeDeviceController';

// React only allows `act` when the environment declares itself a test one.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(engine: CaptureEngine, children: React.ReactNode) {
  act(() => {
    root.render(<CaptureProvider engine={engine}>{children}</CaptureProvider>);
  });
}

function StateProbe() {
  const state = useCaptureState();
  return <span data-testid="state">{`${state.activeNoteId ?? 'idle'}/${state.pageIndex}`}</span>;
}

function EngineProbe() {
  const engine = useCaptureEngine();
  return <span>{typeof engine.startNote}</span>;
}

describe('CaptureProvider', () => {
  it('exposes the engine it was given', () => {
    const engine = createCaptureEngine({ controller: createFakeDeviceController() });
    render(engine, <EngineProbe />);
    expect(container.textContent).toBe('function');
  });

  it('re-renders on every capture state change', async () => {
    const engine = createCaptureEngine({ controller: createFakeDeviceController() });
    render(engine, <StateProbe />);
    expect(container.textContent).toBe('idle/-1');

    let noteId = '';
    await act(async () => {
      noteId = await engine.startNote();
    });
    expect(container.textContent).toBe(`${noteId}/0`);

    await act(async () => {
      await engine.newPage('device-turn');
    });
    expect(container.textContent).toBe(`${noteId}/1`);

    await act(async () => {
      await engine.endNote();
    });
    expect(container.textContent).toBe('idle/-1');
  });
});
