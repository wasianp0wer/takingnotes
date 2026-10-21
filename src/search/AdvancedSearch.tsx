import { useEffect, useMemo, useRef, useState } from 'react';

import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { HOVER_AFFORDANCE } from '@/components/ui/hover';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { SearchCorpus } from '@/search/corpus';
import { collectFindCandidates, findInCorpus, hitsFromMatches } from '@/search/find';
import type { FindCandidate, FindHit, FindHitSource } from '@/search/find';
import { Highlighted, HighlightedRange } from '@/search/Highlighted';
import { SMART_SEARCH_BANDS } from '@/search/prompts';
import { createRegexRunner, SUPERSEDED_ERROR } from '@/search/regexRunner';
import type { RegexRunner } from '@/search/regexRunner';
import { useSearch } from '@/search/SearchContext';
import { ALL_SEARCH_SOURCES, openHit, toFindOptions } from '@/search/searchStore';
import type { SearchFilters } from '@/search/searchStore';
import { runSmartSearch } from '@/search/smartSearch';
import type { SmartSearchDeps, SmartSearchHit } from '@/search/smartSearch';
import { getSmartSearchDeps } from '@/search/startSearch';
import { useSearchCorpus } from '@/search/useSearchCorpus';
import { useSessionsUi } from '@/sessions/SessionsUiContext';
import type { SessionsUiStore } from '@/sessions/sessionsUiStore';
import { tagsOf } from '@/storage/notes';

export interface AdvancedSearchProps {
  /** Tests only - a real mount builds its own via `getSmartSearchDeps`. */
  smartSearchDeps?: SmartSearchDeps;
  /** Tests only - a real mount creates (and disposes) its own Worker-backed runner. */
  regexRunner?: RegexRunner;
}

/**
 * Fix round 3, I4: debounces the expensive Find recompute/render, not the
 * input's own feel - the `Input` stays bound to `query` directly.
 */
const FIND_DEBOUNCE_MS = 150;
/**
 * Fix round 3, I4: a query on its way to being typed can match far more than
 * is useful to mount synchronously - rendered hits are capped, with a
 * "showing first N of M" line naming the true total.
 */
const FIND_RESULTS_CAP = 50;

const SOURCE_LABEL: Record<FindHit['source'], string> = {
  'note-title': 'Title',
  'note-summary': 'Summary',
  'page-text': 'Page',
  'audio-segment': 'Recording',
};

/** The source filter's checkbox labels. */
const SOURCE_FILTER_LABEL: Record<FindHitSource, string> = {
  'note-title': 'Titles',
  'note-summary': 'Summaries',
  'page-text': 'Pages',
  'audio-segment': 'Recordings',
};

/**
 * Fix round 3, I3: imported from the one list `prompts.ts`'s wording and
 * `validate.ts`'s accepted values are also built from.
 */
const BAND_LABEL: Record<(typeof SMART_SEARCH_BANDS)[number], string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
};

const FIELD = cn(
  'min-w-0 bg-muted px-2 py-1 text-sm outline-none',
  'focus-visible:ring-2 focus-visible:ring-focus-ring',
);
const TOGGLE = cn(
  'px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
  HOVER_AFFORDANCE,
);

function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/**
 * Fix round 3, C1: a smart-search hit opens its recording when its note has
 * no page text to point at; otherwise it opens the note.
 */
function openSmartHit(hit: SmartSearchHit, sessions: SessionsUiStore): void {
  if (hit.recordingId !== undefined) {
    sessions.openRecording(hit.recordingId, undefined, hit.noteId);
    return;
  }
  sessions.openNote(hit.noteId, 0);
}

interface RegexFind {
  hits: FindHit[];
  pending: boolean;
  error: string | null;
}

/**
 * Regex Find, evaluated by the regex runner (a Worker with a time budget),
 * never on the main thread. The candidates are already narrowed by the
 * filters. The last successful hits stay shown while a newer run is pending
 * and when it fails; a superseded run is ignored. Going inactive (regex off,
 * or the query cleared) drops them. A runner created here is disposed on
 * unmount.
 */
