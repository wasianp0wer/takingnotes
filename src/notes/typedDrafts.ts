/**
 * Typed-page text the editor holds but has not saved yet (its autosave is
 * debounced). The capture engine asks here before replacing a typed page it
 * believes is blank: the database alone would call a page blank for the
 * half-second after the first keystrokes, and replacing it then would throw
 * that typing away.
 */
const drafts = new Map<string, string>();

export function setTypedDraft(pageId: string, text: string): void {
  drafts.set(pageId, text);
}

export function clearTypedDraft(pageId: string): void {
  drafts.delete(pageId);
}

/** True when the editor holds unsaved, non-blank text for this page. */
export function hasUnsavedTypedText(pageId: string): boolean {
  return (drafts.get(pageId) ?? '').trim() !== '';
}
