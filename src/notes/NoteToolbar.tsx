import type { ReactNode } from 'react';

import { PageTurnControls } from '@/capture/PageTurnControls';
import { Button } from '@/components/ui/button';

export interface NoteToolbarProps {
  /** **Wave 2 mount point**: S4's "Type page" button. Rendered before page navigation. */
  actions?: ReactNode;
  /**
   * K15: a session locks you into its note, so New note is disabled. End note
   * deliberately stays enabled - ending must never be reachable only by reload.
   */
  sessionLocked: boolean;
  hasActiveNote: boolean;
  onNewNote: () => void;
  onEndNote: () => void;
  pageCount: number;
  viewedIndex: number;
  onGoToPage: (index: number) => void;
}

/**
 * The notes half's toolbar: New note / End note, the `actions` slot (Type
 * page), F4's page-turn controls and the centred page navigation. The title,
 * tags and the K16 banner live in `SessionHeader`.
 */
export function NoteToolbar({
  actions,
  sessionLocked,
  hasActiveNote,
  onNewNote,
  onEndNote,
  pageCount,
  viewedIndex,
  onGoToPage,
}: NoteToolbarProps) {
  return (
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={sessionLocked} onClick={onNewNote}>
            New note
          </Button>
          <Button variant="outline" size="sm" disabled={!hasActiveNote} onClick={onEndNote}>
            End note
          </Button>
          {actions}
          {/* F4's only mount point (docs/architecture.md §4) - must stay mounted. */}
          <PageTurnControls />
        </div>
      </div>
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
