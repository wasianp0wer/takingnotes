import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createOllamaTextGenerator } from '@/llm/ollamaText';
import { listEvents as listEventsReal } from '@/storage/events';
import { getSettingValue, setSettingValue } from '@/storage/settingKeys';
import type { CalendarEventRecord } from '@/storage/types';
import { toDateInputValue } from '@/triage/dates';
import { syncTasksFromCalendar } from '@/triage/generateTasks';
import { createSyllabusExtractor, type ExtractProgress, type SyllabusExtractor } from '@/syllabus/extractor';
import { importAssignments as importAssignmentsReal } from '@/syllabus/importAssignments';
import { ReviewTable } from '@/syllabus/ReviewTable';
import {
  markExisting,
  reresolveRows,
  rowsFromExtracted,
  toConfirmed,
  type ReviewRow,
} from '@/syllabus/reviewRows';
import { importKeyForFile, importKeyForPastedText } from '@/syllabus/sourceRef';
import { createOllamaPageReader } from '@/syllabus/vision';

/**
 * Everything this component reaches outside itself, in one place, so a test can
 * inject fakes and never touch a model, a PDF or the network (P2-A8).
 */
export interface SyllabusImportDeps {
  extractorFor(model: string, baseUrl: string, termStart: number | null): SyllabusExtractor;
  importAssignments: typeof importAssignmentsReal;
  syncTasks: () => Promise<unknown>;
  listEvents: () => Promise<CalendarEventRecord[]>;
  getSetting: typeof getSettingValue;
  setSetting: typeof setSettingValue;
  now: () => number;
}

const defaultDeps: SyllabusImportDeps = {
  // `model` is supplied per-call in `ExtractOptions`, not fixed at construction.
  extractorFor: (_model, baseUrl, termStart) =>
    createSyllabusExtractor({
      generator: createOllamaTextGenerator({ baseUrl }),
      // Scanned pages go through the same host's vision path (A30: one model).
      pageReader: createOllamaPageReader({ baseUrl }),
      termStart,
    }),
  importAssignments: importAssignmentsReal,
  syncTasks: syncTasksFromCalendar,
  listEvents: listEventsReal,
  getSetting: getSettingValue,
  setSetting: setSettingValue,
  now: () => Date.now(),
};

