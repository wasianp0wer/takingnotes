import { useEffect, useRef, useState } from 'react';

import type { GapAnalyzer } from '@/gaps/analyzer';
import { noteHasRecording, recordingForPage } from '@/gaps/analyzer';
import { GAP_LEAD_MS, GAP_TRAIL_MS } from '@/gaps/constants';
import { describeGapSkip, gapEligibility } from '@/gaps/eligibility';
import { runGapAnalysis, useGapRunActive } from '@/gaps/gapRuns';
import { reconcileDraft } from '@/gaps/reviewDraft';
import { createConfiguredGapAnalyzer } from '@/gaps/startGaps';
import { segmentsInWindow, speechTextOf, speechWindowForPage } from '@/gaps/window';
import { Button } from '@/components/ui/button';
import { GapReviewDialog } from '@/notes/GapReviewDialog';
import { listGapsByNote, listGapsByPage } from '@/storage/gaps';
import { getPage } from '@/storage/pages';
import { getSettingValue } from '@/storage/settingKeys';
import type { GapSuggestionRecord, PageRecord, RecordingRecord } from '@/storage/types';

// Kept importable from here for existing callers; the definition moved so the
// review dialog can share it.
export { GAP_KIND_LABELS } from '@/notes/SuggestionQuote';

export interface GapPanelProps {
  /** The note the page belongs to; gap suggestions are stored against both. */
  noteId: string;
  /** The page whose suggestions are listed. Remount per page, as `TranscriptPanel` does. */
  pageId: string;
  /**
   * Whether this note is the capture engine's active note. Submitting a review
   * appends a page, which would collide with the engine's next page, so the
   * dialog's Submit is disabled while it is. Defaults to false.
   */
  noteIsLive?: boolean;
  /** Tests only - a real mount builds one from settings. */
  analyzer?: GapAnalyzer;
}

/** Local time, so the source note reads like a clock rather than a raw epoch. */
function formatSourceWindow(win: { fromMs: number; toMs: number }): string {
  const from = new Date(win.fromMs).toLocaleTimeString();
  const to = new Date(win.toMs).toLocaleTimeString();
  return `Comparing against the recording from ${from} to ${to}.`;
}

/**
 * Gap suggestions from comparing a note's handwriting against its lecture
 * recordings (P1). `Find gaps` analyzes the whole note; `Review suggestions`
 * opens `GapReviewDialog`, where every proposed point in the note is accepted
 * or rejected and Submit appends the accepted ones as a separate typed page.
 * The panel itself shows this page's analysis status. Accepted text is never
 * merged into a handwriting page's `TranscriptRecord.markdown` (A24).
 *
 * P1 replaces the placeholder body and keeps the name and props. The
 * `aria-label` is the mount point the notes view asserts on, so it stays too.
 */
