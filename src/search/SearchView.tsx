import { useEffect, useMemo, useRef, useState } from 'react';

import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loadSearchCorpus, type SearchCorpus } from '@/search/corpus';
import { findInCorpus, type FindHit } from '@/search/find';
import { SMART_SEARCH_BANDS } from '@/search/prompts';
import { runSmartSearch, type SmartSearchDeps, type SmartSearchHit, type SmartSearchResult } from '@/search/smartSearch';
import { getSmartSearchDeps } from '@/search/startSearch';

export interface SearchViewProps {
  /** Tests only - a real mount builds its own via `getSmartSearchDeps`. */
  smartSearchDeps?: SmartSearchDeps;
  /**
   * From `AppShell` (Fix round 1, Finding 1): switches to the Notes tab and
   * selects this note + page there. `pageIndex` is `0` for a hit with no
   * specific page (a note-title/summary Find hit, or any smart-search hit
   * whose note has page text - neither identifies a single page).
   */
  onOpenNotes?: (noteId: string, pageIndex: number) => void;
  /** Switches to the Recordings tab and selects this recording. `startMs` names the segment to look for, when known. */
  onOpenRecordings?: (recordingId: string, startMs?: number) => void;
}

/** Fix round 3, I4: debounces the expensive Find recompute/render, not the input's own feel - the `Input` stays bound to `query` directly. */
const FIND_DEBOUNCE_MS = 150;
/** Fix round 3, I4: a query on its way to being typed can match far more than is useful to mount synchronously - rendered hits are capped, with a "showing first N of M" line naming the true total. */
const FIND_RESULTS_CAP = 50;

const SOURCE_LABEL: Record<FindHit['source'], string> = {
  'note-title': 'Title',
  'note-summary': 'Summary',
  'page-text': 'Page',
  'audio-segment': 'Recording',
};

/**
 * Fix round 3, I3: imported from the one list `prompts.ts`'s wording and
 * `validate.ts`'s accepted values are also built from, rather than a
 * fourth hand-copy of "strong"/"moderate"/"weak" living here too.
 */
const BAND_LABEL: Record<(typeof SMART_SEARCH_BANDS)[number], string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
};

/** Fix round 3, C1: a smart-search hit opens its recording when its note has no page text to point at; otherwise it opens the note. */
function openSmartHit(
  hit: SmartSearchHit,
  onOpenNotes: SearchViewProps['onOpenNotes'],
  onOpenRecordings: SearchViewProps['onOpenRecordings'],
): void {
  if (hit.recordingId !== undefined) {
    onOpenRecordings?.(hit.recordingId);
    return;
  }
  onOpenNotes?.(hit.noteId, 0);
}

/**
 * K39-K44, K46: one query box, two modes. Find recomputes from the already
 * loaded corpus on every keystroke (K40); Smart search is an explicit,
 * two-stage Gemma pass, grouped into three bands (K42). See
 * docs/features/s6-spec.md "Design" for the full reasoning.
 */
