import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '@/app/SettingsDialog';

// Each section has its own tests and its own dependencies (theme provider,
// IndexedDB, Ollama); this file is only about the dialog around them.
vi.mock('@/themes/ThemeSettings', () => ({ ThemeSettings: () => <section>theme-panel</section> }));
vi.mock('@/notes/TranscriptionSettings', () => ({
  TranscriptionSettings: () => <section>transcription-panel</section>,
}));
vi.mock('@/audio/AudioSettings', () => ({ AudioSettings: () => <section>audio-panel</section> }));
vi.mock('@/backup/BackupSettings', () => ({ BackupSettings: () => <section>backup-panel</section> }));

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

async function open() {
  act(() => root.render(<SettingsDialog />));
  const trigger = container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;
  await act(async () => {
    trigger.click();
  });
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('settings dialog did not open');
  return dialog as HTMLElement;
}

async function selectTab(dialog: HTMLElement, name: string) {
  const tab = Array.from(dialog.querySelectorAll('[role="tab"]')).find(
    (t) => t.textContent === name,
  ) as HTMLElement;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
}

describe('SettingsDialog', () => {
  it('caps its height to the viewport so it never runs off screen', async () => {
    const dialog = await open();

    expect(dialog.className).toMatch(/\bmax-h-\[calc\(100dvh-2rem\)\]/);
  });

  it('scrolls the sections inside the dialog, keeping the header in place', async () => {
    const dialog = await open();

    const body = dialog.querySelector('[data-settings-body]');
    expect(body).not.toBeNull();
    expect(body?.className).toMatch(/\boverflow-y-auto\b/);
    expect(body?.textContent).toContain('theme-panel');
    expect(body?.contains(dialog.querySelector('h2'))).toBe(false);
  });

  it('groups sections under a vertical tab list, starting on Theme', async () => {
    const dialog = await open();

    const list = dialog.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Theme', 'Transcription', 'Audio', 'Backup']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(dialog.textContent).toContain('theme-panel');
  });

  it('shows only the selected tab and hides the others', async () => {
    const dialog = await open();

    await selectTab(dialog, 'Backup');

    expect(dialog.textContent).toContain('backup-panel');
    expect(dialog.textContent).not.toContain('theme-panel');
  });

  it('keeps the tab list outside the scrolling body and the panel inside it', async () => {
    const dialog = await open();

    const body = dialog.querySelector('[data-settings-body]') as HTMLElement;
    expect(body.contains(dialog.querySelector('[role="tablist"]'))).toBe(false);
    expect(body.contains(dialog.querySelector('[role="tabpanel"]'))).toBe(true);
  });

  it('starts on Theme again when reopened', async () => {
    let dialog = await open();
    await selectTab(dialog, 'Audio');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const trigger = container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });
    dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Theme');
  });
});
