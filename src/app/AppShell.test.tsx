import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/AppShell';
import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import { TabletProvider } from '@/device/TabletProvider';
import { createFakeDeviceController } from '@/test/fakeDeviceController';

const migrate = vi.hoisted(() => vi.fn(async () => ({
  imported: 0,
  pages: 0,
  failed: 0,
  skipped: true,
})));

vi.mock('@/storage/migrate', () => ({ migrateLegacyNotebooks: migrate }));

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

function renderShell() {
  const engine = createCaptureEngine({ controller: createFakeDeviceController() });
  act(() => {
    root.render(
      <TabletProvider>
        <CaptureProvider engine={engine}>
          <AppShell />
        </CaptureProvider>
      </TabletProvider>,
    );
  });
}

function tab(label: string): HTMLElement {
  const found = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`no tab labelled ${label}`);
  return found as HTMLElement;
}

describe('AppShell', () => {
  it('shows the three tabs, the device status and the header controls', () => {
    renderShell();

    expect(tab('Notes')).toBeTruthy();
    expect(tab('Recordings')).toBeTruthy();
    expect(tab('Triage')).toBeTruthy();
    expect(container.textContent).toContain('Not connected');
    expect(container.textContent).toContain('Record');
    expect(container.querySelector('[aria-label="Settings"]')).toBeTruthy();
  });

  it('opens on Notes, which mounts F4\'s page-turn controls', () => {
    renderShell();

    expect(tab('Notes').getAttribute('data-state')).toBe('active');
    // NotesView must keep rendering PageTurnControls: it is F4's only mount point.
    expect(container.textContent).toContain('New page');
  });

  it('switches tabs', async () => {
    renderShell();

    await act(async () => {
      tab('Triage').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      tab('Triage').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(tab('Triage').getAttribute('data-state')).toBe('active');
    expect(
      ['Tasks', 'Calendar', 'Scratchpad'].every(
        (label) => container.querySelector(`section[aria-label="${label}"]`) !== null,
      ),
    ).toBe(true);
  });

  it('runs the legacy notebook migration once for the whole app', () => {
    renderShell();
    act(() => root.unmount());
    root = createRoot(container);
    renderShell();

    // Once across two mounts (and across StrictMode's double mount in dev):
    // two overlapping runs would both find the "migrated" setting unset and
    // import the library twice.
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});
