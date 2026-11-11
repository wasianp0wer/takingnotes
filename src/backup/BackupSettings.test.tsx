import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackupSettings } from '@/backup/BackupSettings';
import { BackupFormatError } from '@/backup/format';
import { ImportBlockedError } from '@/backup/guards';
import { BackupTooNewError } from '@/backup/importBackup';
import type { DesktopBridge } from '@/desktop/bridge';
import { fakeDesktopBridge } from '@/test/fakeDesktopBridge';

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

const summary = {
  appVersion: '1.2.3',
  exportedAt: Date.UTC(2026, 10, 1, 12),
  dbVersion: 5,
  counts: { notes: 7, pages: 3, recordings: 2, sessions: 4 },
};

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    exportBackup: vi.fn(async () => new Blob(['x'])),
    backupFileName: vi.fn(() => 'takingnotes-backup-2026-11-11.tnbackup'),
    inspectBackup: vi.fn(async () => summary),
    importBackup: vi.fn(async (_f: File, o?: { onProgress?(d: number, t: number): void }) => {
      o?.onProgress?.(1, 2);
    }),
    ...over,
  };
}

function render(deps = makeDeps(), reload = vi.fn()) {
  act(() => root.render(<BackupSettings deps={deps} reload={reload} />));
  return { deps, reload };
}

const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;

async function pickFile() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['data'], 'b.tnbackup');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return file;
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('BackupSettings', () => {
  it('shows the app version', () => {
    render();
    expect(container.textContent).toContain('Backup');
    expect(container.textContent).toContain(`TakingNotes ${__APP_VERSION__}`);
  });

  it('export downloads a .tnbackup', async () => {
    const create = vi.fn(() => 'blob:fake');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { deps } = render();
    await act(async () => button('Export backup…').click());
    await flush();
    expect(deps.exportBackup).toHaveBeenCalledWith({ appVersion: __APP_VERSION__ });
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    const a = click.mock.contexts[0] as HTMLAnchorElement;
    expect(a.download).toBe('takingnotes-backup-2026-11-11.tnbackup');
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('import shows summary then replaces on confirm and reloads', async () => {
    const { deps, reload } = render();
    const file = await pickFile();
    expect(deps.inspectBackup).toHaveBeenCalledWith(file);
    expect(container.textContent).toContain(
      'This replaces everything currently in TakingNotes. Export a backup first if you want to keep it.',
    );
    expect(container.textContent).toContain('1.2.3');
    expect(container.textContent).toMatch(/7\s*notes/i);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => button('Replace and import').click());
    await flush();
    expect(deps.importBackup).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('awaits the desktop storage flush before reloading', async () => {
    const order: string[] = [];
    let release!: () => void;
    const flushStorage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('flush-start');
          release = () => {
            order.push('flush-done');
            resolve();
          };
        }),
    );
    const w = window as Window & { takingnotesDesktop?: DesktopBridge };
    w.takingnotesDesktop = { ...fakeDesktopBridge().bridge, flushStorage };
    try {
      const reload = vi.fn(() => order.push('reload'));
      render(makeDeps(), reload);
      await pickFile();
      await act(async () => button('Replace and import').click());
      await flush();
      expect(flushStorage).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      await act(async () => release());
      await flush();
      expect(order).toEqual(['flush-start', 'flush-done', 'reload']);
    } finally {
      delete w.takingnotesDesktop;
    }
  });

  it('still reloads when the desktop flush fails', async () => {
    const w = window as Window & { takingnotesDesktop?: DesktopBridge };
    w.takingnotesDesktop = {
      ...fakeDesktopBridge().bridge,
      flushStorage: vi.fn(async () => {
        throw new Error('flush failed');
      }),
    };
    try {
      const { reload } = render();
      await pickFile();
      await act(async () => button('Replace and import').click());
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      delete w.takingnotesDesktop;
    }
  });

  it('shows blocker messages and does not reload', async () => {
    const deps = makeDeps({
      importBackup: vi.fn(async () => {
        throw new ImportBlockedError(['other-tabs', 'session-active']);
      }),
    });
    const { reload } = render(deps);
    await pickFile();
    await act(async () => button('Replace and import').click());
    await flush();
    expect(container.textContent).toContain('Close other TakingNotes tabs first.');
    expect(container.textContent).toContain('End the active session first.');
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows the not-a-backup message', async () => {
    const deps = makeDeps({
      inspectBackup: vi.fn(async () => {
        throw new BackupFormatError('not-a-backup', 'nope');
      }),
    });
    render(deps);
    await pickFile();
    expect(container.textContent).toContain("That file isn't a TakingNotes backup, or it's incomplete.");
  });

  it('shows the too-new message', async () => {
    const deps = makeDeps({
      inspectBackup: vi.fn(async () => {
        throw new BackupTooNewError(99);
      }),
    });
    render(deps);
    await pickFile();
    expect(container.textContent).toContain(
      'This backup is from a newer version of TakingNotes. Update the app first.',
    );
  });
});
