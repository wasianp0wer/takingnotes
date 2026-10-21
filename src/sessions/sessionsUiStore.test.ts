import { describe, expect, it } from 'vitest';

import { EMPTY_SIDEBAR_FILTER } from './filter';
import { createSessionsUiStore, SESSIONS_UI_STORAGE_KEY } from './sessionsUiStore';

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SESSIONS_UI_STORAGE_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('sessionsUiStore', () => {
  it('persists selection, page, recording and notes mode; restores them in a new store', () => {
    const storage = memoryStorage();
    const a = createSessionsUiStore(storage);
    a.selectEntry('note:n1');
    a.goToPage(2);
    a.selectRecording('r9');
    a.setNotesMode('transcription');
    const b = createSessionsUiStore(storage).getState();
    expect(b.selectedKey).toBe('note:n1');
    expect(b.pageIndex).toBe(2);
    expect(b.recordingId).toBe('r9');
    expect(b.notesMode).toBe('transcription');
  });

  it('does not persist the sidebar filter or the tab', () => {
    const storage = memoryStorage();
    const a = createSessionsUiStore(storage);
    a.setSidebarFilter({ ...EMPTY_SIDEBAR_FILTER, quick: 'x' });
    a.setTab('triage');
    a.setAdvancedFilterOpen(true);
    const b = createSessionsUiStore(storage).getState();
    expect(b.sidebarFilter).toEqual(EMPTY_SIDEBAR_FILTER);
    expect(b.tab).toBe('sessions');
    expect(b.advancedFilterOpen).toBe(false);
  });

  it('corrupt persisted JSON yields defaults without throwing', () => {
    expect(createSessionsUiStore(memoryStorage('{not json')).getState().selectedKey).toBeNull();
    expect(createSessionsUiStore(memoryStorage('null')).getState().pageIndex).toBe(0);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const s = createSessionsUiStore(throwing);
    expect(s.getState().selectedKey).toBeNull();
    expect(() => s.selectEntry('note:a')).not.toThrow();
    const n = createSessionsUiStore(null);
    expect(n.getState().notesMode).toBe('transcription');
    expect(() => n.selectEntry('note:a')).not.toThrow();
  });

  it('ignores a persisted shape with an unknown version', () => {
    const raw = JSON.stringify({ version: 99, selectedKey: 'note:n1', pageIndex: 3 });
    const s = createSessionsUiStore(memoryStorage(raw)).getState();
    expect(s.selectedKey).toBeNull();
    expect(s.pageIndex).toBe(0);
  });

  it('openRecording selects the owner note, or the recording when unowned', () => {
    const s = createSessionsUiStore(null);
    s.setTab('triage');
    s.openRecording('r1', 4200, 'n1');
    expect(s.getState()).toMatchObject({
      selectedKey: 'note:n1',
      recordingId: 'r1',
      tab: 'sessions',
      seek: { recordingId: 'r1', startMs: 4200 },
    });
    s.openRecording('r1', 0, null);
    expect(s.getState().selectedKey).toBe('recording:r1');
  });

  it('each openRecording issues a fresh seek token, even for the same target', () => {
    const s = createSessionsUiStore(null);
    s.openRecording('r1', 100, 'n1');
    const first = s.getState().seek!.token;
    s.openRecording('r1', 100, 'n1');
    expect(s.getState().seek!.token).not.toBe(first);
  });

  it('clearSeek(oldToken) after a newer request keeps the newer one', () => {
    const s = createSessionsUiStore(null);
    s.openRecording('r1', 100, 'n1');
    const old = s.getState().seek!.token;
    s.openRecording('r2', 200, null);
    const newer = s.getState().seek!;
    s.clearSeek(old);
    expect(s.getState().seek).toEqual(newer);
    s.clearSeek(newer.token);
    expect(s.getState().seek).toBeNull();
  });

  it('openNote sets the page and mode and switches to Sessions', () => {
    const s = createSessionsUiStore(null);
    s.setTab('triage');
    s.openNote('n2', 3, 'transcription');
    expect(s.getState()).toMatchObject({
      tab: 'sessions',
      selectedKey: 'note:n2',
      pageIndex: 3,
      notesMode: 'transcription',
    });
  });

  it('a fresh store defaults the notes half to Transcription', () => {
    expect(createSessionsUiStore(memoryStorage()).getState().notesMode).toBe('transcription');
  });

  it('selecting a session opens it on its transcript', () => {
    const s = createSessionsUiStore(memoryStorage());
    s.setNotesMode('handwriting');
    s.selectEntry('note:b');
    expect(s.getState().notesMode).toBe('transcription');
  });

  it('followActiveNote switches the notes half back to Handwriting so live ink shows', () => {
    const store = createSessionsUiStore(null);
    store.openNote('old', 2, 'transcription');
    store.setTab('triage');
    store.followActiveNote('n1', 0);
    expect(store.getState()).toMatchObject({
      tab: 'sessions',
      selectedKey: 'note:n1',
      pageIndex: 0,
      notesMode: 'handwriting',
    });
  });

  it('selectEntry resets page and recording', () => {
    const s = createSessionsUiStore(null);
    s.openRecording('r1', 5, 'n1');
    s.goToPage(4);
    s.selectEntry('note:n2');
    expect(s.getState()).toMatchObject({ pageIndex: 0, recordingId: null });
  });
});
