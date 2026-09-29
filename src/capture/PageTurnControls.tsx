import { useEffect, useRef, useState } from 'react';

import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
import { isPageTurn, PAGE_INDICATOR_MS } from '@/capture/pageTurnIndicator';
import { Button } from '@/components/ui/button';

/**
 * F4 (docs/architecture.md §3.5), mounted in the NotesView page toolbar: the
 * on-screen "New page" button - the fallback for when the pad is not reporting
 * turns (A9: pressing it and turning the paper page makes two pages) - and a
 * transient "Page N" indicator shown after any page turn in the active note.
 */
export function PageTurnControls() {
  const engine = useCaptureEngine();
  const { activeNoteId } = useCaptureState();
  const [pending, setPending] = useState(false);
  const [shownPage, setShownPage] = useState<number | null>(null);
  // Guards the gap between a click and the re-render that disables the button.
  const inFlight = useRef(false);

  // Subscribed directly rather than derived from useCaptureState in an effect:
  // the state change itself is the event, and setState happens in the
  // subscription callback rather than synchronously in the effect body.
  useEffect(() => {
    let previous = engine.getState();
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = engine.subscribe((next) => {
      const turned = isPageTurn(previous, next);
      previous = next;
      if (!turned) return;
      setShownPage(next.pageIndex + 1);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        setShownPage(null);
      }, PAGE_INDICATOR_MS);
    });
    return () => {
      unsubscribe();
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [engine]);

  async function newPage() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await engine.newPage('manual');
    } catch (error) {
      console.error('[page-turn] manual new page failed', error);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        aria-live="polite"
        className="text-xs font-medium tabular-nums text-muted-foreground"
      >
        {shownPage !== null ? `Page ${shownPage}` : ''}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={activeNoteId === null || pending}
        title={activeNoteId === null ? 'Start writing to begin a note' : 'Finish this page and start a new one'}
        onClick={() => void newPage()}
      >
        New page
      </Button>
    </div>
  );
}
