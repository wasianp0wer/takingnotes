import { notifyPagesChanged } from '@/notes/pageChanges';
import { reviewProposedGaps } from '@/storage/gaps';
import { createTypedPage, listPages } from '@/storage/pages';
import { getRecording } from '@/storage/recordings';
import type { GapSuggestionRecord, PageRecord, RecordingRecord } from '@/storage/types';

export type GapDecision = 'accepted' | 'rejected';

export const STALE_REVIEW_MESSAGE = 'Suggestions changed — reopen Review to see the latest.';

/** `m:ss`, or `h:mm:ss` from one hour on. Negative input clamps to zero. */
export function formatOffset(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Offsets from the recording's start: the quote's own, else the page window. */
export function quoteRange(
  gap: GapSuggestionRecord,
  recording: RecordingRecord,
): { startMs: number; endMs: number } {
  if (gap.quoteStartMs !== undefined && gap.quoteEndMs !== undefined) {
    return { startMs: gap.quoteStartMs, endMs: gap.quoteEndMs };
  }
  return {
    startMs: Math.max(0, gap.fromMs - recording.startedAt),
    endMs: Math.max(0, gap.toMs - recording.startedAt),
  };
}

export function buildGapPageMarkdown(
  items: Array<{ gap: GapSuggestionRecord; recording: RecordingRecord }>,
): string {
  const ordered = items
    .map((item) => ({ ...item, range: quoteRange(item.gap, item.recording) }))
    .sort(
      (a, b) =>
        a.recording.startedAt - b.recording.startedAt || a.range.startMs - b.range.startMs,
    );
  const bullets = ordered.map(
    ({ gap, recording, range }) =>
      `- **${gap.text}**\n  > ${gap.sourceQuote}\n  — ${recording.title}, ${formatOffset(range.startMs)}–${formatOffset(range.endMs)}`,
  );
  return `## From the recording\n\n${bullets.join('\n\n')}`;
}

/**
 * Persists the review: each decision is written to its gap, and the accepted
 * ones become a new typed page appended to the note. Undecided gaps are left
 * `proposed`. Throws `STALE_REVIEW_MESSAGE`, writing nothing, when any decided
 * gap is gone or no longer `proposed`. Resolves to the new page, or null when nothing was accepted.
 */
export async function submitGapReview(
  noteId: string,
  decisions: Map<string, GapDecision>,
): Promise<PageRecord | null> {
  // All-or-nothing: an accepted row written without its typed page would be
  // lost work, so a stale id (a run replaced the rows) fails before any write.
  const reviewed = await reviewProposedGaps(
    decisions,
    () => new Error(STALE_REVIEW_MESSAGE),
  );
  const accepted = reviewed.filter((g) => g.status === 'accepted');
  if (accepted.length === 0) return null;

  const items: Array<{ gap: GapSuggestionRecord; recording: RecordingRecord }> = [];
  for (const gap of accepted) {
    const recording =
      (await getRecording(gap.recordingId)) ??
      ({ id: gap.recordingId, title: 'Recording', startedAt: gap.fromMs } as RecordingRecord);
    items.push({ gap, recording });
  }

  const pages = await listPages(noteId);
  const pageIndex = pages.reduce((max, p) => Math.max(max, p.pageIndex), -1) + 1;
  const page = await createTypedPage({ noteId, pageIndex, text: buildGapPageMarkdown(items) });
  notifyPagesChanged(noteId);
  return page;
}
