/**
 * P1 tuning constants (docs/architecture.md §6.5). Their own module so the pure
 * helpers, the analyzer and the panel share one source without importing each
 * other. The settings `gaps.leadMs` / `gaps.trailMs` default to the first two.
 */

/** Speech precedes writing, so the lead margin is the larger one. */
export const GAP_LEAD_MS = 60_000;
/** Writing lags the point being made; a smaller tail is enough. */
export const GAP_TRAIL_MS = 30_000;
/** Speech up to this many characters is compared verbatim, with no summarization (J5). */
export const GAP_DIRECT_CHAR_BUDGET = 6000;
/** Characters per summarization chunk when the speech is over the direct budget. */
export const GAP_CHUNK_CHARS = 3000;
/** Characters a chunk repeats from the previous one, so a straddling sentence is summarized whole. */
export const GAP_CHUNK_OVERLAP = 300;
