import type { GapSuggestionRecord } from '../storage/types';
import type { GapDecision } from './gapPage';
import { normalizeGapText } from './validate';

interface DraftEntry {
  decision: GapDecision;
  pageId: string;
  /** Normalized suggestion text, used to re-find the row after a re-run. */
  key: string;
}

/** Review choices per note, held in memory until Submit. */
const drafts = new Map<string, Map<string, DraftEntry>>();

/** A copy of the note's choices by suggestion id; empty when none. */
export function getDraft(noteId: string): Map<string, GapDecision> {
  const out = new Map<string, GapDecision>();
  for (const [id, entry] of drafts.get(noteId) ?? []) out.set(id, entry.decision);
  return out;
}

/** Record a choice for a suggestion; `null` clears it. */
export function setDraftChoice(
  noteId: string,
  gap: GapSuggestionRecord,
  decision: GapDecision | null,
): void {
  let entries = drafts.get(noteId);
  if (decision === null) {
    entries?.delete(gap.id);
    return;
  }
  if (!entries) {
    entries = new Map();
    drafts.set(noteId, entries);
  }
  entries.set(gap.id, {
    decision,
    pageId: gap.pageId,
    key: normalizeGapText(gap.text),
  });
}

export function clearDraft(noteId: string): void {
  drafts.delete(noteId);
}

/**
 * After a re-run recreates suggestion rows, keep choices whose row survives and
 * move the rest onto a proposed row with the same page and normalized text.
 * Choices with no such row are dropped.
 */
export function reconcileDraft(noteId: string, proposed: GapSuggestionRecord[]): void {
  const entries = drafts.get(noteId);
  if (!entries) return;
  const proposedIds = new Set(proposed.map((g) => g.id));
  const next = new Map<string, DraftEntry>();
  for (const [id, entry] of entries) {
    if (proposedIds.has(id)) next.set(id, entry);
  }
  for (const [id, entry] of entries) {
    if (proposedIds.has(id)) continue;
    const match = proposed.find(
      (g) =>
        !entries.has(g.id) &&
        !next.has(g.id) &&
        g.pageId === entry.pageId &&
        normalizeGapText(g.text) === entry.key,
    );
    if (match) next.set(match.id, entry);
  }
  if (next.size === 0) drafts.delete(noteId);
  else drafts.set(noteId, next);
}

/** Tests only. */
export function resetAllDrafts(): void {
  drafts.clear();
}
