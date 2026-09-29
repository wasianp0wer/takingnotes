import { createNote, deleteNote, listNotes } from '@/storage/notes';
import { createPage } from '@/storage/pages';
import { getSetting, setSetting } from '@/storage/settings';
import type { DeviceType, PageStroke, StrokePoint } from '@/storage/types';

/** Written by the studio app at src/App.tsx:853. */
export const LEGACY_STORAGE_KEY = 'takingnotes_downloaded_memory';
export const MIGRATION_SETTING_KEY = 'legacyMigratedAt';

export interface MigrationResult {
  imported: number;
  pages: number;
  /** Notebooks that threw and were rolled back; they stay retryable. */
  failed: number;
  /** True when the migration had already run and was not repeated. */
  skipped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // `typeof [] === 'object'`, and an array would otherwise pass every field
  // lookup as `undefined` and fabricate a junk note.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toDeviceType(value: unknown): DeviceType {
  return value === 'wacom' ? 'wacom' : 'huion';
}

function toStrokes(value: unknown): PageStroke[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((stroke): PageStroke[] => {
    if (!isRecord(stroke) || !Array.isArray(stroke.points)) return [];

    const points = stroke.points.flatMap((point): StrokePoint[] => {
      if (!isRecord(point)) return [];
      // A coordinate that is not a finite number is unrecoverable. Defaulting
      // it to 0 would silently move the point to the top-left corner, so the
      // point is dropped instead. Pressure is cosmetic and may be defaulted.
      const x = toOptionalNumber(point.x);
      const y = toOptionalNumber(point.y);
      if (x === null || y === null) return [];
      return [{ x, y, pressure: toNumber(point.pressure, 0.5) }];
    });

    return points.length > 0 ? [{ points }] : [];
  });
}

/**
 * One-shot import of the pre-existing localStorage notebook library.
 * Never removes the localStorage key - it remains the only other copy.
 */
export async function migrateLegacyNotebooks(
  storage: Storage = globalThis.localStorage,
): Promise<MigrationResult> {
  const alreadyRan = await getSetting(MIGRATION_SETTING_KEY, 0);
  if (alreadyRan > 0) {
    return { imported: 0, pages: 0, failed: 0, skipped: true };
  }

  // A *missing* key is not a failure - there is simply nothing to migrate, and
  // the migration should be marked done. Anything we cannot read as a notebook
  // array - unparseable JSON, or valid JSON of the wrong shape - is a failure
  // and must stay retryable, or the library is stranded forever.
  let notebooks: unknown[] = [];
  let sourceReadable = true;
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) {
      notebooks = parsed;
    } else {
      sourceReadable = false;
    }
  } catch {
    sourceReadable = false;
  }

  // Natural keys of notebooks a previous (failed) run already imported. Read
  // once, before the loop, so the import is idempotent without re-querying.
  const alreadyImported = new Set(
    (await listNotes())
      .map((note) => note.legacySourceId)
      .filter((sourceId): sourceId is string => sourceId !== null),
  );

  let imported = 0;
  let pages = 0;
  let failed = 0;

  for (const notebook of notebooks) {
    if (!isRecord(notebook)) continue;

    const sourceId =
      typeof notebook.id === 'string' && notebook.id.length > 0 ? notebook.id : null;
    if (sourceId !== null && alreadyImported.has(sourceId)) continue;

    // One unimportable notebook must not abort the whole library. A notebook
    // that fails partway is rolled back so the retry re-imports it cleanly.
    let noteId: string | null = null;
    try {
      const downloadedAt = toNumber(notebook.downloadedAt, Date.now());
      const title =
        typeof notebook.notebookName === 'string' && notebook.notebookName.trim().length > 0
          ? notebook.notebookName
          : 'Imported notebook';
      const deviceId =
        typeof notebook.notebookUuid === 'string' ? notebook.notebookUuid : 'unknown';

      const note = await createNote({
        title,
        deviceId,
        pageBaseline: 0,
        deviceType: toDeviceType(notebook.deviceType),
        deviceName: typeof notebook.deviceName === 'string' ? notebook.deviceName : null,
        pageWidth: toOptionalNumber(notebook.pageWidth),
        pageHeight: toOptionalNumber(notebook.pageHeight),
        status: 'complete',
        startedAt: downloadedAt,
        endedAt: downloadedAt,
        legacy: true,
        legacySourceId: sourceId,
      });
      noteId = note.id;

      const legacyPages = Array.isArray(notebook.pages) ? notebook.pages : [];
      let notebookPages = 0;
      for (const [pageIndex, legacyPage] of legacyPages.entries()) {
        if (!isRecord(legacyPage)) continue;
        const capturedAt = toNumber(legacyPage.timestamp, downloadedAt);
        await createPage({
          noteId: note.id,
          pageIndex,
          devicePageNum: toNumber(legacyPage.pageNum, pageIndex),
          source: 'rom',
          strokes: toStrokes(legacyPage.strokes),
          capturedAt,
          // An imported ROM page is complete; without this it would look like a
          // page still being written and startup recovery would "finalize" it.
          finalizedAt: capturedAt,
        });
        notebookPages += 1;
      }

      if (sourceId !== null) alreadyImported.add(sourceId);
      pages += notebookPages;
      imported += 1;
    } catch (error) {
      failed += 1;
      console.error('[migrate] failed to import a legacy notebook', error);
      if (noteId !== null) {
        try {
          await deleteNote(noteId);
        } catch (cleanupError) {
          console.error('[migrate] failed to roll back a partial import', cleanupError);
        }
      }
    }
  }

  // Only mark the migration done when the source was readable and every
  // notebook landed. Otherwise it stays retryable - a transient read or write
  // failure must not silently strand the user's notebooks forever.
  if (sourceReadable && failed === 0) {
    await setSetting(MIGRATION_SETTING_KEY, Date.now());
  }
  return { imported, pages, failed, skipped: false };
}
