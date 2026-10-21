import { Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { HOVER_AFFORDANCE } from '@/components/ui/hover';
import { findInCorpus, MIN_QUERY_LENGTH } from '@/search/find';
import type { FindHit } from '@/search/find';
import { useSearch } from '@/search/SearchContext';
import { openHit, QUICK_RESULTS_CAP } from '@/search/searchStore';
import { useSearchCorpus } from '@/search/useSearchCorpus';
import { useSessionsUi } from '@/sessions/SessionsUiContext';

const SOURCE_LABEL: Record<FindHit['source'], string> = {
  'note-title': 'Title',
  'note-summary': 'Summary',
  'page-text': 'Page',
  'audio-segment': 'Recording',
};

/** The snippet with each case-insensitive occurrence of `query` highlighted. */
function Highlighted(props: { text: string; query: string }) {
  const { text, query } = props;
  const needle = query.trim().toLowerCase();
  if (needle === '') return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="bg-search-highlight text-inherit">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}

/** The header's quick search: a plain-text box (never regex) with a short dropdown of hits. */
export function HeaderSearch() {
  const [search, searchStore] = useSearch();
  const [, sessions] = useSessionsUi();
  const [expanded, setExpanded] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const corpus = useSearchCorpus(expanded);
  const quick = search.quickQuery;

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  // The quick box ignores the advanced regex/filters: plain text, no options.
  const hits = useMemo(
    () =>
      corpus === null || quick.trim().length < MIN_QUERY_LENGTH
        ? []
        : findInCorpus(corpus, quick).slice(0, QUICK_RESULTS_CAP),
    [corpus, quick],
  );
  const showList = expanded && dropdownOpen && quick.trim().length >= MIN_QUERY_LENGTH;

  const open = (hit: FindHit): void => {
    openHit(hit, sessions);
    setDropdownOpen(false);
  };
  const openAdvanced = (): void => {
    searchStore.openAdvanced(quick);
    setDropdownOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setDropdownOpen(true);
      setHighlighted((i) => (hits.length === 0 ? -1 : Math.min(i + 1, hits.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((i) => Math.max(i - 1, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = highlighted >= 0 ? hits[highlighted] : undefined;
      if (hit !== undefined) open(hit);
      else openAdvanced();
    } else if (event.key === 'Escape') {
      setDropdownOpen(false);
      setHighlighted(-1);
    }
  };

  if (!expanded) {
    return (
      <button
        type="button"
        aria-label="Search"
        className={`p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${HOVER_AFFORDANCE}`}
        onClick={() => {
          setExpanded(true);
          setDropdownOpen(true);
        }}
      >
        <Search className="h-4 w-4" aria-hidden />
      </button>
    );
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        aria-label="Quick search"
        role="combobox"
        aria-expanded={showList}
        aria-controls="quick-search-results"
        className="h-8 w-64"
        placeholder="Search"
        value={quick}
        onChange={(e) => {
          searchStore.setQuickQuery(e.target.value);
          setDropdownOpen(true);
          setHighlighted(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <div className="absolute right-0 z-50 mt-1 w-96 bg-surface shadow-md">
          <ul id="quick-search-results" role="listbox" aria-label="Quick search results">
            {hits.map((hit, i) => (
              <li
                key={`${hit.source}-${hit.noteId}-${hit.pageIndex}-${hit.recordingId}-${hit.startMs}`}
                role="option"
                aria-selected={i === highlighted}
                className={`flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-sm ${HOVER_AFFORDANCE} ${
                  i === highlighted ? 'bg-hover' : ''
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => open(hit)}
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">{SOURCE_LABEL[hit.source]}</span>
                  <span className="truncate font-medium text-session-title">
                    {hit.noteTitle ?? hit.recordingTitle ?? 'Untitled'}
                  </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  <Highlighted text={hit.snippet} query={quick} />
                </span>
              </li>
            ))}
          </ul>
          {hits.length === 0 && corpus !== null && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
          )}
          <button
            type="button"
            className={`w-full px-3 py-1.5 text-left text-sm text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${HOVER_AFFORDANCE}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openAdvanced}
          >
            Open advanced search
          </button>
        </div>
      )}
    </div>
  );
}
