import { Button } from '@/components/ui/button';

/**
 * Phase 0 placeholder for F4 (docs/architecture.md §3.5): the on-screen "New
 * page" button (`newPage('manual')`) plus a transient "Page N" indicator. It is
 * mounted in the NotesView page toolbar; F4 replaces the body and keeps the name.
 */
export function PageTurnControls() {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled title="Arrives with F4">
        New page
      </Button>
    </div>
  );
}
