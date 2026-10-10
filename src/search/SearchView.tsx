import { useEffect, useMemo, useRef, useState } from 'react';

import { formatClock } from '@/audio/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loadSearchCorpus, type SearchCorpus } from '@/search/corpus';
import { findInCorpus, type FindHit } from '@/search/find';
import { runSmartSearch, type SmartSearchDeps, type SmartSearchResult } from '@/search/smartSearch';
import { getSmartSearchDeps } from '@/search/startSearch';

export interface SearchViewProps {
  /** Tests only - a real mount builds its own via `getSmartSearchDeps`. */
  smartSearchDeps?: SmartSearchDeps;
  /** From `AppShell` - best-effort cross-tab navigation (S6-A6). */
  onOpenNotes?: () => void;
  onOpenRecordings?: () => void;
}

const SOURCE_LABEL: Record<FindHit['source'], string> = {
  'note-title': 'Title',
  'note-summary': 'Summary',
  'page-text': 'Page',
  'audio-segment': 'Recording',
};

const BANDS = ['strong', 'moderate', 'weak'] as const;
const BAND_LABEL: Record<(typeof BANDS)[number], string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
};

/**
 * K39-K44, K46: one query box, two modes. Find recomputes from the already
 * loaded corpus on every keystroke (K40); Smart search is an explicit,
 * two-stage Gemma pass, grouped into three bands (K42). See
 * docs/features/s6-spec.md "Design" for the full reasoning.
 */
export function SearchView({ smartSearchDeps, onOpenNotes, onOpenRecordings }: SearchViewProps = {}) {
  const [corpus, setCorpus] = useState<SearchCorpus | null>(null);
  const [query, setQuery] = useState('');
  const [smart, setSmart] = useState<SmartSearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    let live = true;
    void loadSearchCorpus().then((loaded) => {
      if (live) setCorpus(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  const hits = useMemo(() => (corpus ? findInCorpus(corpus, query) : []), [corpus, query]);

  const isEmptyLibrary = corpus !== null && corpus.notes.length === 0 && corpus.recordings.length === 0;

  async function handleSmartSearch() {
    if (runningRef.current || !corpus) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const deps = smartSearchDeps ?? (await getSmartSearchDeps());
      const result = await runSmartSearch(query, corpus, deps);
      setSmart(result);
    } catch (e) {
      // The error never escapes this handler: it never reaches React as an
      // uncaught rejection or a stack trace (K44).
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  function openFor(hit: FindHit) {
    if (hit.source === 'audio-segment') onOpenRecordings?.();
    else onOpenNotes?.();
  }

  if (corpus === null) return null;

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
              onChange={(e) => setQuery(e.target.value)}
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

          {query.trim() !== '' && (
            <ul className="space-y-2">
              {hits.map((hit, i) => (
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
              {smart.unsummarizedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {smart.unsummarizedCount} {smart.unsummarizedCount === 1 ? 'note' : 'notes'} have no
                  summary yet and were screened by title and page text instead.
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
              {BANDS.map((band) => (
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
                          <Button size="sm" variant="ghost" onClick={() => onOpenNotes?.()}>
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
