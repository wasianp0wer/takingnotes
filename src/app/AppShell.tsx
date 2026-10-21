import { useEffect, useState, useSyncExternalStore } from 'react';

import { DeviceStatus } from '@/app/DeviceStatus';
import { SettingsDialog } from '@/app/SettingsDialog';
import { RecorderControl } from '@/audio/RecorderControl';
import { SessionControls } from '@/capture/SessionControls';
import { usePageTurnCapture } from '@/capture/usePageTurnCapture';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHuionDevice } from '@/device/TabletProvider';
import { SessionsUiProvider } from '@/sessions/SessionsUiContext';
import { SessionsView } from '@/sessions/SessionsView';
import { createSessionsUiStore } from '@/sessions/sessionsUiStore';
import type { MainTab } from '@/sessions/sessionsUiStore';
import { useLiveFollow } from '@/sessions/useLiveFollow';
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

/** `localStorage`, or null where touching it throws (blocked site data, some private modes). */
export function safeLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return typeof storage?.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

const TAB_CONTENT_CLASS = 'min-h-0 overflow-auto data-[state=inactive]:hidden';

export function AppShell() {
  const { controller, state } = useHuionDevice();
  // One store for the app's lifetime: the Sessions view's selection, page,
  // recording and mode live here, above the tabs, so a tab switch never loses
  // them, and the persisted part survives a reload.
  const [store] = useState(() => createSessionsUiStore(safeLocalStorage()));
  const tab = useSyncExternalStore(store.subscribe, () => store.getState().tab);

  // Mounted exactly once, here: it owns the controller's capture lifecycle
  // (page-turn polling, liveness, reconnect), and a second copy would fight it.
  usePageTurnCapture();
  useLegacyMigration();
  // Live capture wins over the saved selection, from either tab.
  useLiveFollow(store);

  return (
    <SessionsUiProvider store={store}>
      <Tabs
        value={tab}
        onValueChange={(value) => store.setTab(value as MainTab)}
        className="flex h-full min-h-0 flex-col bg-background text-foreground"
      >
        <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 bg-surface px-4 py-2">
          <span className="text-sm font-semibold tracking-tight">TakingNotes</span>
          <div className="flex items-center justify-center gap-4">
            <TabsList className="w-auto">
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="triage">Triage</TabsTrigger>
            </TabsList>
            {/* P3's only mount point (docs/architecture.md §6.7). */}
            <SessionControls />
          </div>
          <div className="flex items-center justify-end gap-2">
            {/* Search slot: the header's quick search lands here. */}
            <div data-slot="header-search" />
            <DeviceStatus controller={controller} state={state} />
            <RecorderControl />
            <SettingsDialog />
          </div>
        </header>

        {/* Both panels stay mounted and are only hidden, so neither view
            remounts (and loses its loaded data or editor state) on a switch. */}
        <TabsContent value="sessions" forceMount className={TAB_CONTENT_CLASS}>
          <SessionsView />
        </TabsContent>
        <TabsContent value="triage" forceMount className={TAB_CONTENT_CLASS}>
          <TriageView />
        </TabsContent>
      </Tabs>
    </SessionsUiProvider>
  );
}
