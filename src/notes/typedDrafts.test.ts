import { afterEach, describe, expect, it } from 'vitest';

import { clearTypedDraft, hasUnsavedTypedText, setTypedDraft } from '@/notes/typedDrafts';

afterEach(() => {
  clearTypedDraft('p1');
  clearTypedDraft('p2');
});

describe('typed drafts', () => {
  it('reports no unsaved text for a page with no draft', () => {
    expect(hasUnsavedTypedText('p1')).toBe(false);
  });

  it('reports unsaved text once a non-blank draft is set, per page', () => {
    setTypedDraft('p1', 'hello');
    expect(hasUnsavedTypedText('p1')).toBe(true);
    expect(hasUnsavedTypedText('p2')).toBe(false);
  });

  it('treats a whitespace-only draft as no text', () => {
    setTypedDraft('p1', '  \n ');
    expect(hasUnsavedTypedText('p1')).toBe(false);
  });

  it('forgets the draft once cleared', () => {
    setTypedDraft('p1', 'hello');
    clearTypedDraft('p1');
    expect(hasUnsavedTypedText('p1')).toBe(false);
  });
});
