import { beforeEach, describe, expect, it } from 'vitest';
import type { GapSuggestionRecord } from '../storage/types';
import {
  clearDraft,
  getDraft,
  reconcileDraft,
  resetAllDrafts,
  setDraftChoice,
} from './reviewDraft';

function gap(id: string, text: string, pageId = 'p1'): GapSuggestionRecord {
  return { id, noteId: 'n1', pageId, text, status: 'proposed' } as GapSuggestionRecord;
}

beforeEach(() => resetAllDrafts());

describe('reviewDraft', () => {
  it('round-trips a choice and clears it with null', () => {
    setDraftChoice('n1', gap('a', 'x'), 'accepted');
    expect(getDraft('n1').get('a')).toBe('accepted');
    setDraftChoice('n1', gap('a', 'x'), null);
    expect(getDraft('n1').size).toBe(0);
  });

  it('clearDraft empties a note and notes are independent', () => {
    setDraftChoice('n1', gap('a', 'x'), 'accepted');
    setDraftChoice('n2', gap('b', 'y'), 'rejected');
    clearDraft('n1');
    expect(getDraft('n1').size).toBe(0);
    expect(getDraft('n2').get('b')).toBe('rejected');
  });

  it('returns an empty map when there is no draft', () => {
    expect(getDraft('none').size).toBe(0);
  });

  it('getDraft returns a copy', () => {
    setDraftChoice('n1', gap('a', 'x'), 'accepted');
    getDraft('n1').delete('a');
    getDraft('n1').set('z', 'rejected');
    expect([...getDraft('n1').keys()]).toEqual(['a']);
  });

  describe('reconcileDraft', () => {
    it('keeps an entry whose id is still proposed', () => {
      setDraftChoice('n1', gap('a', 'x'), 'accepted');
      reconcileDraft('n1', [gap('a', 'x')]);
      expect(getDraft('n1').get('a')).toBe('accepted');
    });

    it('moves an entry to a same-page row with the same normalized text', () => {
      setDraftChoice('n1', gap('a', 'The Krebs cycle.'), 'accepted');
      reconcileDraft('n1', [gap('b', 'the krebs cycle')]);
      expect(Object.fromEntries(getDraft('n1'))).toEqual({ b: 'accepted' });
    });

    it('drops an entry with no matching row', () => {
      setDraftChoice('n1', gap('a', 'x'), 'accepted');
      reconcileDraft('n1', [gap('b', 'other')]);
      expect(getDraft('n1').size).toBe(0);
    });

    it('does not match a same-text row on a different page', () => {
      setDraftChoice('n1', gap('a', 'x', 'p1'), 'accepted');
      reconcileDraft('n1', [gap('b', 'x', 'p2')]);
      expect(getDraft('n1').size).toBe(0);
    });

    it('does not move onto a row that already has its own entry', () => {
      setDraftChoice('n1', gap('a', 'x'), 'accepted');
      setDraftChoice('n1', gap('b', 'x'), 'rejected');
      reconcileDraft('n1', [gap('b', 'x')]);
      expect(Object.fromEntries(getDraft('n1'))).toEqual({ b: 'rejected' });
    });
  });
});
