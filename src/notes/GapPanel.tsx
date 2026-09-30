import { useEffect, useState } from 'react';

import type { GapAnalyzer } from '@/gaps/analyzer';
import { Button } from '@/components/ui/button';
import { listGapsByPage, updateGap } from '@/storage/gaps';
import { getPage } from '@/storage/pages';
import type { GapKind, GapStatus, GapSuggestionRecord, PageRecord } from '@/storage/types';

export interface GapPanelProps {
  /** The note the page belongs to; gap suggestions are stored against both. */
  noteId: string;
  /** The page whose suggestions are listed. Remount per page, as `TranscriptPanel` does. */
  pageId: string;
  /** Tests only - a real mount builds one from settings. */
  analyzer?: GapAnalyzer;
}

/** Readable labels for `GapKind`, shared with the test that asserts against them. */
export const GAP_KIND_LABELS: Record<GapKind, string> = {
  claim: 'Claim',
  definition: 'Definition',
  'name-or-date': 'Name or date',
  example: 'Example',
  'argument-step': 'Argument step',
  other: 'Other',
};

/**
 * A single suggestion's kind badge and its verbatim speech, so both the
 * review buttons and the accepted/rejected blocks can render it the same way.
 */
function SuggestionQuote({ suggestion }: { suggestion: GapSuggestionRecord }) {
  return (
    <>
      <p className="text-sm">{suggestion.text}</p>
      <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
        {GAP_KIND_LABELS[suggestion.kind]}
      </span>
      <blockquote aria-label="From the recording" className="mt-1 border-l-2 pl-2 text-sm italic text-muted-foreground">
        {suggestion.sourceQuote}
      </blockquote>
    </>
  );
}

/**
 * Suggestions from comparing a page's handwriting against the matching
 * stretch of a lecture recording (P1): each `proposed` point is reviewed one
 * at a time, `Find gaps` starts an analysis, and the panel shows its status.
 * Accepted text is recording-derived content attached to the page - clearly
 * labelled, never editable, and never merged into `TranscriptRecord.markdown`
 * (A24). Nothing here imports anything that writes a transcript.
 *
 * P1 replaces the placeholder body and keeps the name and props. The
 * `aria-label` is the mount point the notes view asserts on, so it stays too.
 */
export function GapPanel({ noteId, pageId }: GapPanelProps) {
  const [, setPage] = useState<PageRecord | null>(null);
  const [gaps, setGaps] = useState<GapSuggestionRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([getPage(pageId), listGapsByPage(pageId)])
      .then(([loadedPage, loadedGaps]) => {
        if (!live) return;
        setPage(loadedPage ?? null);
        setGaps(loadedGaps);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [pageId, noteId, revision]);

  function review(id: string, status: GapStatus) {
    updateGap(id, { status })
      .then(() => setRevision((n) => n + 1))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }

  const proposed = gaps.filter((g) => g.status === 'proposed');
  const accepted = gaps.filter((g) => g.status === 'accepted');
  const rejected = gaps.filter((g) => g.status === 'rejected');

  return (
    <section
      aria-label="Gaps"
      data-note-id={noteId}
      data-page-id={pageId}
      className="border-t border-border p-4"
    >
      <h3 className="text-sm font-medium">Gaps</h3>
      {loadError && <p className="mt-1 text-sm text-destructive">{loadError}</p>}

      {proposed.length > 0 && (
        <ul className="mt-2 space-y-3">
          {proposed.map((suggestion) => (
            <li key={suggestion.id} className="space-y-1 rounded border border-border p-2">
              <SuggestionQuote suggestion={suggestion} />
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => review(suggestion.id, 'accepted')}>
                  Accept
                </Button>
                <Button variant="outline" size="sm" onClick={() => review(suggestion.id, 'rejected')}>
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {accepted.length > 0 && (
        <div className="mt-3 space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">From the recording</h4>
          <ul className="space-y-3">
            {accepted.map((suggestion) => (
              <li key={suggestion.id} className="space-y-1 rounded border border-border p-2">
                <SuggestionQuote suggestion={suggestion} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="mt-3 space-y-2 text-muted-foreground">
          <h4 className="text-xs font-medium">Rejected</h4>
          <ul className="space-y-3">
            {rejected.map((suggestion) => (
              <li key={suggestion.id} className="space-y-1 rounded border border-border p-2">
                <SuggestionQuote suggestion={suggestion} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
