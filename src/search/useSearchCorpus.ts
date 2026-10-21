import { useEffect, useState } from 'react';

import { loadSearchCorpus } from '@/search/corpus';
import type { SearchCorpus } from '@/search/corpus';

/** Loads when `active` becomes true, and again on each re-activation, so results are never stale. */
export function useSearchCorpus(active: boolean): SearchCorpus | null {
  const [corpus, setCorpus] = useState<SearchCorpus | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadSearchCorpus()
      .then((loaded) => {
        if (!cancelled) setCorpus(loaded);
      })
      .catch((error: unknown) => {
        console.error('[search] corpus load failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return corpus;
}
