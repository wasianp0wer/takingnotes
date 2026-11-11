import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { LazyTranscriptMarkdown } from '@/notes/LazyTranscriptMarkdown';
import { OllamaSetupStatus } from '@/notes/OllamaSetupStatus';
import { isPageFinalized } from '@/storage/pages';
import type { PageRecord, TranscriptRecord } from '@/storage/types';

/**
 * Shown only for the active *live* page before it is finalized - never for a
 * typed page, whose transcript is written synchronously by `setPageText`
 * (K33), not by the transcription queue this message describes. Exported
 * (fix round 2, Fix 4) so the test asserting its absence for a typed page
 * checks against this constant rather than a copy-pasted literal: a test
 * that keeps a hardcoded copy of the string stays green even after a wording
 * change silently stops it from ever matching anything, which is exactly how
 * the regression it exists to guard would return unnoticed.
 */
export const PAGE_TRANSCRIBING_MESSAGE = "This page's handwriting will be transcribed once it's finished.";

export interface TranscriptPanelProps {
  page: PageRecord;
  /** True when this is the page the engine is currently writing to. */
  isActivePage: boolean;
  /** Resolves `false` when the page was already queued or running - see below. */
  onRetry: (pageId: string) => Promise<boolean>;
}

/**
 * The queue keeps a page's previous `markdown` in the record while it is
 * `pending`, `running` or `failed` - a retry that fails must not destroy the
 * only copy of an earlier transcript (see `writeTranscript` in
 * `transcription/queue.ts`). Surfacing it here, muted and clearly labelled as
 * stale, is what makes that retained text visible instead of it sitting
 * invisible in storage until a later success overwrites it.
 */
function PreviousTranscript({ transcript }: { transcript: TranscriptRecord }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 pt-2">
      <p className="shrink-0 text-xs font-medium text-muted-foreground">Previous transcript</p>
      <div className="min-h-0 flex-1 overflow-auto border border-border p-3 font-transcript text-base leading-relaxed text-muted-foreground">
        <LazyTranscriptMarkdown markdown={transcript.markdown} />
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">
        {transcript.model} · {transcript.promptVersion}
      </p>
    </div>
  );
}

/**
 * The transcript for one page: status, the markdown (rendered with maths by
 * `TranscriptMarkdown`, which supersedes F1-A4's plain text), and the manual
 * retry path for a failed or never-queued (legacy) page.
 */
export function TranscriptPanel({ page, isActivePage, onRetry }: TranscriptPanelProps) {
  // Feedback for a Retry/Transcribe press that the queue silently swallowed
  // (already queued or running) so the press is never a no-op the user can't
  // tell happened. Cleared only once a press actually queues the page.
  const [notice, setNotice] = useState<string | null>(null);

  function retry() {
    onRetry(page.id)
      .then((queued) => {
        setNotice(queued ? null : 'Already queued.');
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
  }

  if (isActivePage && !isPageFinalized(page)) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {PAGE_TRANSCRIBING_MESSAGE}
      </div>
    );
  }

  const transcript = page.transcript;

  if (transcript === null) {
    return (
      <div className="space-y-2 p-4">
        <p className="text-sm text-muted-foreground">This page has not been transcribed yet.</p>
        <Button variant="outline" size="sm" onClick={() => retry()}>
          Transcribe
        </Button>
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
    );
  }

  if (transcript.status === 'pending' || transcript.status === 'running') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <p className="shrink-0 text-sm text-muted-foreground">
          {transcript.status === 'pending' ? 'Waiting to transcribe…' : 'Transcribing…'}
        </p>
        {transcript.markdown && <PreviousTranscript transcript={transcript} />}
      </div>
    );
  }

  if (transcript.status === 'failed') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <p className="shrink-0 text-sm text-destructive">Transcription failed: {transcript.error}</p>
        <OllamaSetupStatus compact />
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => retry()}>
            Retry
          </Button>
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        </div>
        {transcript.markdown && <PreviousTranscript transcript={transcript} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
      {/* Framed and set in the theme's transcript font, so the transcribed
          handwriting reads as content rather than as part of the interface.
          It fills a set area and scrolls inside it rather than growing with
          the text (owner, 2026-10-20). */}
      <div
        data-transcript-text
        className="min-h-0 flex-1 overflow-auto border border-border bg-background p-3 font-transcript text-base leading-relaxed"
      >
        {transcript.markdown ? <LazyTranscriptMarkdown markdown={transcript.markdown} /> : 'Blank page'}
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">
        {transcript.model} · {transcript.promptVersion}
      </p>
    </div>
  );
}
