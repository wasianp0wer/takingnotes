import { describe, expect, it, vi } from 'vitest';

import type { FindHit } from '@/search/find';
import { createSearchStore, EMPTY_SEARCH_FILTERS, openHit } from '@/search/searchStore';
import type { SessionsUiStore } from '@/sessions/sessionsUiStore';

function fakeSessions() {
  const openNote = vi.fn();
  const openRecording = vi.fn();
  return { store: { openNote, openRecording } as unknown as SessionsUiStore, openNote, openRecording };
}

describe('search store', () => {
  it('openAdvanced seeds the query and opens the panel', () => {
    const s = createSearchStore();
    s.openAdvanced('bureau');
    expect(s.getState().query).toBe('bureau');
    expect(s.getState().advancedOpen).toBe(true);
  });

  it('closeAdvanced keeps query, smart, regex and filters', () => {
    const s = createSearchStore();
    const filters = { ...EMPTY_SEARCH_FILTERS, tags: ['thesis'] };
    const smart = { query: 'q', result: {} as never };
    s.openAdvanced('bureau');
    s.setRegex(true);
    s.setFilters(filters);
    s.setSmart(smart);
    s.closeAdvanced();
    const st = s.getState();
    expect(st.advancedOpen).toBe(false);
    expect([st.query, st.regex, st.filters, st.smart]).toEqual(['bureau', true, filters, smart]);
  });

  it('clear resets everything except advancedOpen', () => {
    const s = createSearchStore();
    s.openAdvanced('bureau');
    s.setQuickQuery('x');
    s.setRegex(true);
    s.setFilters({ ...EMPTY_SEARCH_FILTERS, tags: ['a'] });
    s.setSmart({ query: 'q', result: {} as never });
    s.clear();
    const st = s.getState();
    expect(st.advancedOpen).toBe(true);
    expect(st.quickQuery).toBe('');
    expect(st.query).toBe('');
    expect(st.regex).toBe(false);
    expect(st.filters).toEqual(EMPTY_SEARCH_FILTERS);
    expect(st.smart).toBeNull();
  });
});

describe('openHit', () => {
  it('opens a page hit on its page in transcription mode', () => {
    const { store, openNote } = fakeSessions();
    const hit: FindHit = { source: 'page-text', noteId: 'n1', noteTitle: 'T', pageIndex: 3, snippet: 's' };
    openHit(hit, store);
    expect(openNote).toHaveBeenCalledWith('n1', 3, 'transcription');
  });

  it('opens a title hit on page 0 with no mode', () => {
    const { store, openNote } = fakeSessions();
    openHit({ source: 'note-title', noteId: 'n1', noteTitle: 'T', snippet: 's' }, store);
    expect(openNote).toHaveBeenCalledTimes(1);
    expect(openNote.mock.calls[0]).toEqual(['n1', 0]);
  });

  it('opens an audio hit at its segment, naming the owner note', () => {
    const { store, openRecording } = fakeSessions();
    openHit(
      { source: 'audio-segment', noteId: 'n1', noteTitle: 'T', recordingId: 'r1', startMs: 4200, snippet: 's' },
      store,
    );
    expect(openRecording).toHaveBeenCalledWith('r1', 4200, 'n1');
  });
});
