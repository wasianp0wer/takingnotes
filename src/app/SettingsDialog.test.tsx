import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '@/app/SettingsDialog';

// Each section has its own tests and its own dependencies (theme provider,
// IndexedDB, Ollama); this file is only about the dialog around them.
vi.mock('@/themes/ThemeSettings', () => ({ ThemeSettings: () => <section>Theme</section> }));
vi.mock('@/notes/TranscriptionSettings', () => ({
  TranscriptionSettings: () => <section>Transcription</section>,
}));
vi.mock('@/audio/AudioSettings', () => ({ AudioSettings: () => <section>Audio</section> }));
vi.mock('@/backup/BackupSettings', () => ({ BackupSettings: () => <section>Backup</section> }));

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
    expect(body?.textContent).toContain('Backup');
    expect(body?.contains(dialog.querySelector('h2'))).toBe(false);
  });
});
