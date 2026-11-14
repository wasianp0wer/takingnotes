import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Names the `::highlight()` rules in index.css paint. */
const ALL_MATCHES = 'transcript-find';
const CURRENT_MATCH = 'transcript-find-current';

/**
 * Every case-insensitive occurrence of `query` in `root`'s text, as DOM
 * ranges. Matches may span element boundaries (`<strong>the</strong> mat`),
 * since the text is searched as one string and only then mapped back to
 * nodes. KaTeX's hidden MathML copy is skipped, or every formula would match
 * twice.
 */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.textContent ?? '';
  }

  // The node holding character `offset`; `end` selects the node an exclusive
  // end offset falls in, which may be the very end of a node.
  function locate(offset: number, end: boolean) {
    for (const entry of nodes) {
      const length = entry.node.length;
      if (end ? offset <= entry.start + length : offset < entry.start + length) {
        return { node: entry.node, offset: offset - entry.start };
      }
    }
    return null;
  }

  const haystack = text.toLowerCase();
  const ranges: Range[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    const start = locate(at, false);
    const end = locate(at + needle.length, true);
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

/** The CSS Custom Highlight registry, where the runtime has one (jsdom does not). */
function highlightRegistry(): HighlightRegistry | undefined {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined;
}

/**
 * Wraps a transcript so Cmd/Ctrl+F, pressed while focus is inside it, opens a
 * small find bar above it instead of the browser's own find. Matches are
 * painted with the CSS Custom Highlight API, so the rendered transcript's DOM
 * (owned by React and react-markdown) is never rewritten.
 *
 * Focusable itself (`tabIndex={0}`), so clicking anywhere in the transcript
 * is enough to make the shortcut apply to it.
 */
export function FindableTranscript({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ ranges: Range[]; index: number }>({ ranges: [], index: 0 });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-read on every search and every step rather than cached, so a
  // transcript that changed while the bar was open (a live recording's
  // segments) is searched as it now stands.
  function search(nextQuery: string, index: number) {
    const ranges = contentRef.current ? findTextRanges(contentRef.current, nextQuery) : [];
    const n = ranges.length;
    setMatches({ ranges, index: n === 0 ? 0 : ((index % n) + n) % n });
  }

  function close() {
    setOpen(false);
    setQuery('');
    setMatches({ ranges: [], index: 0 });
    wrapperRef.current?.focus();
  }

  function onWrapperKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (open) inputRef.current?.select();
      else setOpen(true);
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      search(query, matches.index + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape') {
      // Stopped here so an enclosing dialog does not close with it.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const { ranges, index } = matches;
    const current = ranges[index];
    if (!current) return;
    current.startContainer.parentElement?.scrollIntoView?.({ block: 'nearest' });
    const registry = highlightRegistry();
    if (!registry) return;
    registry.set(ALL_MATCHES, new Highlight(...ranges));
    registry.set(CURRENT_MATCH, new Highlight(current));
    return () => {
      registry.delete(ALL_MATCHES);
      registry.delete(CURRENT_MATCH);
    };
  }, [matches]);

  const n = matches.ranges.length;
  const status = query.trim() === '' ? '' : n === 0 ? 'No matches' : `${matches.index + 1} of ${n}`;

  return (
    <div
      ref={wrapperRef}
      data-transcript-find
      tabIndex={0}
      onKeyDown={onWrapperKeyDown}
      className={cn('flex flex-col gap-2 outline-none', className)}
    >
      {open && (
        <div role="search" className="flex shrink-0 items-center gap-1">
          <Input
            ref={inputRef}
            aria-label="Find in transcript"
            placeholder="Find in transcript"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              search(event.target.value, 0);
            }}
            onKeyDown={onInputKeyDown}
            className="h-8 flex-1"
          />
          <span data-find-count aria-live="polite" className="min-w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {status}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Previous match" disabled={n === 0} onClick={() => search(query, matches.index - 1)}>
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next match" disabled={n === 0} onClick={() => search(query, matches.index + 1)}>
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={close}>
            <X />
          </Button>
        </div>
      )}
      {/* `contents`, so the wrapper adds no box of its own to the caller's layout. */}
      <div ref={contentRef} className="contents">
        {children}
      </div>
    </div>
  );
}
