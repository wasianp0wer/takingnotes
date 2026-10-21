import { useEffect, useRef, useState } from 'react';

import { createRegexRunner, SUPERSEDED_ERROR } from '@/search/regexRunner';
import type { RegexRunner } from '@/search/regexRunner';
import { entryTitle } from '@/sessions/catalog';
import type { SessionCatalog } from '@/sessions/catalog';
import type { AdvancedFilter, EntryText, RegexOutcome } from '@/sessions/filter';

interface Settled {
  catalog: SessionCatalog;
  textByKey: ReadonlyMap<string, EntryText> | null;
  title: string;
  text: string;
  titleKeys: ReadonlySet<string> | null;
  textKeys: ReadonlySet<string> | null;
  error: string | null;
}

/**
 * Evaluates the advanced filter's regex title/text criteria in the regex
 * Worker (never on the main thread). `null` when regex is off or both fields
 * are blank. While inputs have changed since the last settled run, `pending`
 * is true; if only the catalog or text index changed (same patterns), the last
 * settled keys and error are still returned, so callers keep filtering by them. Titles run first, then texts (a runner serves one run at a time).
 * Superseded results are ignored; a runner created here is disposed on unmount.
 */
export function useRegexFilter(
  advanced: AdvancedFilter,
  catalog: SessionCatalog,
  textByKey: ReadonlyMap<string, EntryText> | null,
  runner?: RegexRunner,
): RegexOutcome | null {
  const title = advanced.title.trim();
  const text = advanced.text.trim();
  const active = advanced.regex && (title !== '' || text !== '');
  const [settled, setSettled] = useState<Settled | null>(null);
  const ownRef = useRef<RegexRunner | null>(null);

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
    const entries = [...catalog.sessions, ...catalog.uncategorized];

    const keysFor = async (
      pattern: string,
      texts: string[],
    ): Promise<{ keys: ReadonlySet<string> } | { error: string } | null> => {
      const result = await run.run(pattern, texts);
      if (!result.ok) return result.error === SUPERSEDED_ERROR ? null : { error: result.error };
      const keys = new Set<string>();
      result.matches.forEach((m, i) => {
        if (m !== null) keys.add(entries[i].key);
      });
      return { keys };
    };

    void (async () => {
      let titleKeys: ReadonlySet<string> | null = null;
      let textKeys: ReadonlySet<string> | null = null;
      let error: string | null = null;
      if (title !== '') {
        const r = await keysFor(
          title,
          entries.map((e) => entryTitle(e)),
        );
        if (cancelled || r === null) return;
        if ('error' in r) error = r.error;
        else titleKeys = r.keys;
      }
      if (error === null && text !== '' && textByKey !== null) {
        const r = await keysFor(
          text,
          entries.map((e) => textByKey.get(e.key)?.text ?? ''),
        );
        if (cancelled || r === null) return;
        if ('error' in r) error = r.error;
        else textKeys = r.keys;
      }
      if (cancelled) return;
      setSettled({ catalog, textByKey, title, text, titleKeys, textKeys, error });
    })();

    return () => {
      cancelled = true;
    };
  }, [active, title, text, catalog, textByKey, runner]);

  if (!active) return null;
  // Stale-while-revalidate: the catalog and text index are rebuilt on every
  // page turn and transcription signal during live capture. While the same
  // patterns re-run against them, keep the last settled keys (and error) so
  // the list does not widen to everything and then narrow again.
  const samePatterns = settled !== null && settled.title === title && settled.text === text;
  const fresh = samePatterns && settled.catalog === catalog && settled.textByKey === textByKey;
  const waitingForText = text !== '' && textByKey === null;
  return {
    pending: !fresh || waitingForText,
    error: samePatterns ? settled.error : null,
    titleKeys: samePatterns ? settled.titleKeys : null,
    textKeys: samePatterns ? settled.textKeys : null,
  };
}