export function GapPanel({ noteId, pageId, noteIsLive = false, analyzer }: GapPanelProps) {
  const [page, setPage] = useState<PageRecord | null>(null);
  const [gaps, setGaps] = useState<GapSuggestionRecord[]>([]);
  // Every suggestion in the note, for the Review button's count.
  const [noteGaps, setNoteGaps] = useState<GapSuggestionRecord[]>([]);
  const [recording, setRecording] = useState<RecordingRecord | null>(null);
  // Whether the *note* has any finished recording at all - separate from
  // `recording` (this page's own, K45): the note-wide "Find gaps" may still
  // find a usable recording for some other page even when this one has none.
  const [noteRecorded, setNoteRecorded] = useState(false);
  // Fix round 1, Important 3: the window used for eligibility and for
  // picking a recording (K45) must use the same gaps.leadMs/gaps.trailMs a
  // real analyzer run would (createConfiguredGapAnalyzer reads them too) -
  // otherwise, with a non-default margin configured, "Find gaps" could read
  // available while the analyzer would actually skip the page (P1-A4).
  // Defaults match speechWindowForPage's own fallback, so nothing changes
  // for the common case where neither setting has been overridden.
  const [margins, setMargins] = useState<{ leadMs: number; trailMs: number }>({
    leadMs: GAP_LEAD_MS,
    trailMs: GAP_TRAIL_MS,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Module-level, not component state: the panel remounts per page, and a run
  // started on another page must still read as in flight here.
  const running = useGapRunActive(noteId);
  const [runError, setRunError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

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
    void (async () => {
      try {
        const [loadedPage, leadMs, trailMs] = await Promise.all([
          getPage(pageId),
          getSettingValue('gaps.leadMs'),
          getSettingValue('gaps.trailMs'),
        ]);
        // K45: the recording to show now depends on this page's own speech
        // window, so the page (and the configured margins) have to be read
        // before `recordingForPage` can be called.
        const window = loadedPage ? speechWindowForPage(loadedPage, { leadMs, trailMs }) : null;
        const [loadedGaps, loadedNoteGaps, loadedRecording, hasAnyRecording] = await Promise.all([
          listGapsByPage(pageId),
          listGapsByNote(noteId),
          recordingForPage(noteId, window),
          noteHasRecording(noteId),
        ]);
        if (!live) return;
        setPage(loadedPage ?? null);
        setGaps(loadedGaps);
        setNoteGaps(loadedNoteGaps);
        setRecording(loadedRecording);
        setNoteRecorded(hasAnyRecording);
        setMargins({ leadMs, trailMs });
      } catch (error) {
        if (!live) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
    // `running` too: a run - possibly started from another page's panel -
    // replaces rows and analysis status, so its end must reload them.
  }, [pageId, noteId, revision, running]);

  async function run() {
    // A press while a run is already in flight is a no-op: the button is
    // disabled for this, but a second press slipping through (a same-batch
    // double press, or a remount mid-run) must not start a second run on top
    // of it. `runGapAnalysis` marks the note synchronously, before any
    // `await`, and the mark lives at module level, so it holds across mounts.
    setRunError(null);
    try {
      await runGapAnalysis(noteId, async () => {
        try {
          const activeAnalyzer = analyzer ?? (await createConfiguredGapAnalyzer());
          await activeAnalyzer.analyzeNote(noteId);
        } finally {
          // The run replaced the note's proposed rows with new ids - even one
          // that failed part-way may have: move any unsubmitted review choices
          // onto their replacements before the run reads as finished.
          const proposedForNote = (await listGapsByNote(noteId)).filter(
            (g) => g.status === 'proposed',
          );
          reconcileDraft(noteId, proposedForNote);
        }
      });
    } catch (error) {
      if (mountedRef.current) {
        setRunError(error instanceof Error ? error.message : String(error));
        console.error('[gaps] analysis run failed', error);
      }
    }
  }

  const proposed = gaps.filter((g) => g.status === 'proposed');
  const proposedInNote = noteGaps.filter((g) => g.status === 'proposed').length;

  const speechWindow = page ? speechWindowForPage(page, margins) : null;
  const eligible = page ? gapEligibility(page, recording, speechWindow) : null;
  // Disabled while the dialog is open, so a run never replaces rows the user
  // is reviewing.
  const findGapsDisabled = running || !noteRecorded || dialogOpen;

  // Only a page that is genuinely comparable may claim a recording comparison.
  // A page with a stroke window but no recording (or one still transcribing)
  // has nothing to compare, so the present-tense source note would state a
  // falsehood - and read as a contradiction beside the skip sentence below it.
  const sourceWindow = eligible?.ok === true ? speechWindow : null;

  // The speech the analyzer would have compared, derived exactly as the
  // analyzer derives it. `''` means the window overlapped no speech at all: a
  // wrongly linked recording, a device clock that disagrees, a legacy import.
  // That is "nothing was compared", not "your notes are complete", and the two
  // must not share a sentence. `GapAnalysisMeta` has no field for it and
  // `src/storage/types.ts` is not P1's to extend, so it is derived, not stored.
  const windowSpeech =
    sourceWindow !== null && recording !== null
      ? speechTextOf(segmentsInWindow(recording, sourceWindow.fromMs, sourceWindow.toMs))
      : null;

  const meta = page?.gapAnalysis;
  // The lossy-source statement on the status line describes *this*
  // analysis, so it is gated on the analysis meta alone - not on whether any
  // listed suggestion (possibly from an earlier, different run) happens to
  // carry the flag. Each such suggestion gets its own small marker instead
  // (`SuggestionQuote`, in the review dialog), which cannot misdescribe a
  // run it was not part of.
  const summarizedNotice = meta?.summarized === true;

  let statusLine: string | null = null;
  let statusIsError = false;
  if (!meta) {
    statusLine = 'Not analyzed yet.';
  } else if (meta.status === 'pending') {
    statusLine = 'Waiting to analyze…';
  } else if (meta.status === 'running') {
    statusLine = 'Looking for gaps…';
  } else if (meta.status === 'failed') {
    statusLine = `Gap analysis failed: ${meta.error ?? 'unknown error'}`;
    statusIsError = true;
  } else if (meta.status === 'done' && windowSpeech === '') {
    // Checked before the "found nothing" line and regardless of how many
    // suggestions are listed: the analyzer keeps the page's proposals when the
    // window matched no speech, so this line is the only thing that explains a
    // run which changed nothing.
    statusLine = "The recording has no speech in this page's time window.";
  } else if (meta.status === 'done' && proposed.length === 0) {
    // "found nothing" means no *proposed* suggestions from this analysis -
    // an accepted or rejected leftover from an earlier run must not swallow
    // the line. It is only true because there was speech to compare.
    statusLine = 'No gaps found in the recording for this page.';
  }

  return (
    <section
      aria-label="Gaps"
      data-note-id={noteId}
      data-page-id={pageId}
      className="bg-surface p-4"
    >
      <h3 className="text-sm font-medium text-heading">Gaps</h3>
      {sourceWindow && (
        <p className="text-xs text-muted-foreground">{formatSourceWindow(sourceWindow)}</p>
      )}
      {loadError && <p className="mt-1 text-sm text-destructive">{loadError}</p>}

      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={findGapsDisabled}
          onClick={() => void run()}
        >
          Find gaps
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={proposedInNote === 0 || running}
          onClick={() => setDialogOpen(true)}
        >
          {proposedInNote === 0 ? 'Review suggestions' : `Review suggestions (${proposedInNote})`}
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

      <GapReviewDialog
        noteId={noteId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        noteIsLive={noteIsLive}
        running={running}
        onSubmitted={() => setRevision((n) => n + 1)}
      />
    </section>
  );
}