const progressText = (p: ExtractProgress): string => {
  if (p.phase === 'reading-pdf') return `Read ${p.pages} page${p.pages === 1 ? '' : 's'} of PDF…`;
  if (p.phase === 'reading-page-image') {
    return `Page ${p.page} of ${p.pages} is scanned — reading it with the vision model…`;
  }
  return `Extracting assignments (${p.chunk} of ${p.chunks})…`;
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * P2: a syllabus (PDF or pasted text) becomes assignment deadlines on the
 * calendar, by way of a review table nobody can skip (A25). It lives in the
 * triage view because it feeds the calendar, whose deadlines F3's task sync
 * already turns into tasks - which is why confirming ends with
 * `syncTasksFromCalendar()` rather than any task code of its own.
 */
export function SyllabusImport({ deps }: { deps?: Partial<SyllabusImportDeps> } = {}) {
  const d = useMemo<SyllabusImportDeps>(() => ({ ...defaultDeps, ...deps }), [deps]);

  const [pasted, setPasted] = useState('');
  const [termStart, setTermStart] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [importKey, setImportKey] = useState<string | null>(null);
  // The events a previous import wrote, kept so a title/date edit can
  // recompute "already imported" against them rather than only at extraction
  // time (finding 3).
  const [events, setEvents] = useState<CalendarEventRecord[]>([]);
  // Two clicks dispatched inside one `act` both observe the pre-render state,
  // so a state-only guard does not stop the second write; the ref does,
  // because it is mutated synchronously.
  const writingRef = useRef(false);
  // The user's own tick/untick of a row, keyed by row id. `reresolveRows`
  // (term-start change) recomputes `include` for any row the user has not
  // manually re-dated, which would otherwise silently re-tick a row the user
  // deliberately excluded (finding 2). This is tracked separately from
  // `ReviewRow.edited`, which gates DATE re-resolution and must keep doing
  // that independently of the tick decision.
  const includeOverridesRef = useRef<Map<string, boolean>>(new Map());
  // Discards a stale extraction's result if a newer one was started before it
  // finished - `disabled={busy}` is the primary guard, but this holds even if
  // that's ever bypassed.
  const extractionSeqRef = useRef(0);

  // A real setting read (or extraction, or write) can still be in flight when
  // this unmounts - e.g. the user switches away from the Triage tab. Without
  // this, the state update that promise resolves to lands on an unmounted
  // component. The ref is re-armed at the TOP of the effect body, not just
  // initialised once: StrictMode runs this cleanup as part of its mount ->
  // unmount -> remount simulation, on the very same ref, and without
  // re-arming it here every async path in this component would see
  // `mountedRef.current === false` forever after - silently disabling the
  // whole feature in development.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const stored = await d.getSetting('syllabus.termStart');
      if (mountedRef.current) setTermStart(stored);
    })();
  }, [d]);

  const confirmable = useMemo(() => (rows === null ? [] : toConfirmed(rows)), [rows]);

  const runExtraction = useCallback(
    async (
      // A thunk as well as a plain string, because the PDF path's key depends
      // on the file's content: resolving it inside the `try` below keeps a
      // failed read on the same error, progress and busy path as everything
      // else, instead of escaping as an unhandled rejection.
      key: string | (() => Promise<string>),
      run: (
        extractor: SyllabusExtractor,
        opts: { model: string; onProgress: (p: ExtractProgress) => void },
      ) => Promise<Awaited<ReturnType<SyllabusExtractor['fromText']>>>,
    ) => {
      const seq = ++extractionSeqRef.current;
      const stale = () => seq !== extractionSeqRef.current || !mountedRef.current;

      setBusy(true);
      setError(null);
      setResult(null);
      setRows(null);
      includeOverridesRef.current = new Map();
      setProgress('Starting…');
      try {
        const resolvedKey = typeof key === 'string' ? key : await key();
        const [model, baseUrl] = await Promise.all([
          d.getSetting('ollama.model'),
          d.getSetting('ollama.baseUrl'),
        ]);
        // The term start this extraction resolves dates against is whatever
        // is currently on screen, not a fresh read of the stored setting: a
        // change mid-flight must not retroactively rewrite an already-running
        // run's rows out from under it (finding 5), and the control is also
        // disabled while `busy` so this can't race a change in the first
        // place.
        const extractor = d.extractorFor(model, baseUrl, termStart);
        const extracted = await run(extractor, {
          model,
          onProgress: (p) => {
            if (!stale()) setProgress(progressText(p));
          },
        });

        const at = d.now();
        const built = rowsFromExtracted(extracted, termStart ?? at, at);
        const fetchedEvents = await d.listEvents();
        const withExisting = markExisting(built, fetchedEvents, resolvedKey);
        if (stale()) return;
        setEvents(fetchedEvents);
        setRows(withExisting);
        setImportKey(resolvedKey);
        setProgress(null);
      } catch (err) {
        if (!stale()) {
          setError(errorText(err));
          setProgress(null);
        }
      } finally {
        if (!stale()) setBusy(false);
      }
    },
    [d, termStart],
  );

  const extractPasted = useCallback(() => {
    const text = pasted;
    if (text.trim() === '') {
      setError('Paste the syllabus text first.');
      return;
    }
    void runExtraction(importKeyForPastedText(text), (extractor, opts) =>
      extractor.fromText(text, opts),
    );
  }, [pasted, runExtraction]);

  const pickPdf = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      // Read once and reuse: the key needs the bytes and so does the
      // extractor, and reading twice would double the work on a large PDF.
      let data: ArrayBuffer | null = null;
      const load = async (): Promise<ArrayBuffer> => (data ??= await file.arrayBuffer());
      void runExtraction(
        async () => importKeyForFile(file.name, await load()),
        async (extractor, opts) => extractor.fromPdf(await load(), opts),
      );
    },
    [runExtraction],
  );

  const changeTermStart = useCallback(
    (value: string) => {
      // An empty control means "resolve against today" (architecture §6.6).
      const at = value === '' ? null : new Date(`${value}T00:00`).getTime();
      const next = at !== null && Number.isNaN(at) ? null : at;
      setTermStart(next);
      void d.setSetting('syllabus.termStart', next);
      const nowMs = d.now();
      setRows((current) => {
        if (current === null) return current;
        const resolved = reresolveRows(current, next ?? nowMs, nowMs);
        // `reresolveRows` recomputes `include` from the newly-resolved date
        // for every row the user has not manually re-dated - which would
        // silently re-tick a row the user explicitly unticked (finding 2).
        // An explicit tick/untick always wins over that recomputation, for
        // as long as the row still has a date to include.
        return resolved.map((row) => {
          const override = includeOverridesRef.current.get(row.id);
          if (override === undefined || row.dueDate === '') return row;
          return { ...row, include: override };
        });
      });
    },
    [d],
  );

  const patchRow = useCallback(
    (id: string, patch: Partial<ReviewRow>) => {
      // A direct toggle of the Include checkbox - as opposed to `include`
      // changing as a side effect of editing the date - is an explicit
      // decision the user made, and a later term-start change must never
      // silently reverse it (finding 2).
      if ('include' in patch && !('dueDate' in patch)) {
        includeOverridesRef.current.set(id, patch.include as boolean);
      }
      setRows((current) => {
        if (current === null) return current;
        const next = current.map((row) => (row.id === id ? { ...row, ...patch } : row));
        // Editing a title or a date changes a row's identity (A26), so
        // "already imported" has to be recomputed against it rather than
        // staying stale from the original extraction (finding 3).
        return importKey === null ? next : markExisting(next, events, importKey);
      });
    },
    [events, importKey],
  );

  const confirm = useCallback(() => {
    if (writingRef.current) return;
    if (rows === null || importKey === null) return;
    const confirmed = toConfirmed(rows);
    if (confirmed.length === 0) return;
    writingRef.current = true;
    setWriting(true);
    void (async () => {
      try {
        const { created, updated } = await d.importAssignments(confirmed, importKey);
        // F3 already turns deadlines into tasks; P2 only asks it to run.
        await d.syncTasks();
        if (mountedRef.current) {
          setResult(`Created ${created}, updated ${updated}.`);
          setRows(null);
          setError(null);
        }
      } catch (err) {
        // The write commits rows one at a time and rejects on the first
        // failure, so rows before it are already in the calendar - this must
        // never claim otherwise. A second attempt is safe: the write matches
        // on a stable identity, so it updates whatever landed rather than
        // duplicating it.
        if (mountedRef.current) {
          setError(
            `Import failed: ${errorText(err)}. Some assignments may already have been added — re-importing is safe.`,
          );
        }
      } finally {
        writingRef.current = false;
        if (mountedRef.current) setWriting(false);
      }
    })();
  }, [d, importKey, rows]);

  const hasExisting = useMemo(() => rows !== null && rows.some((r) => r.existing), [rows]);

  return (
    <section aria-label="Syllabus" className="rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">Syllabus</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Import a syllabus as assignment deadlines. Nothing is added to the calendar until you
        confirm it below.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="block text-muted-foreground">Term start</span>
          <Input
            type="date"
            aria-label="Term start"
            value={termStart === null ? '' : toDateInputValue(termStart)}
            // Disabled while busy: an in-flight extraction already resolved
            // its dates against whatever term start was showing when it
            // started (finding 5), and changing the setting mid-flight would
            // otherwise leave the two out of sync with no re-resolution.
            disabled={busy}
            onChange={(e) => changeTermStart(e.target.value)}
          />
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground">PDF</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            aria-label="Syllabus PDF"
            disabled={busy}
            onChange={(e) => {
              pickPdf(e.target.files?.[0]);
              // Without this, re-picking the same file fires no `change`
              // event and the control goes dead on a retry.
              e.target.value = '';
            }}
            className="text-sm"
          />
        </label>
      </div>

      <div className="mt-3">
        <label className="text-xs text-muted-foreground" htmlFor="syllabus-paste">
          …or paste the syllabus text
        </label>
        <textarea
          id="syllabus-paste"
          aria-label="Syllabus text"
          rows={4}
          value={pasted}
          disabled={busy}
          onChange={(e) => setPasted(e.target.value)}
          className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
        />
        <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={extractPasted}>
          Extract assignments
        </Button>
      </div>

      {progress !== null && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {progress}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {result !== null && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {result}
        </p>
      )}

      {rows !== null && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Review before adding</h3>
          {rows.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No assignments were found in that syllabus.
            </p>
          ) : (
            <ReviewTable rows={rows} onChange={patchRow} />
          )}
          {hasExisting && (
            <p className="mt-2 text-xs text-destructive">
              Rows already on your calendar will be updated in place to match what&apos;s shown
              here.
            </p>
          )}
          <Button
            className="mt-3"
            size="sm"
            disabled={confirmable.length === 0 || writing}
            onClick={confirm}
          >
            Add {confirmable.length} to calendar
          </Button>
        </div>
      )}
    </section>
  );
}
