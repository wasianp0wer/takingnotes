import { useEffect, useRef, useState } from 'react';

import type { GapAnalyzer } from '@/gaps/analyzer';
import { recordingForNote } from '@/gaps/analyzer';
import { describeGapSkip, gapEligibility } from '@/gaps/eligibility';
import { createConfiguredGapAnalyzer } from '@/gaps/startGaps';
import { speechWindowForPage } from '@/gaps/window';
import { Button } from '@/components/ui/button';
import { listGapsByPage, updateGap } from '@/storage/gaps';
import { getPage } from '@/storage/pages';
import type {
  GapKind,
  GapStatus,
  GapSuggestionRecord,
  PageRecord,
  RecordingRecord,
} from '@/storage/types';

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
export function GapPanel({ noteId, pageId, analyzer }: GapPanelProps) {
  const [page, setPage] = useState<PageRecord | null>(null);
  const [gaps, setGaps] = useState<GapSuggestionRecord[]>([]);
  const [recording, setRecording] = useState<RecordingRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [running, setRunning] = useState<null | 'page' | 'note'>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Guards a `setState` after an `await` in `run` below, so a run that
  // outlives the component (the user navigates away mid-analysis) never
  // touches state after unmount and never logs - it is simply abandoned.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([getPage(pageId), listGapsByPage(pageId), recordingForNote(noteId)])
      .then(([loadedPage, loadedGaps, loadedRecording]) => {
        if (!live) return;
        setPage(loadedPage ?? null);
        setGaps(loadedGaps);
        setRecording(loadedRecording);
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

  async function run(kind: 'page' | 'note') {
    // A press while a run is already in flight is a no-op: the buttons are
    // disabled for this, but a second press slipping through (a race, or an
    // environment that does not honour `disabled`) must not start a second
    // run on top of it.
    if (running !== null) return;
    setRunning(kind);
    setRunError(null);
    try {
      const activeAnalyzer = analyzer ?? (await createConfiguredGapAnalyzer());
      if (kind === 'page') {
        await activeAnalyzer.analyzePage(pageId);
      } else {
        await activeAnalyzer.analyzeNote(noteId);
      }
      if (mountedRef.current) setRevision((n) => n + 1);
    } catch (error) {
      if (mountedRef.current) {
        setRunError(error instanceof Error ? error.message : String(error));
        console.error('[gaps] analysis run failed', error);
      }
    } finally {
      if (mountedRef.current) setRunning(null);
    }
  }

  const proposed = gaps.filter((g) => g.status === 'proposed');
  const accepted = gaps.filter((g) => g.status === 'accepted');
  const rejected = gaps.filter((g) => g.status === 'rejected');

  const speechWindow = page ? speechWindowForPage(page) : null;
  const eligible = page ? gapEligibility(page, recording, speechWindow) : null;
  const findGapsDisabled = running !== null || eligible?.ok !== true;
  const findGapsInNoteDisabled = running !== null || recording === null;

  const summarizedNotice =
    page?.gapAnalysis?.summarized === true || gaps.some((g) => g.summarized);

  const meta = page?.gapAnalysis;
  let statusLine: string | null = null;
  let statusIsError = false;
  if (!meta) {
    statusLine = 'Not analyzed yet.';
  } else if (meta.status === 'pending') {
    statusLine = 'Waiting to analyze…';
  } else if (meta.status === 'running') {
    statusLine = 'Looking for gaps…';
  } else if (meta.status === 'failed') {
    statusLine = `Gap analysis failed: ${meta.error}`;
    statusIsError = true;
  } else if (
    meta.status === 'done' &&
    proposed.length === 0 &&
    accepted.length === 0 &&
    rejected.length === 0
  ) {
    statusLine = 'No gaps found in the recording for this page.';
  }

  return (
    <section
      aria-label="Gaps"
      data-note-id={noteId}
      data-page-id={pageId}
      className="border-t border-border p-4"
    >
      <h3 className="text-sm font-medium">Gaps</h3>
      {loadError && <p className="mt-1 text-sm text-destructive">{loadError}</p>}

      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={findGapsDisabled}
          onClick={() => void run('page')}
        >
          Find gaps
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={findGapsInNoteDisabled}
          onClick={() => void run('note')}
        >
          Find gaps in note
        </Button>
      </div>

      {eligible && !eligible.ok && (
        <p className="mt-1 text-sm text-muted-foreground">{describeGapSkip(eligible.reason)}</p>
      )}

      {runError && <p className="mt-1 text-sm text-destructive">{runError}</p>}

      {statusLine && (
        <p className={`mt-1 text-sm ${statusIsError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {statusLine}
        </p>
      )}

      {summarizedNotice && (
        <p className="mt-1 text-sm text-muted-foreground">
          The speech was too long to compare directly, so it was summarized first — some detail
          may be lost.
        </p>
      )}

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