function useRegexFind(
  candidates: readonly FindCandidate[] | null,
  pattern: string,
  runner: RegexRunner | undefined,
): RegexFind {
  const active = candidates !== null && pattern.length > 0;
  const [hits, setHits] = useState<FindHit[]>([]);
  const [settled, setSettled] = useState<{
    candidates: readonly FindCandidate[];
    pattern: string;
    error: string | null;
  } | null>(null);
  const ownRef = useRef<RegexRunner | null>(null);

  // Adjusting state while rendering, React's pattern for a reset on an input change.
  if (!active && (hits.length > 0 || settled !== null)) {
    setHits([]);
    setSettled(null);
  }

  useEffect(
    () => () => {
      ownRef.current?.dispose();
      ownRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const run = runner ?? (ownRef.current ??= createRegexRunner());
    void run
      .run(
        pattern,
        candidates.map((c) => c.text),
      )
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          if (result.error === SUPERSEDED_ERROR) return;
          setSettled({ candidates, pattern, error: result.error });
          return;
        }
        setHits(hitsFromMatches(candidates, result.matches));
        setSettled({ candidates, pattern, error: null });
      });
    return () => {
      cancelled = true;
    };
  }, [active, candidates, pattern, runner]);

  const fresh =
    active && settled !== null && settled.candidates === candidates && settled.pattern === pattern;
  return { hits, pending: active && !fresh, error: fresh ? settled.error : null };
}

/** Radix's centred-dialog classes, overridden (via tailwind-merge) to cover the viewport. */
const FULL_SCREEN = cn(
  'fixed inset-0 z-50 flex h-full w-full max-w-none sm:max-w-none translate-x-0 translate-y-0',
  'flex-col gap-0 rounded-none bg-background p-0 text-foreground',
);

/**
 * The full-screen advanced search (K39-K44, K46, plus regex and filters), on
 * the Radix Dialog: it traps focus, closes on Escape from anywhere, hides the
 * app behind it from assistive tech, and returns focus to the opener. Its body
 * mounts only while `advancedOpen`; everything worth keeping (query, regex,
 * filters, the last smart result) lives in the search store, so closing and
 * reopening shows the same search without another model call.
 */
