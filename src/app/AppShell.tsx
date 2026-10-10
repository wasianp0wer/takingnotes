import { useCallback, useEffect, useState } from 'react';

import { DeviceStatus } from '@/app/DeviceStatus';
import { SettingsDialog } from '@/app/SettingsDialog';
import { RecorderControl } from '@/audio/RecorderControl';
import { SessionControls } from '@/capture/SessionControls';
import { usePageTurnCapture } from '@/capture/usePageTurnCapture';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHuionDevice } from '@/device/TabletProvider';
import { NotesView } from '@/notes/NotesView';
import { RecordingsView } from '@/recordings/RecordingsView';
import { SearchView } from '@/search/SearchView';
import { migrateLegacyNotebooks } from '@/storage/migrate';
import { TriageView } from '@/triage/TriageView';

/**
 * Module-level rather than a ref: StrictMode mounts every component twice in
 * development, and the migration is only idempotent *between* runs (it checks a
 * setting written at the end). Two overlapping runs would both see the setting
 * unset and import the library twice.
 */
let migrationStarted = false;

/**
 * Fix round 1, Finding 1: the one target a Search hit can be navigating to
 * right now, tagged with the tab it belongs to so `AppShell` only ever
 * passes `external` to the view it names. `token` is bumped on every
 * request, including a repeat of the exact same note+page or recording -
 * `NotesView`/`RecordingsView` apply a request once per token, so without
 * a fresh token a second click on the same hit would silently do nothing
 * (the view has already "seen" that noteId+pageIndex before).
 */
interface NoteNavigationTarget {
  kind: 'note';
  token: number;
  noteId: string;
  pageIndex: number;
}
interface RecordingNavigationTarget {
  kind: 'recording';
  token: number;
  recordingId: string;
  startMs?: number;
}
type NavigationTarget = NoteNavigationTarget | RecordingNavigationTarget;

/**
 * Fix round 2: the token bump itself, pulled out of `AppShell`'s render
 * body into a plain, directly-testable function. The coordinator's review
 * found that nothing proved `AppShell` actually issues a fresh token per
 * click — the contract was tested on `NotesView`'s side (it re-applies
 * when the token changes) but not on this side (that the token really
 * does change). A click-through test cannot close that gap here: both
 * `NotesView` and `RecordingsView` are remounted fresh by Radix's
 * `TabsContent` every time `AppShell` switches back to their tab (the same
 * fact fix round 1 relied on to show the two render branches there never
 * fight each other), so a *fresh* mount re-applies an `external` prop
 * regardless of its token - a frozen token is invisible to any test that
 * goes through a real tab round-trip, since the downstream view's own
 * "already applied" bookkeeping is wiped by the remount before the second
 * delivery ever reaches it. Confirmed empirically, not just reasoned:
 * freezing the bump left a full click-away-and-back `AppShell` test green.
 * This factory is the seam that makes the bump itself assertable: `.note`/
 * `.recording` are literally the two bodies `openNote`/`openRecording`
 * below call, so testing this directly tests whether `AppShell` would
 * ever hand out a repeated token, independent of whether anything
 * downstream happens to mask the consequence today.
 */
export function createNavigationTargetFactory() {
  let token = 0;
  return {
    note(noteId: string, pageIndex: number): NoteNavigationTarget {
      token += 1;
      return { kind: 'note', token, noteId, pageIndex };
    },
    recording(recordingId: string, startMs?: number): RecordingNavigationTarget {
      token += 1;
      return { kind: 'recording', token, recordingId, startMs };
    },
  };
}

function useLegacyMigration(): void {
  useEffect(() => {
    if (migrationStarted) return;
    migrationStarted = true;
    // Fire-and-forget (A18): the notes list is usable while this runs, and a
    // failed import stays retryable on the next load.
    void migrateLegacyNotebooks().catch((error: unknown) => {
      console.error('[app] legacy notebook migration failed', error);
    });
  }, []);
}

export function AppShell() {
  const { controller, state } = useHuionDevice();
  const [tab, setTab] = useState('notes');
  // Fix round 1, Finding 1: the pending cross-tab navigation request from a
  // Search hit's "Open", if any. Cleared once the target view reports it
  // applied, so a later, unrelated switch to that tab (e.g. clicking "Notes"
  // directly) never re-triggers a stale request.
  const [navigationTarget, setNavigationTarget] = useState<NavigationTarget | null>(null);
  // Built once; see `createNavigationTargetFactory`'s own comment for why
  // the bump lives there rather than inline here.
  const [navigationTargets] = useState(createNavigationTargetFactory);

  // Mounted exactly once, here: it owns the controller's capture lifecycle
  // (page-turn polling, liveness, reconnect), and a second copy would fight it.
  usePageTurnCapture();
  useLegacyMigration();

  function openNote(noteId: string, pageIndex: number): void {
    setNavigationTarget(navigationTargets.note(noteId, pageIndex));
    setTab('notes');
  }

  function openRecording(recordingId: string, startMs?: number): void {
    setNavigationTarget(navigationTargets.recording(recordingId, startMs));
    setTab('recordings');
  }

  // Stable identity (`[]` deps): `RecordingsView`'s `load` depends on this
  // callback to know when a *new* request has arrived versus an unrelated
  // re-render, so a fresh function every render here would make it
  // resubscribe (and reload) far more than necessary.
  const clearNavigationTarget = useCallback(() => setNavigationTarget(null), []);

  const noteTarget = navigationTarget?.kind === 'note' ? navigationTarget : undefined;
  const recordingTarget = navigationTarget?.kind === 'recording' ? navigationTarget : undefined;

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">TakingNotes</span>
        <DeviceStatus controller={controller} state={state} />
        <TabsList className="w-auto">
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="recordings">Recordings</TabsTrigger>
          <TabsTrigger value="triage">Triage</TabsTrigger>
          {/* K39: its own tab, since it spans both Notes and Recordings. */}
          <TabsTrigger value="search">Search</TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          {/* P3's only mount point (docs/architecture.md §6.7). */}
          <SessionControls />
          <RecorderControl />
          <SettingsDialog />
        </div>
      </header>

      <TabsContent value="notes" className="min-h-0 overflow-auto">
        <NotesView external={noteTarget} onExternalSelectionApplied={clearNavigationTarget} />
      </TabsContent>
      <TabsContent value="recordings" className="min-h-0 overflow-auto">
        <RecordingsView external={recordingTarget} onExternalSelectionApplied={clearNavigationTarget} />
      </TabsContent>
      <TabsContent value="triage" className="min-h-0 overflow-auto">
        <TriageView />
      </TabsContent>
      <TabsContent value="search" className="min-h-0 overflow-auto">
        {/*
         * Fix round 1, Finding 1: a Search hit's "Open" now selects the
         * actual note+page or recording it names, not just the tab -
         * `openNote`/`openRecording` above hand the target to the view
         * that owns it, with a fresh token per request (see
         * `NavigationTarget`'s own comment for why the token matters).
         */}
        <SearchView onOpenNotes={openNote} onOpenRecordings={openRecording} />
      </TabsContent>
    </Tabs>
  );
}
