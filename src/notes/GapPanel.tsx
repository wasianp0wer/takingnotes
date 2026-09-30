export interface GapPanelProps {
  /** The note the page belongs to; gap suggestions are stored against both. */
  noteId: string;
  /** The page whose suggestions are listed. Remount per page, as `TranscriptPanel` does. */
  pageId: string;
}

/**
 * Phase 2 placeholder for P1: "Find gaps" for the page, then its suggestions -
 * each with its kind and the verbatim speech behind it - accepted or rejected
 * one at a time. Accepted text is recording-derived content attached to the
 * page and never enters `TranscriptRecord.markdown` (A24).
 *
 * P1 replaces the body and keeps the name and props. The `aria-label` is the
 * mount point the notes view asserts on, so it stays too.
 */
export function GapPanel({ noteId, pageId }: GapPanelProps) {
  return (
    // The ids are carried as data attributes until P1 uses them, so the mount
    // point is checkable in the DOM rather than merely present.
    <section
      aria-label="Gaps"
      data-note-id={noteId}
      data-page-id={pageId}
      className="border-t border-border p-4"
    >
      <h3 className="text-sm font-medium">Gaps</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Finding what the recording covered and the page missed arrives with P1.
      </p>
    </section>
  );
}
