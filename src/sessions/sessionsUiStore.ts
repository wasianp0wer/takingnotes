import { noteKey, recordingKey } from './catalog';
import { EMPTY_SIDEBAR_FILTER } from './filter';
import type { SidebarFilter } from './filter';

export type MainTab = 'sessions' | 'triage';
export type NotesMode = 'handwriting' | 'transcription';
export interface SeekRequest {
  token: number;
  recordingId: string;
  startMs: number;
}
export interface SessionsUiState {
  tab: MainTab;
  selectedKey: string | null;
  pageIndex: number;
  recordingId: string | null;
  notesMode: NotesMode;
  seek: SeekRequest | null;
  sidebarFilter: SidebarFilter;
  advancedFilterOpen: boolean;
}

export const SESSIONS_UI_STORAGE_KEY = 'takingnotes.sessionsUi';
const STORAGE_VERSION = 1;

export interface SessionsUiStore {
  getState(): SessionsUiState;
  subscribe(listener: () => void): () => void;
  setTab(tab: MainTab): void;
  /** Resets pageIndex to 0 and recordingId to null. */
  selectEntry(key: string): void;
  goToPage(index: number): void;
  selectRecording(recordingId: string | null): void;
  setNotesMode(mode: NotesMode): void;
  setSidebarFilter(filter: SidebarFilter): void;
  setAdvancedFilterOpen(open: boolean): void;
  /** Switches to the Sessions tab. */
  openNote(noteId: string, pageIndex: number, mode?: NotesMode): void;
  /** Switches to the Sessions tab and issues a fresh seek token. */
  openRecording(recordingId: string, startMs: number | undefined, ownerNoteId: string | null): void;
  /** No-op if a newer token is pending. */
  clearSeek(token: number): void;
  /**
   * Switches to the Sessions tab and to Handwriting, so the live page shows
   * its ink rather than a "will be transcribed" placeholder.
   */
  followActiveNote(noteId: string, pageIndex: number): void;
  followPage(pageIndex: number): void;
}

type Persisted = Pick<SessionsUiState, 'selectedKey' | 'pageIndex' | 'recordingId' | 'notesMode'>;

const DEFAULTS: SessionsUiState = {
  tab: 'sessions',
  selectedKey: null,
  pageIndex: 0,
  recordingId: null,
  notesMode: 'handwriting',
  seek: null,
  sidebarFilter: EMPTY_SIDEBAR_FILTER,
  advancedFilterOpen: false,
};

function readPersisted(storage: Pick<Storage, 'getItem'> | null | undefined): Partial<Persisted> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SESSIONS_UI_STORAGE_KEY);
    if (raw === null) return {};
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return {};
    const d = data as Record<string, unknown>;
    if (d.version !== STORAGE_VERSION) return {};
    const out: Partial<Persisted> = {};
    if (typeof d.selectedKey === 'string' || d.selectedKey === null) out.selectedKey = d.selectedKey;
    if (typeof d.pageIndex === 'number' && Number.isInteger(d.pageIndex) && d.pageIndex >= 0) {
      out.pageIndex = d.pageIndex;
    }
    if (typeof d.recordingId === 'string' || d.recordingId === null) out.recordingId = d.recordingId;
    if (d.notesMode === 'handwriting' || d.notesMode === 'transcription') {
      out.notesMode = d.notesMode;
    }
    return out;
  } catch {
    return {};
  }
}

export function createSessionsUiStore(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
): SessionsUiStore {
  let state: SessionsUiState = { ...DEFAULTS, ...readPersisted(storage) };
  let nextToken = 1;
  const listeners = new Set<() => void>();

  function persist(): void {
    if (!storage) return;
    const p: Persisted = {
      selectedKey: state.selectedKey,
      pageIndex: state.pageIndex,
      recordingId: state.recordingId,
      notesMode: state.notesMode,
    };
    try {
      storage.setItem(SESSIONS_UI_STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...p }));
    } catch {
      // Persistence is best-effort.
    }
  }

  function update(patch: Partial<SessionsUiState>): void {
    const next = { ...state, ...patch };
    if ((Object.keys(patch) as (keyof SessionsUiState)[]).every((k) => next[k] === state[k])) return;
    state = next;
    persist();
    listeners.forEach((l) => l());
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTab: (tab) => update({ tab }),
    selectEntry: (key) => update({ selectedKey: key, pageIndex: 0, recordingId: null }),
    goToPage: (pageIndex) => update({ pageIndex }),
    selectRecording: (recordingId) => update({ recordingId }),
    setNotesMode: (notesMode) => update({ notesMode }),
    setSidebarFilter: (sidebarFilter) => update({ sidebarFilter }),
    setAdvancedFilterOpen: (advancedFilterOpen) => update({ advancedFilterOpen }),
    openNote: (noteId, pageIndex, mode) =>
      update({
        tab: 'sessions',
        selectedKey: noteKey(noteId),
        pageIndex,
        recordingId: null,
        ...(mode ? { notesMode: mode } : {}),
      }),
    openRecording: (recordingId, startMs, ownerNoteId) =>
      update({
        tab: 'sessions',
        selectedKey: ownerNoteId === null ? recordingKey(recordingId) : noteKey(ownerNoteId),
        pageIndex: 0,
        recordingId,
        seek: { token: nextToken++, recordingId, startMs: startMs ?? 0 },
      }),
    clearSeek(token) {
      if (state.seek !== null && state.seek.token === token) update({ seek: null });
    },
    followActiveNote: (noteId, pageIndex) =>
      update({
        tab: 'sessions',
        selectedKey: noteKey(noteId),
        pageIndex,
        recordingId: null,
        notesMode: 'handwriting',
      }),
    followPage: (pageIndex) => update({ pageIndex }),
  };
}
