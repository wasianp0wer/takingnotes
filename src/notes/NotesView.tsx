import { PageTurnControls } from '@/capture/PageTurnControls';

/**
 * Phase 0 placeholder for F1: note list, the current page as plain black ink in
 * real time, a transcript panel beside it, and page navigation within a note.
 *
 * Whatever F1 builds here must keep rendering `<PageTurnControls />` in the page
 * toolbar - that is F4's only mount point (docs/architecture.md §4).
 */
export function NotesView() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <span className="text-sm text-muted-foreground">No note yet</span>
        <PageTurnControls />
      </div>
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          Notes arrive with F1: write on the pad and the ink shows up here, with each
          finished page transcribed beside it.
        </p>
      </div>
    </div>
  );
}