export function AdvancedSearch(props: AdvancedSearchProps = {}) {
  const [search, store] = useSearch();
  // Radix's modal dialog returns focus to its Trigger, and this one has none
  // (it opens from the store), so the opener is remembered here instead.
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={search.advancedOpen}
      onOpenChange={(open) => {
        if (!open) store.closeAdvanced();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-modal="true"
        aria-label="Advanced search"
        aria-describedby={undefined}
        className={FULL_SCREEN}
        onOpenAutoFocus={(event) => {
          // The query input when it is already there; otherwise the dialog
          // itself (the input autofocuses once the corpus has loaded).
          event.preventDefault();
          const active = document.activeElement;
          openerRef.current = active instanceof HTMLElement ? active : null;
          const content = event.currentTarget as HTMLElement;
          (content.querySelector<HTMLElement>(QUERY_INPUT_SELECTOR) ?? content).focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = openerRef.current;
          openerRef.current = null;
          if (opener?.isConnected) opener.focus();
        }}
      >
        <AdvancedSearchBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

const QUERY_INPUT_SELECTOR = 'input[aria-label="Search query"]';

function AdvancedSearchBody({ smartSearchDeps, regexRunner }: AdvancedSearchProps) {
  const [search, store] = useSearch();
  const [, sessions] = useSessionsUi();
  const corpus = useSearchCorpus(true);
  const { query, regex, filters, smart } = search;
  // Fix round 3, I4: Find recomputes/renders from this, not `query`
  // directly. Starts at the stored query so a reopen shows results at once.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  // Fix round 3, M2: the in-flight smart-search run's controller, aborted
  // on unmount (closing the overlay) so it stops making model calls.
  const abortRef = useRef<AbortController | null>(null);
  // Guards a `setState` after unmount from the abort below.
  const liveRef = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const findOptions = useMemo(() => toFindOptions({ regex, filters }), [regex, filters]);
  const plainHits = useMemo(
    () => (corpus !== null && !regex ? findInCorpus(corpus, debouncedQuery, findOptions) : []),
    [corpus, regex, debouncedQuery, findOptions],
  );
  const candidates = useMemo(
    () => (corpus !== null && regex ? collectFindCandidates(corpus, findOptions) : null),
    [corpus, regex, findOptions],
  );
  const regexFind = useRegexFind(candidates, debouncedQuery, regexRunner);
  const hits = regex ? regexFind.hits : plainHits;
  const pending = regex && regexFind.pending;
  const visibleHits = hits.slice(0, FIND_RESULTS_CAP);

  const close = (): void => store.closeAdvanced();

  function handleQueryChange(value: string): void {
    store.setQuery(value);
    setError(null);
  }

  async function handleSmartSearch(): Promise<void> {
    if (runningRef.current || !corpus) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const asked = query;
    try {
      const deps = smartSearchDeps ?? (await getSmartSearchDeps());
      // Filters and regex narrow Find only: smart search gets the whole
      // corpus, and the query as prose.
      const result = await runSmartSearch(asked, corpus, deps, { signal: controller.signal });
      if (liveRef.current) store.setSmart({ query: asked, result });
    } catch (e) {
      // Never escapes as an uncaught rejection (K44); never shown for our own unmount's abort.
      if (liveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      if (liveRef.current) setRunning(false);
    }
  }

  function openFind(hit: FindHit): void {
    openHit(hit, sessions);
    close();
  }

  function openSmart(hit: SmartSearchHit): void {
    openSmartHit(hit, sessions);
    close();
  }

  return (
    <>
      <header className="flex items-center gap-2 bg-surface px-4 py-2">
        <DialogTitle className="text-sm font-semibold text-heading">Advanced search</DialogTitle>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-link"
            onClick={() => {
              store.clear();
              setError(null);
            }}
          >
            Clear
          </Button>
          <Button size="sm" variant="ghost" onClick={close}>
            Close
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {corpus === null ? (
          // Fix round 3, I5: a real loading state, inside the dialog.
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : corpus.notes.length === 0 && corpus.recordings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to search yet — write a note or make a recording first.
          </p>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Search query"
                placeholder={
                  regex ? 'Regular expression…' : 'Search your notes and recordings…'
                }
                autoFocus
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={running || query.trim() === '' || corpus.notes.length === 0}
                onClick={() => void handleSmartSearch()}
              >
                Smart search
              </Button>
            </div>

            <FilterBar
              corpus={corpus}
              regex={regex}
              filters={filters}
              onRegexChange={(on) => store.setRegex(on)}
              onFiltersChange={(f) => store.setFilters(f)}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}

            {regex && regexFind.error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {regexFind.error}
              </p>
            )}

            {debouncedQuery.trim() !== '' && corpus.partialTranscriptCount > 0 && (
              // ⚑ Rendered once for the whole view, covering both modes.
              <p className="text-xs text-muted-foreground">
                {corpus.partialTranscriptCount}{' '}
                {corpus.partialTranscriptCount === 1 ? 'recording is' : 'recordings are'} not fully
                transcribed yet, so these results may be incomplete.
              </p>
            )}

            {debouncedQuery.trim() !== '' && (
              <section aria-label="Find results" aria-busy={pending}>
                {pending && <p className="text-xs text-muted-foreground">Searching…</p>}
                <ul className="space-y-2">
                  {hits.length > FIND_RESULTS_CAP && (
                    <li className="text-xs text-muted-foreground">
                      Showing first {FIND_RESULTS_CAP} of {hits.length} matches.
                    </li>
                  )}
                  {visibleHits.map((hit) => (
                    <FindHitRow
                      key={hitKey(hit)}
                      hit={hit}
                      highlight={regex ? null : debouncedQuery}
                      onOpen={openFind}
                    />
                  ))}
                  {hits.length === 0 && !pending && regexFind.error === null && (
                    <li className="text-sm text-muted-foreground">No matches.</li>
                  )}
                </ul>
              </section>
            )}

            {smart && (
              <SmartResults smart={smart} currentQuery={query} onOpen={openSmart} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Stable across re-runs: what the hit points at, not its position in the list. */
function hitKey(hit: FindHit): string {
  return `${hit.source}-${hit.noteId}-${hit.pageIndex}-${hit.recordingId}-${hit.startMs}`;
}

function FindHitRow(props: {
  hit: FindHit;
  /** The plain query to highlight; `null` in regex mode, which uses the hit's own match range. */
  highlight: string | null;
  onOpen(hit: FindHit): void;
}) {
  const { hit, highlight, onOpen } = props;
  return (
    <li className="flex items-start justify-between gap-2 text-sm">
      <div>
        <span className="font-medium">{SOURCE_LABEL[hit.source]}</span>
        {hit.noteTitle && <span className="text-session-title"> — {hit.noteTitle}</span>}
        {hit.pageIndex !== undefined && (
          <span>
            {' '}
            (page {hit.pageIndex + 1}
            {hit.isTyped ? ', typed' : ''})
          </span>
        )}
        {hit.recordingTitle && <span> — {hit.recordingTitle}</span>}
        {hit.startMs !== undefined && (
          <span>
            {' '}
            at <span className="text-timestamp">{formatClock(hit.startMs)}</span>
          </span>
        )}
        <p className="text-muted-foreground">
          {highlight === null ? (
            <HighlightedRange text={hit.snippet} range={hit.highlight} />
          ) : (
            <Highlighted text={hit.snippet} query={highlight} />
          )}
        </p>
      </div>
      <Button size="sm" variant="ghost" className="text-link" onClick={() => onOpen(hit)}>
        Open
      </Button>
    </li>
  );
}

function FilterBar(props: {
  corpus: SearchCorpus;
  regex: boolean;
  filters: SearchFilters;
  onRegexChange(on: boolean): void;
  onFiltersChange(filters: SearchFilters): void;
}) {
  const { corpus, regex, filters, onRegexChange, onFiltersChange } = props;
  const set = (patch: Partial<SearchFilters>) => onFiltersChange({ ...filters, ...patch });
  const vocabulary = useMemo(() => {
    const all = new Set<string>();
    for (const { note } of corpus.notes) for (const tag of tagsOf(note)) all.add(tag);
    return [...all].sort();
  }, [corpus]);

  return (
    <div
      role="group"
      aria-label="Filters"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface p-2 text-sm"
    >
      <Switch
        checked={regex}
        onCheckedChange={onRegexChange}
        offLabel="Text"
        onLabel="Regex"
        aria-label="Regex"
      />
      <span className="flex items-center gap-1.5">
        <input
          type="date"
          aria-label="From date"
          className={cn(FIELD, 'text-date')}
          value={filters.from ?? ''}
          onChange={(e) => set({ from: e.target.value === '' ? null : e.target.value })}
        />
        <span className="text-muted-foreground">to</span>
        <input
          type="date"
          aria-label="To date"
          className={cn(FIELD, 'text-date')}
          value={filters.to ?? ''}
          onChange={(e) => set({ to: e.target.value === '' ? null : e.target.value })}
        />
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {ALL_SEARCH_SOURCES.map((source) => (
          <label key={source} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={SOURCE_FILTER_LABEL[source]}
              checked={filters.sources.includes(source)}
              onChange={() => set({ sources: toggled(filters.sources, source) })}
            />
            {SOURCE_FILTER_LABEL[source]}
          </label>
        ))}
      </span>
      {vocabulary.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          {vocabulary.map((tag) => {
            const on = filters.tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                className={cn(TOGGLE, 'text-tag', on && 'bg-selected')}
                onClick={() => set({ tags: toggled(filters.tags, tag) })}
              >
                {tag}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={filters.tagMode === 'or'}
            className={cn(TOGGLE, filters.tagMode === 'or' && 'bg-selected')}
            onClick={() => set({ tagMode: 'or' })}
          >
            Any tag
          </button>
          <button
            type="button"
            aria-pressed={filters.tagMode === 'and'}
            className={cn(TOGGLE, filters.tagMode === 'and' && 'bg-selected')}
            onClick={() => set({ tagMode: 'and' })}
          >
            All tags
          </button>
        </span>
      )}
    </div>
  );
}

function SmartResults(props: {
  smart: NonNullable<ReturnType<typeof useSearch>[0]['smart']>;
  currentQuery: string;
  onOpen(hit: SmartSearchHit): void;
}) {
  const { smart, currentQuery, onOpen } = props;
  const result = smart.result;
  // Fix round 3, I1: only `titleOnlyCount` of the unsummarized notes had
  // nothing but a title; the rest were screened by page or recording text.
  const screenedByFallback = result.unsummarizedCount - result.titleOnlyCount;

  return (
    <section aria-label="Smart results" className="space-y-3 bg-surface p-3">
      {smart.query.trim() !== currentQuery.trim() && (
        <p className="text-xs text-muted-foreground">Smart results for &quot;{smart.query}&quot;</p>
      )}
      {screenedByFallback > 0 && (
        <p className="text-xs text-muted-foreground">
          {screenedByFallback} {screenedByFallback === 1 ? 'note has' : 'notes have'} no summary
          yet and {screenedByFallback === 1 ? 'was' : 'were'} screened by title and page text or
          recording content instead.
        </p>
      )}
      {result.titleOnlyCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {result.titleOnlyCount} {result.titleOnlyCount === 1 ? 'note has' : 'notes have'} neither
          page text nor a recording, and {result.titleOnlyCount === 1 ? 'was' : 'were'} screened by
          title alone.
        </p>
      )}
      {result.uncheckedCount > 0 && (
        // Fix round 1, Finding 2: distinct from "no matches" - relevance unknown, not ruled out.
        <p className="text-xs text-destructive">
          {result.uncheckedCount} {result.uncheckedCount === 1 ? 'note' : 'notes'} could not be
          checked — search failed partway through for{' '}
          {result.uncheckedCount === 1 ? 'it' : 'them'}.
        </p>
      )}
      {SMART_SEARCH_BANDS.map((band) => (
        <div key={band}>
          <h3 className="text-sm font-medium text-heading">{BAND_LABEL[band]}</h3>
          {result[band].length === 0 ? (
            <p className="text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="space-y-1">
              {result[band].map((hit) => (
                <li key={hit.noteId} className="text-sm">
                  <span className="font-medium text-session-title">{hit.noteTitle}</span>
                  <p className="text-muted-foreground">{hit.reason}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-link"
                    onClick={() => onOpen(hit)}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
