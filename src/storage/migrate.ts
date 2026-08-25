import { createNote, updateNote } from '@/storage/notes';
import { createPage } from '@/storage/pages';
import { getSetting, setSetting } from '@/storage/settings';
import type { PageStroke, StrokePoint } from '@/storage/types';

/** Written by the studio app at src/App.tsx:853. */
export const LEGACY_STORAGE_KEY = 'takingnotes_downloaded_memory';
export const MIGRATION_SETTING_KEY = 'legacyMigratedAt';

export interface MigrationResult {
  imported: number;
  pages: number;
  /** True when the migration had already run and was not repeated. */
  skipped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStrokes(value: unknown): PageStroke[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((stroke): PageStroke[] => {
    if (!isRecord(stroke) || !Array.isArray(stroke.points)) return [];

    const points = stroke.points.flatMap((point): StrokePoint[] => {
      if (!isRecord(point)) return [];
      return [{
        x: toNumber(point.x, 0),
        y: toNumber(point.y, 0),
        pressure: toNumber(point.pressure, 0.5),
      }];
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
    return { imported: 0, pages: 0, skipped: true };
  }

  let parsed: unknown;
  let sourceReadable = true;
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    parsed = raw === null ? [] : JSON.parse(raw);
  } catch {
    parsed = [];
    sourceReadable = false;
  }

  const notebooks = Array.isArray(parsed) ? parsed : [];
  let imported = 0;
  let pages = 0;

  for (const notebook of notebooks) {
    if (!isRecord(notebook)) continue;

    const downloadedAt = toNumber(notebook.downloadedAt, Date.now());
    const title =
      typeof notebook.notebookName === 'string' && notebook.notebookName.trim().length > 0
        ? notebook.notebookName
        : 'Imported notebook';
    const deviceId =
      typeof notebook.notebookUuid === 'string' ? notebook.notebookUuid : 'unknown';

    const note = await createNote({ title, deviceId, pageBaseline: 0 });
    await updateNote(note.id, {
      status: 'complete',
      startedAt: downloadedAt,
      endedAt: downloadedAt,
      legacy: true,
    });

    const legacyPages = Array.isArray(notebook.pages) ? notebook.pages : [];
    for (const [pageIndex, legacyPage] of legacyPages.entries()) {
      if (!isRecord(legacyPage)) continue;
      await createPage({
        noteId: note.id,
        pageIndex,
        devicePageNum: toNumber(legacyPage.pageNum, pageIndex),
        source: 'rom',
        strokes: toStrokes(legacyPage.strokes),
      });
      pages += 1;
    }

    imported += 1;
  }

  // Only mark the migration done when the source was actually readable. An
  // unreadable source must stay retryable - otherwise a transient read failure
  // silently strands the user's notebooks forever.
  if (sourceReadable) {
    await setSetting(MIGRATION_SETTING_KEY, Date.now());
  }
  return { imported, pages, skipped: false };
}
