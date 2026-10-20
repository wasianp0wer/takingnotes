/// <reference lib="webworker" />
import { firstMatches } from '@/search/matcher';

/**
 * Worker side of `regexRunner.ts`: matches one pattern against a batch of
 * texts off the main thread, so a slow pattern can be killed by terminating
 * the worker instead of freezing the tab.
 */
self.onmessage = (event: MessageEvent<{ id: number; pattern: string; texts: string[] }>) => {
  const { id, pattern, texts } = event.data;
  self.postMessage({ id, result: firstMatches(pattern, texts) });
};
