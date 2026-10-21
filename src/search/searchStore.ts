import type { FindHit, FindHitSource, FindOptions } from '@/search/find';
import type { SmartSearchResult } from '@/search/smartSearch';
import type { TagFilterMode } from '@/notes/tagFilter';
import type { SessionsUiStore } from '@/sessions/sessionsUiStore';

export interface SearchFilters {
  from: string | null;
  to: string | null;
  tags: string[];
  tagMode: TagFilterMode;
  sources: FindHitSource[];
}

export const ALL_SEARCH_SOURCES: readonly FindHitSource[] = [
  'note-title',
  'note-summary',
  'page-text',
  'audio-segment',
];

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  from: null,
  to: null,
  tags: [],
  tagMode: 'or',
  sources: [...ALL_SEARCH_SOURCES],
};

export interface SearchState {
  quickQuery: string;
  advancedOpen: boolean;
  query: string;
  regex: boolean;
  filters: SearchFilters;
  smart: { query: string; result: SmartSearchResult } | null;
}

export interface SearchStore {
  getState(): SearchState;
  subscribe(l: () => void): () => void;
  setQuickQuery(q: string): void;
  openAdvanced(seedQuery?: string): void;
  closeAdvanced(): void;
  setQuery(q: string): void;
  setRegex(on: boolean): void;
  setFilters(f: SearchFilters): void;
  setSmart(smart: SearchState['smart']): void;
  clear(): void;
}

export const QUICK_RESULTS_CAP = 8;

function initialState(advancedOpen: boolean): SearchState {
  return {
    quickQuery: '',
    advancedOpen,
    query: '',
    regex: false,
    filters: EMPTY_SEARCH_FILTERS,
    smart: null,
  };
}

/** Memory only: a reload starts with an empty search. */
export function createSearchStore(): SearchStore {
  let state = initialState(false);
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SearchState>): void => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    setQuickQuery: (quickQuery) => update({ quickQuery }),
    openAdvanced: (seedQuery) =>
      update(seedQuery === undefined ? { advancedOpen: true } : { advancedOpen: true, query: seedQuery }),
    closeAdvanced: () => update({ advancedOpen: false }),
    setQuery: (query) => update({ query }),
    setRegex: (regex) => update({ regex }),
    setFilters: (filters) => update({ filters }),
    setSmart: (smart) => update({ smart }),
    clear: () => update(initialState(state.advancedOpen)),
  };
}

function parseDay(day: string | null, endOfDay: boolean): number | null {
  if (day === null || day === '') return null;
  const at = new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  return Number.isNaN(at) ? null : at;
}

export function toFindOptions(state: Pick<SearchState, 'regex' | 'filters'>): FindOptions {
  const { filters } = state;
  return {
    regex: state.regex,
    from: parseDay(filters.from, false),
    to: parseDay(filters.to, true),
    tags: filters.tags,
    tagMode: filters.tagMode,
    sources: filters.sources,
  };
}

export function openHit(hit: FindHit, sessions: SessionsUiStore): void {
  if (hit.source === 'audio-segment') {
    if (hit.recordingId === undefined) return;
    sessions.openRecording(hit.recordingId, hit.startMs, hit.noteId);
    return;
  }
  if (hit.noteId === null) return;
  if (hit.source === 'page-text') {
    sessions.openNote(hit.noteId, hit.pageIndex ?? 0, 'transcription');
    return;
  }
  sessions.openNote(hit.noteId, 0);
}
