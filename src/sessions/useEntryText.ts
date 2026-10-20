import { useEffect, useState } from 'react';

import { loadSearchCorpus } from '@/search/corpus';
import { noteKey, recordingKey } from '@/sessions/catalog';
import type { EntryText } from '@/sessions/filter';

/**
 * Per-entry searchable text, keyed by entry key. Loaded from the search corpus
 * only while `needed` is true (text criteria active); `catalogRevision` is any
 * value that changes when the library does, to refresh the map. `null` until
 * loaded, and again whenever it is not needed.
 */
export function useEntryText(
  needed: boolean,
  catalogRevision: unknown,
): ReadonlyMap<string, EntryText> | null {
  const [map, setMap] = useState<ReadonlyMap<string, EntryText> | null>(null);

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    void loadSearchCorpus().then(
      (corpus) => {
        if (cancelled) return;
        const next = new Map<string, EntryText>();
        for (const n of corpus.notes) {
          const text = [...n.pages.map((p) => p.text), n.note.summary ?? '', n.audioText]
            .filter((s) => s !== '')
            .join('\n\n');
          next.set(noteKey(n.note.id), { text, hasTypedPage: n.pages.some((p) => p.isTyped) });
        }
        for (const r of corpus.recordings) {
          if (corpus.recordingOwner.has(r.id)) continue;
          const done = r.transcript?.status === 'done' ? r.transcript.text : '';
          next.set(recordingKey(r.id), { text: done, hasTypedPage: false });
        }
        setMap(next);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Entry text load failed', error);
        setMap(new Map());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needed, catalogRevision]);

  return needed ? map : null;
}
