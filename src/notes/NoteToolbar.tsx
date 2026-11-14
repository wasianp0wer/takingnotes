import { Button } from '@/components/ui/button';

export interface NoteToolbarProps {
  pageCount: number;
  viewedIndex: number;
  onGoToPage: (index: number) => void;
}

/**
 * The notes half's page navigation. The icon controls (Type page, New page)
 * live beside the Handwriting / Transcription switch in `NotesHalf`; the title,
 * tags and the K16 banner live in `SessionHeader`.
 */
export function NoteToolbar({ pageCount, viewedIndex, onGoToPage }: NoteToolbarProps) {
  return (
    <div className="flex flex-col">
      {pageCount > 0 && (
        <div className="flex items-center justify-center gap-2 px-4 py-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={viewedIndex <= 0}
            onClick={() => onGoToPage(viewedIndex - 1)}
          >
            ‹
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {viewedIndex + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={viewedIndex >= pageCount - 1}
            onClick={() => onGoToPage(viewedIndex + 1)}
          >
            ›
          </Button>
        </div>
      )}
    </div>
  );
}
