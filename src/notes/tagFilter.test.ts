import { describe, expect, it } from 'vitest';

import { matchesTagFilter } from '@/notes/tagFilter';

describe('matchesTagFilter', () => {
  it('matches everything when nothing is selected', () => {
    expect(matchesTagFilter([], [], 'and')).toBe(true);
    expect(matchesTagFilter(['history'], [], 'or')).toBe(true);
  });

  it('AND requires every selected tag', () => {
    expect(matchesTagFilter(['seminar', 'week-3'], ['seminar', 'week-3'], 'and')).toBe(true);
    expect(matchesTagFilter(['seminar'], ['seminar', 'week-3'], 'and')).toBe(false);
  });

  it('OR requires at least one selected tag', () => {
    expect(matchesTagFilter(['seminar'], ['seminar', 'week-3'], 'or')).toBe(true);
    expect(matchesTagFilter(['lecture'], ['seminar', 'week-3'], 'or')).toBe(false);
  });

  it('a note with no tags never matches a non-empty selection', () => {
    expect(matchesTagFilter([], ['seminar'], 'or')).toBe(false);
    expect(matchesTagFilter([], ['seminar'], 'and')).toBe(false);
  });
});
