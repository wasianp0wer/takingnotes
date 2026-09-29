import { useEffect, useState } from 'react';

import { DeviceStatus } from '@/app/DeviceStatus';
import { SettingsDialog } from '@/app/SettingsDialog';
import { RecorderControl } from '@/audio/RecorderControl';
import { usePageTurnCapture } from '@/capture/usePageTurnCapture';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHuionDevice } from '@/device/TabletProvider';
import { NotesView } from '@/notes/NotesView';
import { RecordingsView } from '@/recordings/RecordingsView';
import { migrateLegacyNotebooks } from '@/storage/migrate';
import { TriageView } from '@/triage/TriageView';

/**
 * Module-level rather than a ref: StrictMode mounts every component twice in
 * development, and the migration is only idempotent *between* runs (it checks a
 * setting written at the end). Two overlapping runs would both see the setting
 * unset and import the library twice.
 */
let migrationStarted = false;

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

  // Mounted exactly once, here: it owns the controller's capture lifecycle
  // (page-turn polling, liveness, reconnect), and a second copy would fight it.
  usePageTurnCapture();
  useLegacyMigration();

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
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          <RecorderControl />
          <SettingsDialog />
        </div>
      </header>

      <TabsContent value="notes" className="min-h-0 overflow-auto">
        <NotesView />
      </TabsContent>
      <TabsContent value="recordings" className="min-h-0 overflow-auto">
        <RecordingsView />
      </TabsContent>
      <TabsContent value="triage" className="min-h-0 overflow-auto">
        <TriageView />
      </TabsContent>
    </Tabs>
  );
}
