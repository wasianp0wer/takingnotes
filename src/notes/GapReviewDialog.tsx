import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatOffset, quoteRange, submitGapReview, type GapDecision } from '@/gaps/gapPage';
import { clearDraft, getDraft, setDraftChoice } from '@/gaps/reviewDraft';
import { SuggestionQuote } from '@/notes/SuggestionQuote';
import { listGapsByNote } from '@/storage/gaps';
import { getRecording } from '@/storage/recordings';
import type { GapSuggestionRecord, RecordingRecord } from '@/storage/types';

export interface GapReviewDialogProps {
  noteId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Submit is disabled with an explanation while the note is being captured. */
  noteIsLive: boolean;
  /** Submit is disabled while a gap run is in flight. */
  running: boolean;
  /** Called after a successful submit, so the panel reloads. */
  onSubmitted(): void;
}

interface Row {
  gap: GapSuggestionRecord;
  recording: RecordingRecord | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every proposed gap suggestion in the note, each with Accept/Reject toggles.
 * Choices are a draft held in memory (`reviewDraft`), so closing the dialog
 * keeps them; nothing is written until Submit, which saves the decisions and
 * appends the accepted ones to the note as a typed page.
 */
export function GapReviewDialog({
  noteId,
  open,
  onOpenChange,
  noteIsLive,
  running,
  onSubmitted,
}: GapReviewDialogProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [choices, setChoices] = useState<Map<string, GapDecision>>(() => new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Same reasoning as `GapPanel`'s `runningRef`: two clicks in one batch both
  // see `submitting === false`, so the guard must mutate synchronously.
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      try {
        const proposed = (await listGapsByNote(noteId)).filter((g) => g.status === 'proposed');
        const recordingIds = [...new Set(proposed.map((g) => g.recordingId))];
        const recordings = new Map<string, RecordingRecord>();
        for (const id of recordingIds) {
          const recording = await getRecording(id);
          if (recording) recordings.set(id, recording);
        }
        if (!live) return;
        // The draft is read on every open, so choices survive a close.
        setChoices(getDraft(noteId));
        setSubmitError(null);
        setLoadError(null);
        setRows(proposed.map((gap) => ({ gap, recording: recordings.get(gap.recordingId) ?? null })));
      } catch (error) {
        if (live) setLoadError(errorText(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [open, noteId]);

  function toggle(gap: GapSuggestionRecord, decision: GapDecision) {
    const next = choices.get(gap.id) === decision ? null : decision;
    setDraftChoice(noteId, gap, next);
    setChoices(getDraft(noteId));
  }

  async function submit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Only rows shown here: a stale draft entry for a row that no longer
      // exists must not fail the whole submit.
      const decisions = new Map<string, GapDecision>();
      for (const { gap } of rows) {
        const decision = choices.get(gap.id);
        if (decision) decisions.set(gap.id, decision);
      }
      await submitGapReview(noteId, decisions);
      clearDraft(noteId);
      onSubmitted();
      onOpenChange(false);
    } catch (error) {
      setSubmitError(errorText(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review suggestions</DialogTitle>
          <DialogDescription>
            Accept or reject each point. Accepted points are added to the note as a new page when
            you submit; undecided ones stay for next time.
          </DialogDescription>
        </DialogHeader>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        <ul className="max-h-[60vh] space-y-3 overflow-auto">
          {rows.map(({ gap, recording }) => {
            const choice = choices.get(gap.id);
            const range = recording ? quoteRange(gap, recording) : null;
            return (
              <li key={gap.id} data-gap-row={gap.id} className="space-y-1 bg-muted p-2">
                <SuggestionQuote suggestion={gap} />
                {recording && range && (
                  <p className="text-xs text-muted-foreground">
                    — {recording.title}, {formatOffset(range.startMs)}–{formatOffset(range.endMs)}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    variant={choice === 'accepted' ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={choice === 'accepted'}
                    onClick={() => toggle(gap, 'accepted')}
                  >
                    Accept
                  </Button>
                  <Button
                    variant={choice === 'rejected' ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={choice === 'rejected'}
                    onClick={() => toggle(gap, 'rejected')}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        {noteIsLive && (
          <p className="text-sm text-muted-foreground">
            The page will be added once this note ends.
          </p>
        )}
        {submitError && <p className="text-sm text-destructive">{submitError}</p>}

        <DialogFooter>
          <Button disabled={noteIsLive || running || submitting} onClick={() => void submit()}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