export function SearchView({ smartSearchDeps, onOpenNotes, onOpenRecordings }: SearchViewProps = {}) {
  const [corpus, setCorpus] = useState<SearchCorpus | null>(null);
  const [query, setQuery] = useState('');
  // Fix round 3, I4: Find recomputes/renders from this, not `query`
  // directly, so a fast typist doesn't pay for a full match-and-render on
  // every intermediate keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [smart, setSmart] = useState<SmartSearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  // Fix round 3, M2: the in-flight smart-search run's own controller, so
  // the unmount cleanup below can abort it - a run abandoned by a tab
  // switch (SearchView remounts fresh on the next visit; see fix round
  // 1/2's remount premise) would otherwise keep making serial model calls
  // for a result nothing will ever read.
  const abortRef = useRef<AbortController | null>(null);
  // Guards a `setState` after unmount from the abort below: aborting
  // doesn't stop `handleSmartSearch`'s own `await` from eventually
  // resolving (to a rejection), and that resolution must not touch state
  // on a component that no longer exists.
  const liveRef = useRef(true);

  useEffect(() => {
    let live = true;
    void loadSearchCorpus().then((loaded) => {
      if (live) setCorpus(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Fix round 3, M2: aborts whatever smart-search run is in flight when
  // this view unmounts (a tab switch away from Search). `[]` deps - this
  // must run only on unmount, not on every re-render.
  useEffect(() => {
    return () => {
      liveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const hits = useMemo(
    () => (corpus ? findInCorpus(corpus, debouncedQuery) : []),
    [corpus, debouncedQuery],
  );
  const visibleHits = hits.slice(0, FIND_RESULTS_CAP);

  const isEmptyLibrary = corpus !== null && corpus.notes.length === 0 && corpus.recordings.length === 0;

  // Fix round 3, I6: a query change clears the previous smart-search
  // result and error. Without this, running "entropy", getting a Strong
  // hit, then typing "osmosis" leaves that hit's bands sitting under the
  // now-current Find results, reading as an answer to a query they were
  // never computed for.
  function handleQueryChange(value: string): void {
    setQuery(value);
    setSmart(null);
    setError(null);
  }

  async function handleSmartSearch() {
    if (runningRef.current || !corpus) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const deps = smartSearchDeps ?? (await getSmartSearchDeps());
      const result = await runSmartSearch(query, corpus, deps, { signal: controller.signal });
      if (liveRef.current) setSmart(result);
    } catch (e) {
      // The error never escapes this handler: it never reaches React as an
      // uncaught rejection or a stack trace (K44). Also never shown for an
      // abort from our own unmount cleanup - there is no view left to show
      // it to, and "Smart search aborted" would be a confusing thing to
      // have flashed on screen on the way out anyway.
      if (liveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      if (liveRef.current) setRunning(false);
    }
  }

  function openFor(hit: FindHit) {
    if (hit.source === 'audio-segment') {
      // Only ever `null` when the recording has no owning note (A10) -
      // `recordingId` itself is always set on an 'audio-segment' hit.
      if (hit.recordingId) onOpenRecordings?.(hit.recordingId, hit.startMs);
      return;
    }
    // Always set for 'note-title'/'note-summary'/'page-text' hits - they
    // are built from `corpus.notes` directly (see `find.ts`).
    if (hit.noteId) onOpenNotes?.(hit.noteId, hit.pageIndex ?? 0);
  }

  // Fix round 3, I5: a real loading state, not `null` - a `null` return
  // meant this tab showed nothing at all (not even its own landmark) for
  // as long as `loadSearchCorpus()` took.
  if (corpus === null) {
    return (
      <section aria-label="Search" className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  // Fix round 3, I1: `unsummarizedCount` notes have no summary, but K46's
  // fallback also now draws on page text *and* recording text (C1) - only
  // `titleOnlyCount` of them have neither, and only that subset was really
  // screened on nothing but a (possibly generic) title.
  const screenedByFallback = smart ? smart.unsummarizedCount - smart.titleOnlyCount : 0;

  return (
    <section aria-label="Search" className="flex h-full flex-col gap-4 overflow-auto p-4">
      {isEmptyLibrary ? (
        <p className="text-sm text-muted-foreground">
          Nothing to search yet — write a note or make a recording first.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Search query"
              placeholder="Search your notes and recordings…"
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

          {error && <p className="text-sm text-destructive">{error}</p>}

          {debouncedQuery.trim() !== '' && corpus.partialTranscriptCount > 0 && (
            // ⚑ Rendered once for the whole view, covering both modes.
            // Find reads `transcript.segments` with no status gate, so it
            // returns partial hits whether or not anything asked it to;
            // smart search reads the same partial text through `audioText`.
            // Either way the honest claim is that some of what was searched
            // is not all there yet.
            <p className="text-xs text-muted-foreground">
              {corpus.partialTranscriptCount}{' '}
              {corpus.partialTranscriptCount === 1 ? 'recording is' : 'recordings are'} not fully
              transcribed yet, so these results may be incomplete.
            </p>
          )}

          {debouncedQuery.trim() !== '' && (
            <ul className="space-y-2">
              {hits.length > FIND_RESULTS_CAP && (
                <li className="text-xs text-muted-foreground">
                  Showing first {FIND_RESULTS_CAP} of {hits.length} matches.
                </li>
              )}
              {visibleHits.map((hit, i) => (
                <li key={i} className="flex items-start justify-between gap-2 text-sm">
                  <div>
                    <span className="font-medium">{SOURCE_LABEL[hit.source]}</span>
                    {hit.noteTitle && <span> — {hit.noteTitle}</span>}
                    {hit.pageIndex !== undefined && (
                      <span>
                        {' '}
                        (page {hit.pageIndex + 1}
                        {hit.isTyped ? ', typed' : ''})
                      </span>
                    )}
                    {hit.recordingTitle && <span> — {hit.recordingTitle}</span>}
                    {hit.startMs !== undefined && <span> at {formatClock(hit.startMs)}</span>}
                    <p className="text-muted-foreground">{hit.snippet}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => openFor(hit)}>
                    Open
                  </Button>
                </li>
              ))}
              {hits.length === 0 && (
                <li className="text-sm text-muted-foreground">No matches.</li>
              )}
            </ul>
          )}

          {smart && (
            <div className="space-y-3 border-t border-border pt-3">
              {screenedByFallback > 0 && (
                <p className="text-xs text-muted-foreground">
                  {screenedByFallback} {screenedByFallback === 1 ? 'note has' : 'notes have'} no
                  summary yet and {screenedByFallback === 1 ? 'was' : 'were'} screened by title and
                  page text or recording content instead.
                </p>
              )}
              {smart.titleOnlyCount > 0 && (
                // Fix round 3, I1: honest about the notes the fallback
                // above could not actually help - no page text and no
                // recording either, so only the title was ever screened.
                <p className="text-xs text-muted-foreground">
                  {smart.titleOnlyCount} {smart.titleOnlyCount === 1 ? 'note has' : 'notes have'}{' '}
                  neither page text nor a recording, and{' '}
                  {smart.titleOnlyCount === 1 ? 'was' : 'were'} screened by title alone.
                </p>
              )}
              {smart.uncheckedCount > 0 && (
                // Fix round 1, Finding 2: distinct from "no matches" -
                // these notes were screened as candidates but the closer
                // check on them failed partway through, so their
                // relevance is unknown, not ruled out.
                <p className="text-xs text-destructive">
                  {smart.uncheckedCount} {smart.uncheckedCount === 1 ? 'note' : 'notes'} could not be
                  checked — search failed partway through for{' '}
                  {smart.uncheckedCount === 1 ? 'it' : 'them'}.
                </p>
              )}
              {SMART_SEARCH_BANDS.map((band) => (
                <div key={band}>
                  <h3 className="text-sm font-medium">{BAND_LABEL[band]}</h3>
                  {smart[band].length === 0 ? (
                    <p className="text-sm text-muted-foreground">No matches.</p>
                  ) : (
                    <ul className="space-y-1">
                      {smart[band].map((hit) => (
                        <li key={hit.noteId} className="text-sm">
                          <span className="font-medium">{hit.noteTitle}</span>
                          <p className="text-muted-foreground">{hit.reason}</p>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openSmartHit(hit, onOpenNotes, onOpenRecordings)}
                          >
                            Open
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
