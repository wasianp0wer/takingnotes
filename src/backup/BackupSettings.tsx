import { useRef, useState } from 'react';

import { backupFileName, exportBackup } from '@/backup/exportBackup';
import { BackupFormatError } from '@/backup/format';
import { ImportBlockedError, type ImportBlocker } from '@/backup/guards';
import {
  BackupTooNewError,
  importBackup,
  inspectBackup,
  type BackupSummary,
} from '@/backup/importBackup';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

export interface BackupDeps {
  exportBackup: (opts: { appVersion: string }) => Promise<Blob>;
  backupFileName: (now: number) => string;
  inspectBackup: (file: File) => Promise<BackupSummary>;
  importBackup: (
    file: File,
    opts: { onProgress?: (done: number, total: number) => void },
  ) => Promise<void>;
}

const DEFAULT_DEPS: BackupDeps = { exportBackup, backupFileName, inspectBackup, importBackup };

const BLOCKER_MESSAGES: Record<ImportBlocker, string> = {
  'other-tabs': 'Close other TakingNotes tabs first.',
  'session-active': 'End the active session first.',
  'recording-active': 'Stop the recording first.',
  'transcription-running': 'Wait for transcription to finish, or pause it.',
  'storage-blocked': "This browser is blocking site storage, so a backup can't be switched in.",
};

const NOT_A_BACKUP = "That file isn't a TakingNotes backup, or it's incomplete.";
const TOO_NEW = 'This backup is from a newer version of TakingNotes. Update the app first.';

function errorMessages(error: unknown): string[] {
  if (error instanceof ImportBlockedError) return error.blockers.map((b) => BLOCKER_MESSAGES[b]);
  if (error instanceof BackupFormatError) return [NOT_A_BACKUP];
  if (error instanceof BackupTooNewError) return [TOO_NEW];
  return [error instanceof Error ? error.message : 'Something went wrong.'];
}

const COUNT_LABELS: [string, string][] = [
  ['notes', 'notes'],
  ['pages', 'pages'],
  ['recordings', 'recordings'],
  ['sessions', 'sessions'],
];

/** Settings section: export everything to a `.tnbackup`, or replace everything from one. */
export function BackupSettings({
  deps = DEFAULT_DEPS,
  reload = () => location.reload(),
}: {
  deps?: BackupDeps;
  reload?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ file: File; summary: BackupSummary } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function doExport() {
    setErrors([]);
    setBusy(true);
    try {
      const blob = await deps.exportBackup({ appVersion: __APP_VERSION__ });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = deps.backupFileName(Date.now());
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrors(errorMessages(error));
    } finally {
      setBusy(false);
    }
  }

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setErrors([]);
    setPending(null);
    setBusy(true);
    try {
      setPending({ file, summary: await deps.inspectBackup(file) });
    } catch (error) {
      setErrors(errorMessages(error));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!pending) return;
    setErrors([]);
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      await deps.importBackup(pending.file, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      reload();
    } catch (error) {
      setErrors(errorMessages(error));
      setProgress(null);
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Backup</h3>
      <p className="text-xs text-muted-foreground">TakingNotes {__APP_VERSION__}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void doExport()}>
          Export backup…
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          Import backup…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".tnbackup"
          className="hidden"
          aria-label="Backup file"
          onChange={(event) => void onPick(event)}
        />
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs text-destructive">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>
            Exported {new Date(pending.summary.exportedAt).toLocaleString()} by TakingNotes{' '}
            {pending.summary.appVersion}
          </p>
          <ul className="text-xs text-muted-foreground">
            {COUNT_LABELS.map(([key, label]) => (
              <li key={key}>
                {pending.summary.counts[key] ?? 0} {label}
              </li>
            ))}
          </ul>
          <p className="text-xs">
            This replaces everything currently in TakingNotes. Export a backup first if you want
            to keep it.
          </p>
          {progress && (
            <div className="space-y-1">
              <p role="status" className="text-xs text-muted-foreground">
                Importing… {progress.done} of {progress.total}
              </p>
              <Progress
                value={progress.total ? (progress.done / progress.total) * 100 : 0}
              />
            </div>
          )}
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void doImport()}>
            Replace and import
          </Button>
        </div>
      )}
    </section>
  );
}
