# P1 Gap Filling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For one page of a note, find the substantive points the linked recording's speech contains and the page's handwriting does not, store each as a reviewable `GapSuggestionRecord`, and let the user accept or reject them in `GapPanel`.

**Architecture:** Pure helpers decide which speech belongs to a page (`window.ts`), split it when it is too long (`chunk.ts`), and turn the model's untrusted JSON into points (`validate.ts`). A versioned prompt registry (`prompts.ts`) holds the two prompts — chunk→bullets summarization and the missing-points comparison. `analyzer.ts` composes them over a `TextGenerator` from `src/llm/ollamaText.ts`, persists through `src/storage/gaps.ts` and records per-page state with `setPageGapAnalysis`. `GapPanel.tsx` is the only UI, reading storage itself and taking an injected analyzer in tests.

**Tech Stack:** TypeScript 5.9, React 19, Vitest 3 + happy-dom + fake-indexeddb, `idb`. No testing-library (render with `createRoot` + `act`).

**Spec:** `docs/features/p1-spec.md` — read its "Design", "Tests" and "Assumptions" sections before starting any task.

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps` (branch `p1-gaps`). Use absolute paths. Never push. Never bare `git stash`.
- Create and edit only: `src/gaps/**` and `src/notes/GapPanel.tsx`. Do **NOT** edit `src/storage/**`, `src/llm/**`, `src/capture/**`, `src/app/**`, `src/main.tsx`, `src/transcription/**`, `src/audio/**`, `src/triage/**`, `src/device/**`, `src/utils/**`, `src/test/**`, `src/notes/**` other than `GapPanel.tsx`.
- `GapPanel` keeps its export name, its `GapPanelProps { noteId: string; pageId: string }` and its `aria-label="Gaps"` — `src/notes/NotesView.test.tsx` asserts that label and must keep passing unmodified.
- Import alias `@/` = `src/`. Tests sit beside sources as `*.test.ts(x)`.
- **Tests must never reach a real model**: inject a fake `TextGenerator`. No test may call `createOllamaTextGenerator`, `createConfiguredGapAnalyzer` or `fetch`.
- Component tests set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and render with `createRoot` inside `act` (pattern: `src/app/DeviceStatus.test.tsx`). Storage tests call `await resetDatabase()` from `@/test/resetDb` in `beforeEach`.
- Constants, exactly: `GAP_LEAD_MS = 60_000`, `GAP_TRAIL_MS = 30_000`, `GAP_DIRECT_CHAR_BUDGET = 6000`, `GAP_CHUNK_CHARS = 3000`, `GAP_CHUNK_OVERLAP = 300`.
- Prompt versions, exactly: `gap-summarize-<family>-v1`, `gap-compare-<family>-v1`, and for a summarized run `gap-summarize-<family>-v1+gap-compare-<family>-v1`. Families: `gemma`, `generic`.
- Error logging uses `console.error` with a `[gaps]` prefix.
- No new lint errors or warnings in touched files. The ESLint config warns on `react-hooks/set-state-in-effect` (never call setState synchronously in an effect body) and `react-hooks/refs` (never read a ref during render).
- Commands: one file `npx vitest run <path>`; everything `npx vitest run` (baseline: 769 passing in 70 files); types `npx tsc -b`; lint `npx eslint <files>`; build `npm run build`.
- Every commit message ends with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

1. **A page whose handwriting transcript is an empty string** (transcribed blank, or a page the model read as nothing): the comparison would report the entire lecture as missing. Task 6 test "an empty page transcript still runs and its prompt says the notes are empty" pins that it analyzes rather than crashing, and the prompt makes the emptiness explicit instead of shipping `undefined`.
2. **Two presses of "Find gaps" before the first resolves**: a doubled run writes a page's suggestions twice. Task 8 test "a second press while a run is in flight does not start a second run".
3. **The panel unmounts (page turn, tab switch) while a run is in flight**: a setState on an unmounted root is a React warning and a lost error. Task 8 test "unmounting mid-run is quiet".
4. **A model that returns hundreds of rows** (a near-degenerate run that still parsed): the panel and the store fill with noise. Task 4 caps a response at 50 points, test "caps a very long response".
5. **A recording whose `startedAt` is far from the page's stroke times** (a standalone recording accidentally linked, or clocks that disagree): the window matches no speech. Task 6 test "no speech in the window clears proposals and records done" pins that this is a clean empty result, not a model call on an empty string.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/gaps/constants.ts` | The five tuning constants, so nothing else has to import a sibling for them. |
| `src/gaps/window.ts` | `speechWindowForPage`, `segmentsInWindow`, `speechTextOf` — page↔recording time alignment, pure. |
| `src/gaps/chunk.ts` | `chunkSpeech` — overlapping character chunks, pure. |
| `src/gaps/prompts.ts` | The versioned two-prompt registry. |
| `src/gaps/validate.ts` | The model's untrusted JSON → `GapPoint[]`, plus `normalizeGapText` and `dropReviewed`. |
| `src/gaps/eligibility.ts` | Whether a page can be analyzed, and how to say why not. |
| `src/gaps/fakeTextGenerator.ts` | Test support: a scripted `TextGenerator`. Lives in `src/gaps/` because `src/test/` is not P1's to add to. |
| `src/gaps/analyzer.ts` | `createGapAnalyzer` — composes the above, persists, records meta. |
| `src/gaps/startGaps.ts` | `createConfiguredGapAnalyzer` — settings-wired, never called by a test. |
| `src/notes/GapPanel.tsx` | The review UI. |

---

### Task 1: Constants and the speech window (`constants.ts`, `window.ts`)

**Files:**
- Create: `src/gaps/constants.ts`
- Create: `src/gaps/window.ts`
- Test: `src/gaps/window.test.ts`

**Interfaces:**
- Consumes: `PageRecord`, `PageStroke`, `RecordingRecord`, `TranscriptSegment` from `@/storage/types`.
- Produces:
  - `GAP_LEAD_MS`, `GAP_TRAIL_MS`, `GAP_DIRECT_CHAR_BUDGET`, `GAP_CHUNK_CHARS`, `GAP_CHUNK_OVERLAP` from `@/gaps/constants`.
  - `speechWindowForPage(page: PageRecord, opts?: { leadMs?: number; trailMs?: number }): { fromMs: number; toMs: number } | null`
  - `segmentsInWindow(recording: RecordingRecord, fromMs: number, toMs: number): TranscriptSegment[]`
  - `speechTextOf(segments: TranscriptSegment[]): string`

- [ ] **Step 1: Write `src/gaps/constants.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test `src/gaps/window.test.ts`**

Build fixtures locally in the test file — no shared factory:

```ts
import { describe, expect, it } from 'vitest';

import { GAP_LEAD_MS, GAP_TRAIL_MS } from '@/gaps/constants';
import { segmentsInWindow, speechTextOf, speechWindowForPage } from '@/gaps/window';
import type {
  AudioTranscriptRecord,
  PageRecord,
  PageStroke,
  RecordingRecord,
  TranscriptSegment,
} from '@/storage/types';

function stroke(startedAt: number | undefined, endedAt: number | undefined, ts: Array<number | undefined> = []): PageStroke {
  return {
    points: ts.map((t) => ({ x: 0.5, y: 0.5, pressure: 1, ...(t === undefined ? {} : { t }) })),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 'page-1',
    noteId: 'note-1',
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [stroke(10_000, 12_000, [10_000, 12_000])],
    pointCount: 2,
    capturedAt: 10_000,
    render: null,
    transcript: null,
    finalizedAt: 20_000,
    ...overrides,
  };
}

function recording(segments: TranscriptSegment[] | null, startedAt = 1_000): RecordingRecord {
  const transcript: AudioTranscriptRecord | null =
    segments === null
      ? null
      : {
          text: segments.map((s) => s.text).join(' '),
          segments,
          model: 'Xenova/whisper-base.en',
          language: 'en',
          status: 'done',
          error: null,
          updatedAt: 0,
        };
  return {
    id: 'rec-1',
    sessionId: 'session-1',
    noteId: 'note-1',
    title: 'Recording',
    startedAt,
    endedAt: startedAt + 600_000,
    durationMs: 600_000,
    mimeType: 'audio/webm',
    byteLength: 10,
    transcript,
  };
}

describe('speechWindowForPage', () => {
  it('spans the first stroke to finalizedAt, widened by the default margins', () => {
    expect(speechWindowForPage(page())).toEqual({
      fromMs: 10_000 - GAP_LEAD_MS,
      toMs: 20_000 + GAP_TRAIL_MS,
    });
  });

  it('honours custom margins, including zero', () => {
    expect(speechWindowForPage(page(), { leadMs: 1_000, trailMs: 2_000 })).toEqual({
      fromMs: 9_000,
      toMs: 22_000,
    });
    expect(speechWindowForPage(page(), { leadMs: 0, trailMs: 0 })).toEqual({
      fromMs: 10_000,
      toMs: 20_000,
    });
  });

  it('falls back to point times when strokes carry no startedAt/endedAt', () => {
    const p = page({ strokes: [stroke(undefined, undefined, [5_000, 7_000])], finalizedAt: null });
    expect(speechWindowForPage(p, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 5_000, toMs: 7_000 });
  });

  it('ends at the last stroke when finalizedAt is null or absent', () => {
    const open = page({ finalizedAt: null });
    expect(speechWindowForPage(open, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 10_000, toMs: 12_000 });
    const legacy = page();
    delete legacy.finalizedAt;
    expect(speechWindowForPage(legacy, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 10_000, toMs: 12_000 });
  });

  it('is null when there is nothing timestamped to align against', () => {
    expect(speechWindowForPage(page({ strokes: [] }))).toBeNull();
    expect(speechWindowForPage(page({ strokes: [stroke(undefined, undefined, [])] }))).toBeNull();
    expect(
      speechWindowForPage(page({ strokes: [stroke(undefined, undefined, [undefined, undefined])] })),
    ).toBeNull();
  });

  it('takes the min and max across strokes stored out of order', () => {
    const p = page({
      strokes: [stroke(30_000, 31_000, [30_000]), stroke(4_000, 5_000, [4_000])],
      finalizedAt: null,
    });
    expect(speechWindowForPage(p, { leadMs: 0, trailMs: 0 })).toEqual({ fromMs: 4_000, toMs: 31_000 });
  });
});

describe('segmentsInWindow', () => {
  const segs: TranscriptSegment[] = [
    { startMs: 0, endMs: 1_000, text: 'before' },
    { startMs: 4_000, endMs: 6_000, text: 'straddles the start' },
    { startMs: 7_000, endMs: 8_000, text: 'inside' },
    { startMs: 9_000, endMs: 12_000, text: 'straddles the end' },
    { startMs: 20_000, endMs: 21_000, text: 'after' },
  ];

  // startedAt 1000: window 6000..11000 absolute is 5000..10000 in offsets.
  it('keeps every overlapping segment and nothing else', () => {
    const kept = segmentsInWindow(recording(segs), 6_000, 11_000).map((s) => s.text);
    expect(kept).toEqual(['straddles the start', 'inside', 'straddles the end']);
  });

  it('keeps a segment that spans the whole window', () => {
    const spanning: TranscriptSegment[] = [{ startMs: 0, endMs: 100_000, text: 'all of it' }];
    expect(segmentsInWindow(recording(spanning), 6_000, 11_000)).toHaveLength(1);
  });

  it('includes a segment touching either boundary and excludes one a millisecond outside', () => {
    const touching: TranscriptSegment[] = [
      { startMs: 0, endMs: 5_000, text: 'ends at fromMs' },
      { startMs: 10_000, endMs: 30_000, text: 'starts at toMs' },
      { startMs: 0, endMs: 4_999, text: 'ends just before' },
      { startMs: 10_001, endMs: 30_000, text: 'starts just after' },
    ];
    const kept = segmentsInWindow(recording(touching), 6_000, 11_000).map((s) => s.text);
    expect(kept).toEqual(['ends at fromMs', 'starts at toMs']);
  });

  it('is empty when the recording has no transcript or no segments', () => {
    expect(segmentsInWindow(recording(null), 0, 1_000_000)).toEqual([]);
    expect(segmentsInWindow(recording([]), 0, 1_000_000)).toEqual([]);
  });

  it('returns segments in startMs order even when stored out of order', () => {
    const unordered: TranscriptSegment[] = [
      { startMs: 8_000, endMs: 9_000, text: 'second' },
      { startMs: 6_000, endMs: 7_000, text: 'first' },
    ];
    expect(segmentsInWindow(recording(unordered), 0, 1_000_000).map((s) => s.text)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('speechTextOf', () => {
  it('joins the text with single spaces, dropping the empty ones', () => {
    expect(
      speechTextOf([
        { startMs: 0, endMs: 1, text: ' one ' },
        { startMs: 1, endMs: 2, text: '   ' },
        { startMs: 2, endMs: 3, text: 'two' },
        { startMs: 3, endMs: 4, text: '' },
      ]),
    ).toBe('one two');
  });

  it('is empty for no segments', () => {
    expect(speechTextOf([])).toBe('');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run src/gaps/window.test.ts`
Expected: FAIL — cannot resolve `@/gaps/window`.

- [ ] **Step 4: Write `src/gaps/window.ts`**

```ts
import { GAP_LEAD_MS, GAP_TRAIL_MS } from '@/gaps/constants';
import type { PageRecord, PageStroke, RecordingRecord, TranscriptSegment } from '@/storage/types';

export interface SpeechWindow {
  fromMs: number;
  toMs: number;
}

export interface SpeechWindowOptions {
  leadMs?: number;
  trailMs?: number;
}

/** Epoch ms of a stroke's first and last point, or `null` when it carries no times. */
function strokeSpan(stroke: PageStroke): SpeechWindow | null {
  const times = stroke.points
    .map((p) => p.t)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  const first = typeof stroke.startedAt === 'number' ? stroke.startedAt : times[0];
  const last = typeof stroke.endedAt === 'number' ? stroke.endedAt : times[times.length - 1];
  if (typeof first !== 'number' || typeof last !== 'number') return null;
  return { fromMs: Math.min(first, last), toMs: Math.max(first, last) };
}

/**
 * The absolute-time window of speech that belongs to a page: its writing span,
 * widened by a lead (speech precedes writing) and a smaller trail.
 *
 * `null` when the page has no strokes, or none of them carries a timestamp -
 * a ROM or legacy page has nothing to align against, which A22 makes a skip
 * rather than a failure.
 *
 * The end is `finalizedAt` when the page has one: writing often stops well
 * before the page is turned, and the speech in between is exactly what a gap
 * analysis is looking for. An absent `finalizedAt` (a v1 row) is not a
 * timestamp, so it falls back to the last stroke like an open page does.
 */
export function speechWindowForPage(
  page: PageRecord,
  opts: SpeechWindowOptions = {},
): SpeechWindow | null {
  const spans = page.strokes.map(strokeSpan).filter((s): s is SpeechWindow => s !== null);
  if (spans.length === 0) return null;

  const firstStroke = Math.min(...spans.map((s) => s.fromMs));
  const lastStroke = Math.max(...spans.map((s) => s.toMs));
  const end = typeof page.finalizedAt === 'number' ? page.finalizedAt : lastStroke;

  const leadMs = opts.leadMs ?? GAP_LEAD_MS;
  const trailMs = opts.trailMs ?? GAP_TRAIL_MS;
  return { fromMs: firstStroke - leadMs, toMs: Math.max(end, lastStroke) + trailMs };
}

/**
 * The recording's segments overlapping an absolute-time window, in order.
 * Segment times are offsets from `recording.startedAt` (see `TranscriptSegment`).
 *
 * Overlap is inclusive at both ends: the margins are already an estimate, so a
 * segment that merely touches the boundary is speech worth comparing.
 */
export function segmentsInWindow(
  recording: RecordingRecord,
  fromMs: number,
  toMs: number,
): TranscriptSegment[] {
  const segments = recording.transcript?.segments ?? [];
  const base = recording.startedAt;
  return segments
    .filter((s) => base + s.endMs >= fromMs && base + s.startMs <= toMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** One flat string for the comparison (or the chunker), skipping silent segments. */
export function speechTextOf(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(' ');
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/gaps/window.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/gaps/constants.ts src/gaps/window.ts src/gaps/window.test.ts
git add src/gaps/constants.ts src/gaps/window.ts src/gaps/window.test.ts
git commit -m "$(printf 'feat(gaps): speech window for a page\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 2: Chunking the speech (`chunk.ts`)

**Files:**
- Create: `src/gaps/chunk.ts`
- Test: `src/gaps/chunk.test.ts`

**Interfaces:**
- Consumes: `GAP_CHUNK_CHARS`, `GAP_CHUNK_OVERLAP` from `@/gaps/constants` (Task 1).
- Produces: `chunkSpeech(text: string, opts?: { budget?: number; overlap?: number }): string[]`

- [ ] **Step 1: Write the failing test `src/gaps/chunk.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { chunkSpeech } from '@/gaps/chunk';
import { GAP_CHUNK_CHARS, GAP_CHUNK_OVERLAP } from '@/gaps/constants';

/** `words` space-separated words, each 4 characters, so lengths are predictable. */
function speech(words: number): string {
  return Array.from({ length: words }, (_, i) => `w${String(i).padStart(3, '0')}`).join(' ');
}

describe('chunkSpeech', () => {
  it('returns one trimmed chunk when the text fits the budget', () => {
    expect(chunkSpeech('  a short sentence  ', { budget: 100, overlap: 10 })).toEqual([
      'a short sentence',
    ]);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkSpeech('', { budget: 100, overlap: 10 })).toEqual([]);
    expect(chunkSpeech('   \n  ', { budget: 100, overlap: 10 })).toEqual([]);
  });

  it('splits long text into chunks within the budget', () => {
    const chunks = chunkSpeech(speech(400), { budget: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
  });

  it('covers every word of the input and overlaps consecutive chunks', () => {
    const text = speech(400);
    const chunks = chunkSpeech(text, { budget: 200, overlap: 40 });
    for (const word of text.split(' ')) {
      expect(chunks.some((c) => c.includes(word))).toBe(true);
    }
    // Consecutive chunks share text: the tail of one starts inside the next.
    for (let i = 1; i < chunks.length; i += 1) {
      const tail = chunks[i - 1].slice(-20);
      expect(chunks[i].includes(tail)).toBe(true);
    }
  });

  it('breaks on whitespace, never mid-word', () => {
    for (const chunk of chunkSpeech(speech(400), { budget: 200, overlap: 40 })) {
      expect(chunk).toMatch(/^w\d{3}/);
      expect(chunk).toMatch(/w\d{3}$/);
    }
  });

  it('still terminates on a single word longer than the budget', () => {
    const chunks = chunkSpeech('x'.repeat(500), { budget: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join('')).toContain('x'.repeat(100));
  });

  it('clamps an overlap at or above the budget and still terminates', () => {
    const chunks = chunkSpeech(speech(200), { budget: 100, overlap: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('defaults to the P1 constants and ignores a non-positive budget', () => {
    const long = speech(3000);
    expect(long.length).toBeGreaterThan(GAP_CHUNK_CHARS);
    const defaults = chunkSpeech(long);
    for (const chunk of defaults) expect(chunk.length).toBeLessThanOrEqual(GAP_CHUNK_CHARS);
    expect(chunkSpeech(long, { budget: 0, overlap: GAP_CHUNK_OVERLAP })).toEqual(defaults);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/gaps/chunk.test.ts`
Expected: FAIL — cannot resolve `@/gaps/chunk`.

- [ ] **Step 3: Write `src/gaps/chunk.ts`**

```ts
import { GAP_CHUNK_CHARS, GAP_CHUNK_OVERLAP } from '@/gaps/constants';

export interface ChunkOptions {
  budget?: number;
  overlap?: number;
}

/** The last whitespace at or before `limit`, or -1 when there is none. */
function lastBreakBefore(text: string, limit: number): number {
  for (let i = limit; i > 0; i -= 1) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}

/**
 * Splits speech into overlapping chunks for summarization (J5). Each chunk is at
 * most `budget` characters and, where the text allows, ends on a whitespace
 * boundary so a chunk never stops mid-word. The next chunk starts roughly
 * `overlap` characters earlier, so a sentence straddling a cut is summarized
 * whole at least once.
 *
 * Deliberately character-based rather than sentence-based: a Whisper transcript
 * has unreliable punctuation, and the budget that matters is the model's context,
 * which is measured in characters.
 */
export function chunkSpeech(text: string, opts: ChunkOptions = {}): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const rawBudget = opts.budget ?? GAP_CHUNK_CHARS;
  const budget = rawBudget > 0 ? rawBudget : GAP_CHUNK_CHARS;
  if (trimmed.length <= budget) return [trimmed];

  // An overlap at or above the budget would never advance; clamped rather than
  // rejected, because it is a tuning value and a stall is unrecoverable.
  const overlap = Math.max(0, Math.min(opts.overlap ?? GAP_CHUNK_OVERLAP, budget - 1));

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const hardEnd = Math.min(start + budget, trimmed.length);
    let end = hardEnd;
    if (hardEnd < trimmed.length) {
      const brk = lastBreakBefore(trimmed, hardEnd);
      // Only honour a break that leaves a chunk worth sending; a long unbroken
      // run (a URL, a word-less transcript) is cut at the budget instead.
      if (brk > start) end = brk;
    }
    const chunk = trimmed.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= trimmed.length) break;

    let next = end - overlap;
    if (next > start) {
      const brk = lastBreakBefore(trimmed, next);
      if (brk > start) next = brk + 1;
    }
    // The start must always move forward, whatever the boundary search found.
    start = next > start ? next : end;
  }
  return chunks;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/gaps/chunk.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/gaps/chunk.ts src/gaps/chunk.test.ts
git add src/gaps/chunk.ts src/gaps/chunk.test.ts
git commit -m "$(printf 'feat(gaps): chunk speech for summarization\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 3: The prompt registry (`prompts.ts`)

**Files:**
- Create: `src/gaps/prompts.ts`
- Test: `src/gaps/prompts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Pattern to follow: `src/transcription/prompts.ts` (registry keyed by family, `promptVersion` per family, pure `getPromptFor`).
- Produces:
  - `type GapPromptKind = 'summarize' | 'compare'`
  - `interface GapPromptSpec { kind: GapPromptKind; family: string; promptVersion: string; system: string }`
  - `interface SummarizeInput { chunk: string; index: number; total: number }`
  - `interface CompareInput { notes: string; speech: string; summarized: boolean }`
  - `gapModelFamily(model: string): string`
  - `getGapPrompt(kind: 'summarize', model: string): GapPromptSpec & { build(input: SummarizeInput): string }`
  - `getGapPrompt(kind: 'compare', model: string): GapPromptSpec & { build(input: CompareInput): string }`
  - `gapPromptVersion(model: string, summarized: boolean): string`
  - `GAP_KINDS: readonly GapKind[]` (the six, in spec order) — the analyzer's validator and the panel's labels both need the list; export it here so the prompt text and the validator cannot drift apart.

- [ ] **Step 1: Write the failing test `src/gaps/prompts.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { GAP_KINDS, gapModelFamily, gapPromptVersion, getGapPrompt } from '@/gaps/prompts';

const MODELS = ['gemma4:12b', 'mistral:7b'];

describe('gapModelFamily', () => {
  it('maps gemma names, with namespace and tag stripped', () => {
    expect(gapModelFamily('gemma4:12b')).toBe('gemma');
    expect(gapModelFamily('library/gemma4:latest')).toBe('gemma');
    expect(gapModelFamily('GEMMA3:4B')).toBe('gemma');
  });

  it('falls back to generic', () => {
    expect(gapModelFamily('mistral:7b')).toBe('generic');
    expect(gapModelFamily('')).toBe('generic');
  });
});

describe('getGapPrompt', () => {
  it('versions each prompt by kind and family', () => {
    expect(getGapPrompt('compare', 'gemma4:12b').promptVersion).toBe('gap-compare-gemma-v1');
    expect(getGapPrompt('summarize', 'gemma4:12b').promptVersion).toBe('gap-summarize-gemma-v1');
    expect(getGapPrompt('compare', 'mistral:7b').promptVersion).toBe('gap-compare-generic-v1');
    expect(getGapPrompt('summarize', 'mistral:7b').promptVersion).toBe('gap-summarize-generic-v1');
  });

  it('never shares a version between the two kinds', () => {
    for (const model of MODELS) {
      expect(getGapPrompt('compare', model).promptVersion).not.toBe(
        getGapPrompt('summarize', model).promptVersion,
      );
    }
  });

  it('is deterministic', () => {
    const a = getGapPrompt('compare', 'gemma4:12b');
    const b = getGapPrompt('compare', 'gemma4:12b');
    expect(a.promptVersion).toBe(b.promptVersion);
    expect(a.system).toBe(b.system);
    expect(a.build({ notes: 'n', speech: 's', summarized: false })).toBe(
      b.build({ notes: 'n', speech: 's', summarized: false }),
    );
  });

  it('asks every family for the JSON shape P1 stores', () => {
    for (const model of MODELS) {
      const spec = getGapPrompt('compare', model);
      const text = `${spec.system}\n${spec.build({ notes: 'n', speech: 's', summarized: false })}`;
      for (const kind of GAP_KINDS) expect(text).toContain(kind);
      expect(text).toContain('text');
      expect(text).toContain('kind');
      expect(text).toContain('sourceQuote');
      expect(text).toContain('JSON');
      expect(text).toMatch(/empty (JSON )?array|\[\]/);
      expect(text.length).toBeGreaterThan(200);
    }
  });

  it('asks every family to summarize substantively, as bullet points', () => {
    for (const model of MODELS) {
      const spec = getGapPrompt('summarize', model);
      const text = `${spec.system}\n${spec.build({ chunk: 'c', index: 0, total: 3 })}`;
      expect(text.toLowerCase()).toContain('bullet');
      expect(text.toLowerCase()).toContain('substantive');
      expect(text).toContain('c');
    }
  });

  it('embeds what it is given and keeps the two prompts apart', () => {
    const compare = getGapPrompt('compare', 'gemma4:12b');
    const built = compare.build({ notes: 'THE-NOTES', speech: 'THE-SPEECH', summarized: false });
    expect(built).toContain('THE-NOTES');
    expect(built).toContain('THE-SPEECH');
    expect(built).not.toContain('sourceQuote-free');
    const summarize = getGapPrompt('summarize', 'gemma4:12b');
    expect(summarize.build({ chunk: 'THE-CHUNK', index: 1, total: 4 })).toContain('THE-CHUNK');
    expect(summarize.build({ chunk: 'x', index: 1, total: 4 })).not.toContain('sourceQuote');
  });

  it('says when the notes are empty and when the speech was summarized', () => {
    const compare = getGapPrompt('compare', 'gemma4:12b');
    expect(compare.build({ notes: '', speech: 's', summarized: false }).toLowerCase()).toContain(
      'nothing',
    );
    expect(compare.build({ notes: 'n', speech: 's', summarized: true }).toLowerCase()).toContain(
      'summar',
    );
  });
});

describe('gapPromptVersion', () => {
  it('is the compare version for a direct comparison', () => {
    expect(gapPromptVersion('gemma4:12b', false)).toBe('gap-compare-gemma-v1');
  });

  it('names both prompts, summarize first, for a summarized comparison', () => {
    expect(gapPromptVersion('gemma4:12b', true)).toBe(
      'gap-summarize-gemma-v1+gap-compare-gemma-v1',
    );
    expect(gapPromptVersion('mistral:7b', true)).toBe(
      'gap-summarize-generic-v1+gap-compare-generic-v1',
    );
  });
});

describe('GAP_KINDS', () => {
  it('is the six kinds the storage type allows, in spec order', () => {
    expect(GAP_KINDS).toEqual([
      'claim',
      'definition',
      'name-or-date',
      'example',
      'argument-step',
      'other',
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/gaps/prompts.test.ts`
Expected: FAIL — cannot resolve `@/gaps/prompts`.

- [ ] **Step 3: Write `src/gaps/prompts.ts`**

Write a registry, not inline strings (D8a): a `Record<family, …>` per kind, a pure `getGapPrompt`, and the version derived from kind and family so a tuned prompt is a new version. Required content, which the test above pins:

- `GAP_KINDS` exactly `['claim', 'definition', 'name-or-date', 'example', 'argument-step', 'other']`, typed `readonly GapKind[]` against `@/storage/types`.
- `gapModelFamily`: lowercase, trim, take the last `/` segment, cut at `:`; `/^gemma/` → `'gemma'`, else `'generic'`.
- Compare prompt (both families), as a `system` string plus a `build` that interpolates: the task is to list substantive points **stated in the lecture and absent from the notes** (J1: judged on substance, not wording — a point written in different words, or in shorthand, counts as present); J6's substantive-only rule (claims, definitions, names and dates, argument steps, worked examples, anything flagged as important or examinable — never asides, greetings, repetition or a restatement of what is written); output a JSON array of objects `{ "text": string, "kind": one of the six, "sourceQuote": verbatim from the lecture }`; `[]` when nothing substantive is missing; no commentary, no code fences; never invent a quote. `build` labels the two blocks (`NOTES (what the student wrote):` / `LECTURE (what was said):`), writes `(the student wrote nothing on this page)` when `notes.trim()` is empty, and adds one line when `summarized` is true saying the lecture text below is a summary of the speech in bullet points rather than a verbatim transcript, so a quote may be a bullet.
- Summarize prompt (both families): reduce one chunk of lecture speech to key bullet points, substantive only (same J6 list), one point per line starting `- `, keeping names, dates and numbers verbatim, no preamble, and "return nothing at all if the passage contains no substantive content". `build` states the chunk's position (`Passage {index + 1} of {total}`) so a model does not treat a mid-passage cut as a whole lecture.
- The `gemma` variants differ from `generic` by the two instructions gemma needs in practice (as the transcription registry already found): an explicit "do not pad the output with repeated lines", and "output JSON only — do not restate the instructions".
- `gapPromptVersion(model, summarized)`: the compare version alone, or `` `${summarizeVersion}+${compareVersion}` ``.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/gaps/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/gaps/prompts.ts src/gaps/prompts.test.ts
git add src/gaps/prompts.ts src/gaps/prompts.test.ts
git commit -m "$(printf 'feat(gaps): versioned prompt registry for summarize and compare\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 4: Validating the model's JSON (`validate.ts`)

**Files:**
- Create: `src/gaps/validate.ts`
- Test: `src/gaps/validate.test.ts`

**Interfaces:**
- Consumes: `GAP_KINDS` from `@/gaps/prompts` (Task 3); `GapKind`, `GapSuggestionRecord` from `@/storage/types`.
- Produces:
  - `interface GapPoint { text: string; kind: GapKind; sourceQuote: string }`
  - `GAP_TEXT_MAX = 2000`, `GAP_MAX_POINTS = 50`
  - `validateGapPoints(value: unknown): GapPoint[]`
  - `normalizeGapText(text: string): string`
  - `dropReviewed(points: GapPoint[], existing: GapSuggestionRecord[]): GapPoint[]`

- [ ] **Step 1: Write the failing test `src/gaps/validate.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import {
  dropReviewed,
  GAP_MAX_POINTS,
  GAP_TEXT_MAX,
  normalizeGapText,
  validateGapPoints,
} from '@/gaps/validate';
import type { GapStatus, GapSuggestionRecord } from '@/storage/types';

function suggestion(text: string, status: GapStatus): GapSuggestionRecord {
  return {
    id: `gap-${text}-${status}`,
    noteId: 'note-1',
    pageId: 'page-1',
    recordingId: 'rec-1',
    fromMs: 0,
    toMs: 1,
    text,
    kind: 'claim',
    sourceQuote: 'said it',
    status,
    model: 'gemma4:12b',
    promptVersion: 'gap-compare-gemma-v1',
    summarized: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('validateGapPoints', () => {
  it('keeps a clean array', () => {
    const points = validateGapPoints([
      { text: 'A', kind: 'claim', sourceQuote: 'a' },
      { text: 'B', kind: 'definition', sourceQuote: 'b' },
      { text: 'C', kind: 'name-or-date', sourceQuote: 'c' },
    ]);
    expect(points).toEqual([
      { text: 'A', kind: 'claim', sourceQuote: 'a' },
      { text: 'B', kind: 'definition', sourceQuote: 'b' },
      { text: 'C', kind: 'name-or-date', sourceQuote: 'c' },
    ]);
  });

  it('unwraps the usual wrapper objects', () => {
    const row = [{ text: 'A', kind: 'claim', sourceQuote: 'a' }];
    expect(validateGapPoints({ points: row })).toHaveLength(1);
    expect(validateGapPoints({ gaps: row })).toHaveLength(1);
    expect(validateGapPoints({ missing: row })).toHaveLength(1);
  });

  it('drops bad rows rather than casting them', () => {
    const points = validateGapPoints([
      null,
      'a string',
      42,
      { kind: 'claim' },
      { text: '   ', kind: 'claim' },
      { text: 7, kind: 'claim' },
      { text: 'kept', kind: 'claim', sourceQuote: 'q' },
    ]);
    expect(points).toEqual([{ text: 'kept', kind: 'claim', sourceQuote: 'q' }]);
  });

  it('accepts every valid kind and falls back to other', () => {
    const kinds = ['claim', 'definition', 'name-or-date', 'example', 'argument-step', 'other'];
    const points = validateGapPoints(
      kinds.map((kind, i) => ({ text: `t${i}`, kind, sourceQuote: 'q' })),
    );
    expect(points.map((p) => p.kind)).toEqual(kinds);
    expect(validateGapPoints([{ text: 'x', kind: 'nonsense', sourceQuote: 'q' }])[0].kind).toBe(
      'other',
    );
    expect(validateGapPoints([{ text: 'y', sourceQuote: 'q' }])[0].kind).toBe('other');
  });

  it('coerces a missing or non-string quote to empty', () => {
    expect(validateGapPoints([{ text: 'x', kind: 'claim' }])[0].sourceQuote).toBe('');
    expect(validateGapPoints([{ text: 'x', kind: 'claim', sourceQuote: 9 }])[0].sourceQuote).toBe('');
  });

  it('trims and caps text and quote', () => {
    const long = 'z'.repeat(GAP_TEXT_MAX + 500);
    const [point] = validateGapPoints([
      { text: `  padded  `, kind: 'claim', sourceQuote: `  ${long}  ` },
    ]);
    expect(point.text).toBe('padded');
    expect(point.sourceQuote.length).toBe(GAP_TEXT_MAX);
  });

  it('throws on a value that is not an array or a wrapper', () => {
    expect(() => validateGapPoints('nope')).toThrow();
    expect(() => validateGapPoints(42)).toThrow();
    expect(() => validateGapPoints(null)).toThrow();
    expect(() => validateGapPoints({ answer: 'no gaps' })).toThrow();
  });

  it('accepts an empty array: the model found nothing', () => {
    expect(validateGapPoints([])).toEqual([]);
  });

  it('collapses duplicates within one response', () => {
    const points = validateGapPoints([
      { text: 'The Treaty was 1919.', kind: 'name-or-date', sourceQuote: 'a' },
      { text: 'the treaty was 1919', kind: 'claim', sourceQuote: 'b' },
    ]);
    expect(points).toHaveLength(1);
  });

  it('caps a very long response', () => {
    const rows = Array.from({ length: GAP_MAX_POINTS + 20 }, (_, i) => ({
      text: `point ${i}`,
      kind: 'claim',
      sourceQuote: 'q',
    }));
    expect(validateGapPoints(rows)).toHaveLength(GAP_MAX_POINTS);
  });
});

describe('normalizeGapText', () => {
  it('ignores case, surrounding punctuation and runs of whitespace', () => {
    expect(normalizeGapText('  The  Treaty\nwas 1919. ')).toBe(normalizeGapText('the treaty was 1919'));
  });
});

describe('dropReviewed', () => {
  const points = [
    { text: 'Accepted already', kind: 'claim' as const, sourceQuote: 'a' },
    { text: 'rejected already!', kind: 'claim' as const, sourceQuote: 'b' },
    { text: 'Still proposed', kind: 'claim' as const, sourceQuote: 'c' },
    { text: 'Brand new', kind: 'claim' as const, sourceQuote: 'd' },
  ];

  it('removes points already accepted or rejected and keeps the rest', () => {
    const kept = dropReviewed(points, [
      suggestion('accepted already', 'accepted'),
      suggestion('Rejected already', 'rejected'),
      suggestion('Still proposed', 'proposed'),
    ]);
    expect(kept.map((p) => p.text)).toEqual(['Still proposed', 'Brand new']);
  });

  it('keeps everything when nothing was reviewed', () => {
    expect(dropReviewed(points, [])).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/gaps/validate.test.ts`
Expected: FAIL — cannot resolve `@/gaps/validate`.

- [ ] **Step 3: Write `src/gaps/validate.ts`**

```ts
import { GAP_KINDS } from '@/gaps/prompts';
import type { GapKind, GapSuggestionRecord } from '@/storage/types';

/** One missing point, as the comparison prompt returns it. */
export interface GapPoint {
  text: string;
  kind: GapKind;
  sourceQuote: string;
}

/** A row longer than this is a degenerate answer, not a point; it is truncated. */
export const GAP_TEXT_MAX = 2000;
/** More than this from one page is noise; the rest are dropped. */
export const GAP_MAX_POINTS = 50;

/** The keys a model reaches for when it wraps its array in an object. */
const WRAPPER_KEYS = ['points', 'gaps', 'missing', 'missingPoints', 'items', 'result'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    for (const key of WRAPPER_KEYS) {
      if (Array.isArray(value[key])) return value[key] as unknown[];
    }
  }
  throw new Error('The model did not return a JSON array of missing points.');
}

const cap = (text: string): string => text.trim().slice(0, GAP_TEXT_MAX);

/**
 * Comparison key for "the same point". Deliberately loose - case, whitespace and
 * surrounding punctuation only - because the model restates a point differently
 * between runs, and a near-duplicate shown twice is a worse failure than a
 * reworded one slipping through (P1-A3).
 */
export function normalizeGapText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

function toPoint(row: unknown): GapPoint | null {
  if (!isRecord(row)) return null;
  const text = typeof row.text === 'string' ? cap(row.text) : '';
  if (text.length === 0) return null;
  const kind = GAP_KINDS.includes(row.kind as GapKind) ? (row.kind as GapKind) : 'other';
  const sourceQuote = typeof row.sourceQuote === 'string' ? cap(row.sourceQuote) : '';
  return { text, kind, sourceQuote };
}

/**
 * The `validate` for `generateJson` (docs/architecture.md §6.4): model JSON is
 * untrusted input. A row that is not a point is dropped, because one bad row
 * should cost one suggestion rather than the whole analysis; a response that is
 * not a list of points at all throws, because a model answering in prose has not
 * done the task and must not look like "no gaps found".
 */
export function validateGapPoints(value: unknown): GapPoint[] {
  const rows = asArray(value);
  const seen = new Set<string>();
  const points: GapPoint[] = [];
  for (const row of rows) {
    const point = toPoint(row);
    if (point === null) continue;
    const key = normalizeGapText(point.text);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    points.push(point);
    if (points.length === GAP_MAX_POINTS) break;
  }
  return points;
}

/**
 * Removes points the user has already ruled on (A23): keeping a rejected record
 * only stops it resurfacing if the analyzer consults it. `proposed` records are
 * not consulted - a re-run replaces those anyway.
 */
export function dropReviewed(
  points: GapPoint[],
  existing: GapSuggestionRecord[],
): GapPoint[] {
  const reviewed = new Set(
    existing
      .filter((g) => g.status === 'accepted' || g.status === 'rejected')
      .map((g) => normalizeGapText(g.text)),
  );
  return points.filter((p) => !reviewed.has(normalizeGapText(p.text)));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/gaps/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/gaps/validate.ts src/gaps/validate.test.ts
git add src/gaps/validate.ts src/gaps/validate.test.ts
git commit -m "$(printf 'feat(gaps): validate the model JSON, dropping bad rows\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 5: Eligibility (`eligibility.ts`)

**Files:**
- Create: `src/gaps/eligibility.ts`
- Test: `src/gaps/eligibility.test.ts`

**Interfaces:**
- Consumes: `SpeechWindow` from `@/gaps/window` (Task 1); `PageRecord`, `RecordingRecord`, `TranscriptStatus` from `@/storage/types`.
- Produces:
  - `type GapSkipReason = 'no-strokes' | 'no-timestamps' | 'no-recording' | 'recording-transcript' | 'page-transcript'`
  - `type GapEligibility = { ok: true } | { ok: false; reason: GapSkipReason }`
  - `gapEligibility(page: PageRecord, recording: RecordingRecord | null, window: SpeechWindow | null): GapEligibility`
  - `describeGapSkip(reason: GapSkipReason): string`

- [ ] **Step 1: Write the failing test `src/gaps/eligibility.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { describeGapSkip, gapEligibility, type GapSkipReason } from '@/gaps/eligibility';
import type {
  AudioTranscriptRecord,
  PageRecord,
  RecordingRecord,
  TranscriptRecord,
  TranscriptStatus,
} from '@/storage/types';

const pageTranscript = (status: TranscriptStatus): TranscriptRecord => ({
  markdown: 'notes',
  model: 'gemma4:12b',
  promptVersion: 'gemma-v1',
  status,
  error: null,
  updatedAt: 0,
});

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 'page-1',
    noteId: 'note-1',
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: [{ points: [{ x: 0, y: 0, pressure: 1, t: 10 }], startedAt: 10, endedAt: 10 }],
    pointCount: 1,
    capturedAt: 0,
    render: null,
    transcript: pageTranscript('done'),
    finalizedAt: 100,
    ...overrides,
  };
}

const audio = (status: TranscriptStatus): AudioTranscriptRecord => ({
  text: 'speech',
  segments: [{ startMs: 0, endMs: 10, text: 'speech' }],
  model: 'Xenova/whisper-base.en',
  language: 'en',
  status,
  error: null,
  updatedAt: 0,
});

function recording(transcript: AudioTranscriptRecord | null): RecordingRecord {
  return {
    id: 'rec-1',
    sessionId: 'session-1',
    noteId: 'note-1',
    title: 'Recording',
    startedAt: 0,
    endedAt: 1000,
    durationMs: 1000,
    mimeType: 'audio/webm',
    byteLength: 1,
    transcript,
  };
}

const window = { fromMs: 0, toMs: 1000 };

describe('gapEligibility', () => {
  it('is ok with strokes, a window and both transcripts done', () => {
    expect(gapEligibility(page(), recording(audio('done')), window)).toEqual({ ok: true });
  });

  it('skips a page with no strokes', () => {
    expect(gapEligibility(page({ strokes: [], pointCount: 0 }), recording(audio('done')), null)).toEqual({
      ok: false,
      reason: 'no-strokes',
    });
  });

  it('skips a page whose strokes carry no usable timestamps', () => {
    expect(gapEligibility(page(), recording(audio('done')), null)).toEqual({
      ok: false,
      reason: 'no-timestamps',
    });
  });

  it('skips a note with no linked recording', () => {
    expect(gapEligibility(page(), null, window)).toEqual({ ok: false, reason: 'no-recording' });
  });

  it('skips until the recording transcript is done', () => {
    for (const status of ['pending', 'running', 'failed'] as TranscriptStatus[]) {
      expect(gapEligibility(page(), recording(audio(status)), window)).toEqual({
        ok: false,
        reason: 'recording-transcript',
      });
    }
    expect(gapEligibility(page(), recording(null), window)).toEqual({
      ok: false,
      reason: 'recording-transcript',
    });
  });

  it('skips until the page transcript is done', () => {
    for (const status of ['pending', 'running', 'failed'] as TranscriptStatus[]) {
      expect(
        gapEligibility(page({ transcript: pageTranscript(status) }), recording(audio('done')), window),
      ).toEqual({ ok: false, reason: 'page-transcript' });
    }
    expect(gapEligibility(page({ transcript: null }), recording(audio('done')), window)).toEqual({
      ok: false,
      reason: 'page-transcript',
    });
  });
});

describe('describeGapSkip', () => {
  it('gives a distinct sentence for every reason', () => {
    const reasons: GapSkipReason[] = [
      'no-strokes',
      'no-timestamps',
      'no-recording',
      'recording-transcript',
      'page-transcript',
    ];
    const sentences = reasons.map(describeGapSkip);
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
    expect(new Set(sentences).size).toBe(reasons.length);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/gaps/eligibility.test.ts`
Expected: FAIL — cannot resolve `@/gaps/eligibility`.

- [ ] **Step 3: Write `src/gaps/eligibility.ts`**

```ts
import type { SpeechWindow } from '@/gaps/window';
import type { PageRecord, RecordingRecord } from '@/storage/types';

export type GapSkipReason =
  | 'no-strokes'
  | 'no-timestamps'
  | 'no-recording'
  | 'recording-transcript'
  | 'page-transcript';

export type GapEligibility = { ok: true } | { ok: false; reason: GapSkipReason };

/**
 * Whether a page can be compared against the recording at all. One place, shared
 * by the analyzer (which skips rather than failing - A22) and the panel (which
 * says why and disables its button), so a press can never look available while
 * the analyzer would silently do nothing (P1-A4).
 *
 * Order matters: the reasons are reported from the page's own shape outwards, so
 * a blank page reads as "nothing written here" rather than "the recording is
 * still transcribing".
 */
export function gapEligibility(
  page: PageRecord,
  recording: RecordingRecord | null,
  window: SpeechWindow | null,
): GapEligibility {
  if (page.strokes.length === 0 || page.pointCount === 0) {
    return { ok: false, reason: 'no-strokes' };
  }
  if (window === null) return { ok: false, reason: 'no-timestamps' };
  if (recording === null) return { ok: false, reason: 'no-recording' };
  if (recording.transcript?.status !== 'done') {
    return { ok: false, reason: 'recording-transcript' };
  }
  // Without the page's own transcript there is nothing to say the page is
  // missing anything (P1-A8).
  if (page.transcript?.status !== 'done') return { ok: false, reason: 'page-transcript' };
  return { ok: true };
}

/** The panel's wording for each reason. Plain sentences, no jargon. */
export function describeGapSkip(reason: GapSkipReason): string {
  switch (reason) {
    case 'no-strokes':
      return 'This page has no writing on it, so there is nothing to compare.';
    case 'no-timestamps':
      return 'This page has no timestamps to line up with the recording.';
    case 'no-recording':
      return 'This note has no linked recording.';
    case 'recording-transcript':
      return 'The recording is still being transcribed.';
    case 'page-transcript':
      return 'This page has not been transcribed yet.';
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/gaps/eligibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/gaps/eligibility.ts src/gaps/eligibility.test.ts
git add src/gaps/eligibility.ts src/gaps/eligibility.test.ts
git commit -m "$(printf 'feat(gaps): eligibility rules and their wording\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 6: The analyzer (`fakeTextGenerator.ts`, `analyzer.ts`, `startGaps.ts`)

**Files:**
- Create: `src/gaps/fakeTextGenerator.ts`
- Create: `src/gaps/analyzer.ts`
- Create: `src/gaps/startGaps.ts`
- Test: `src/gaps/analyzer.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `TextGenerator`, `TextGenerateJsonOptions` from `@/llm/ollamaText`; `getPage`, `listPages`, `setPageGapAnalysis` from `@/storage/pages`; `getNote` from `@/storage/notes`; `listRecordings`, `listRecordingsBySession` from `@/storage/recordings`; `createGaps`, `listGapsByPage`, `deleteGapsByPage` from `@/storage/gaps`; `getSettingValue` from `@/storage/settingKeys`; `createOllamaTextGenerator` from `@/llm/ollamaText`.
- Produces:
  - `interface FakeTextGenerator extends TextGenerator { calls: Array<{ prompt: string; system?: string; model: string }>; replies: string[]; failWith: Error | null; onGenerate?: () => Promise<void> | void }` and `createFakeTextGenerator(replies?: string[]): FakeTextGenerator`
  - `interface GapAnalyzerDeps { generator: TextGenerator; model: string; leadMs?: number; trailMs?: number; directCharBudget?: number; chunkChars?: number; chunkOverlap?: number; now?: () => number }`
  - `createGapAnalyzer(deps: GapAnalyzerDeps): GapAnalyzer` with `analyzePage(pageId, opts?): Promise<GapSuggestionRecord[]>` and `analyzeNote(noteId, opts?): Promise<void>`
  - `recordingForNote(noteId: string): Promise<RecordingRecord | null>`
  - `createConfiguredGapAnalyzer(): Promise<GapAnalyzer>` from `@/gaps/startGaps`

- [ ] **Step 1: Write the fake generator `src/gaps/fakeTextGenerator.ts` (test support, no test of its own)**

```ts
import type {
  TextGenerateJsonOptions,
  TextGenerateOptions,
  TextGenerator,
} from '@/llm/ollamaText';

export interface FakeGeneratorCall {
  prompt: string;
  system?: string;
  model: string;
  json: boolean;
}

export interface FakeTextGenerator extends TextGenerator {
  readonly calls: FakeGeneratorCall[];
  /** Replies handed out in order; the last one repeats once they run out. */
  replies: string[];
  /** When set, every call rejects with it. */
  failWith: Error | null;
  /** Runs before each reply - a hook for asserting state mid-flight. */
  onGenerate: ((call: FakeGeneratorCall) => Promise<void> | void) | null;
}

/**
 * A scripted `TextGenerator`. P1's tests never reach Ollama: the real generator's
 * guards are `src/llm`'s to test, and a gap analysis test is about what the
 * analyzer does with an answer, not about how the answer arrived.
 *
 * `generateJson` runs the caller's own `validate`, because dropping bad rows is
 * part of what these tests are checking.
 */
export function createFakeTextGenerator(replies: string[] = []): FakeTextGenerator {
  const calls: FakeGeneratorCall[] = [];
  const fake: FakeTextGenerator = {
    calls,
    replies: [...replies],
    failWith: null,
    onGenerate: null,

    async generate(prompt: string, opts: TextGenerateOptions): Promise<string> {
      return run(prompt, opts, false);
    },

    async generateJson<T>(prompt: string, opts: TextGenerateJsonOptions<T>): Promise<T> {
      const text = await run(prompt, opts, true);
      return opts.validate(JSON.parse(text) as unknown);
    },
  };

  async function run(prompt: string, opts: TextGenerateOptions, json: boolean): Promise<string> {
    const call: FakeGeneratorCall = { prompt, system: opts.system, model: opts.model, json };
    calls.push(call);
    if (opts.signal?.aborted === true) throw new Error('Generation aborted');
    await fake.onGenerate?.(call);
    if (fake.failWith) throw fake.failWith;
    const reply = fake.replies.length > 1 ? fake.replies.shift() : fake.replies[0];
    return reply ?? '[]';
  }

  return fake;
}
```

- [ ] **Step 2: Write the failing test `src/gaps/analyzer.test.ts`**

Cover, one `it` each (spec tests 40–57), seeding storage with the real repositories after `await resetDatabase()`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { createGapAnalyzer } from '@/gaps/analyzer';
import { createFakeTextGenerator, type FakeTextGenerator } from '@/gaps/fakeTextGenerator';
import { createGaps, listGapsByPage } from '@/storage/gaps';
import { createNote } from '@/storage/notes';
import { createPage, getPage, setPageTranscript } from '@/storage/pages';
import { createRecording, setRecordingTranscript } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import type {
  GapSuggestionRecord,
  PageRecord,
  PageStroke,
  TranscriptSegment,
  TranscriptStatus,
} from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const MODEL = 'gemma4:12b';

/** A stroke written between two epoch-ms instants. */
function stroke(from: number, to: number): PageStroke {
  return {
    points: [
      { x: 0.1, y: 0.1, pressure: 1, t: from },
      { x: 0.2, y: 0.2, pressure: 1, t: to },
    ],
    startedAt: from,
    endedAt: to,
  };
}

/**
 * One note with one session, one recording whose transcript holds `segments`,
 * and one finalized page written 10s..20s after the recording started.
 */
async function seed(options: {
  segments?: TranscriptSegment[];
  markdown?: string;
  pageStatus?: TranscriptStatus;
  audioStatus?: TranscriptStatus;
  strokes?: PageStroke[];
  withRecording?: boolean;
} = {}) {
  const startedAt = 1_000_000;
  const session = await createSession({ title: 'Session' });
  const note = await createNote({
    title: 'Note',
    deviceId: 'dev',
    deviceType: 'huion',
    deviceName: 'X10',
    pageBaseline: 0,
    sessionId: session.id,
  });
  const page = await createPage({
    noteId: note.id,
    pageIndex: 0,
    devicePageNum: 1,
    source: 'live',
    strokes: options.strokes ?? [stroke(startedAt + 10_000, startedAt + 20_000)],
    finalizedAt: startedAt + 25_000,
  });
  if (options.pageStatus !== undefined || options.markdown !== undefined) {
    await setPageTranscript(page.id, {
      markdown: options.markdown ?? 'What the student wrote.',
      model: MODEL,
      promptVersion: 'gemma-v1',
      status: options.pageStatus ?? 'done',
      error: null,
      updatedAt: 0,
    });
  }
  let recordingId: string | null = null;
  if (options.withRecording !== false) {
    const recording = await createRecording(
      { sessionId: session.id, noteId: note.id, title: 'Rec', startedAt, endedAt: startedAt + 600_000, durationMs: 600_000 },
      new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
    );
    recordingId = recording.id;
    await setRecordingTranscript(recording.id, {
      text: 'speech',
      segments: options.segments ?? [{ startMs: 5_000, endMs: 26_000, text: 'The treaty was signed in 1919.' }],
      model: 'Xenova/whisper-base.en',
      language: 'en',
      status: options.audioStatus ?? 'done',
      error: null,
      updatedAt: 0,
    });
  }
  return { sessionId: session.id, noteId: note.id, pageId: page.id, recordingId, startedAt };
}

const ONE_POINT = JSON.stringify([
  { text: 'The treaty was signed in 1919.', kind: 'name-or-date', sourceQuote: 'signed in 1919' },
]);
```

Check `createRecording`'s and `createSession`'s exact input shapes in
`src/storage/recordings.ts` and `src/storage/sessions.ts` before writing the
helper, and adjust the seed to match; do not change those files.

The cases:

1. `direct path writes one suggestion per point`: seed, `analyzePage`, expect one `generateJson` call whose prompt contains `What the student wrote.` and `The treaty was signed in 1919.`; expect `listGapsByPage` to hold one record with `status: 'proposed'`, `recordingId`, `fromMs === startedAt + 10_000 - 60_000`, `toMs === startedAt + 25_000 + 30_000`, `model: MODEL`, `promptVersion: 'gap-compare-gemma-v1'`, `summarized: false`.
2. `records running while the call is in flight, then done`: set `generator.onGenerate` to read `getPage(pageId)` and capture `gapAnalysis?.status`; after the run expect the captured value `'running'` and the stored meta `{ status: 'done', error: null, summarized: false, model: MODEL, promptVersion: 'gap-compare-gemma-v1' }`.
3. `summarized path summarizes each chunk then compares the bullets`: build a segment whose text is 8000 characters of distinct words; `analyzePage` with `directCharBudget: 200, chunkChars: 100, chunkOverlap: 20`; expect the first N calls to be `json === false` summarize calls and the last one `json === true`; expect the compare prompt to contain a bullet from the replies and not the full raw speech; expect records and meta `summarized: true` with `promptVersion: 'gap-summarize-gemma-v1+gap-compare-gemma-v1'`.
4. `skips a chunk that summarizes to nothing`: replies `['', '- a bullet', ONE_POINT]` with three chunks; the run completes, one record is written.
5. `drops bad rows and still reports done`: reply is an array of two good rows and three bad (`null`, `'x'`, `{}`); two records, meta `done`.
6. `a re-run replaces only proposed suggestions`: pre-seed via `createGaps` one `accepted`, one `rejected`, two `proposed` (all on the page); run with a reply of one new point; expect the accepted and rejected records still present by id, no `proposed` record from before, and exactly one new `proposed`.
7. `a re-run does not resurface a rejected point`: pre-seed a `rejected` record whose text matches the reply's point; expect no new record and meta `done`.
8. `an empty page transcript still runs and its prompt says the notes are empty`: seed with `markdown: ''`; expect one call whose prompt contains `nothing` and a record written.
9. `skips a page with no strokes`: seed `strokes: []`; expect `analyzePage` resolves `[]`, `generator.calls` empty, `listGapsByPage` empty, and `(await getPage(pageId))?.gapAnalysis` is `undefined`.
10. `skips a note with no linked recording`: seed `withRecording: false`; same three assertions.
11. `skips until both transcripts are done`: seed `pageStatus: 'pending'` (then a second seed with `audioStatus: 'failed'`); no calls, no meta.
12. `no speech in the window clears proposals and records done`: seed segments far outside the window (`startMs: 500_000`), pre-seed two `proposed` records; expect no model call, no records left, meta `done` with `summarized: false`.
13. `a generator failure records failed and rethrows`: `generator.failWith = new Error('Ollama 500: boom')`; pre-seed one `proposed`; expect `await expect(analyzePage(pageId)).rejects.toThrow('boom')`, the pre-seeded record still there, and meta `{ status: 'failed', error: 'Ollama 500: boom' }`.
14. `an aborted signal stops before any model call`: pass `AbortSignal.abort()`; expect a rejection, `generator.calls` empty, meta `failed`.
15. `uses the earliest recording linked to the note (A21)`: create a second recording on the same note with an earlier `startedAt`; expect the written record's `recordingId` to be the earlier one.
16. `finds a recording linked only through the session`: create the recording with `noteId: null` and the note's `sessionId`; expect it is used.
17. `analyzeNote marks pages pending then analyzes them in order, serially`: seed a note with three eligible pages; have `onGenerate` record the page ids seen (read from the prompt via a per-page unique markdown) and assert only one call is ever in flight (increment/decrement a counter in `onGenerate`, assert max 1) and the order matches `pageIndex`; assert every page ends `done`.
18. `analyzeNote skips ineligible pages without a call`: one page with strokes, one blank; expect one compare call and the blank page's `gapAnalysis` `undefined`.
19. `analyzeNote continues past a page that fails`: make `onGenerate` throw for the first page only; expect page 1 `failed`, page 2 `done`, and `analyzeNote` to resolve.
20. `analyzeNote on a note with no pages resolves quietly`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run src/gaps/analyzer.test.ts`
Expected: FAIL — cannot resolve `@/gaps/analyzer`.

- [ ] **Step 4: Write `src/gaps/analyzer.ts`**

Structure (write it in this shape; the doc comments are part of the deliverable):

```ts
import { chunkSpeech } from '@/gaps/chunk';
import {
  GAP_CHUNK_CHARS,
  GAP_CHUNK_OVERLAP,
  GAP_DIRECT_CHAR_BUDGET,
  GAP_LEAD_MS,
  GAP_TRAIL_MS,
} from '@/gaps/constants';
import { gapEligibility } from '@/gaps/eligibility';
import { gapPromptVersion, getGapPrompt } from '@/gaps/prompts';
import { dropReviewed, validateGapPoints, type GapPoint } from '@/gaps/validate';
import { segmentsInWindow, speechTextOf, speechWindowForPage } from '@/gaps/window';
import type { TextGenerator } from '@/llm/ollamaText';
import { createGaps, deleteGapsByPage, listGapsByPage } from '@/storage/gaps';
import { getNote } from '@/storage/notes';
import { getPage, listPages, setPageGapAnalysis } from '@/storage/pages';
import { listRecordings, listRecordingsBySession } from '@/storage/recordings';
import type {
  GapAnalysisStatus,
  GapSuggestionRecord,
  PageRecord,
  RecordingRecord,
} from '@/storage/types';

export interface GapAnalyzerDeps { /* as in the Interfaces block */ }

export interface GapAnalyzer {
  analyzePage(pageId: string, opts?: { signal?: AbortSignal }): Promise<GapSuggestionRecord[]>;
  analyzeNote(noteId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * The recording a note's speech comes from: the earliest one linked to it (A21),
 * whether linked directly (`recording.noteId`) or through the note's session.
 * `recordings` has no `by-note` index, so the direct link is found by filtering
 * the metadata listing - which is cheap, the audio bytes living in their own
 * store.
 */
export async function recordingForNote(noteId: string): Promise<RecordingRecord | null> { … }

export function createGapAnalyzer(deps: GapAnalyzerDeps): GapAnalyzer { … }
```

`recordingForNote`: `getNote(noteId)`; gather `(await listRecordings()).filter(r => r.noteId === noteId)` plus, when `note?.sessionId` is a string, `await listRecordingsBySession(note.sessionId)`; de-duplicate by `id`; sort by `startedAt` then `id`; return the first or `null`.

Inside `createGapAnalyzer`, with `now = deps.now ?? Date.now`:

- `meta(status, promptVersion, summarized, error)` builds a `GapAnalysisMeta` with `at: now()` and `model: deps.model`.
- `writeMeta(pageId, …)` wraps `setPageGapAnalysis` in a `try/catch` that only `console.error`s — a failure to record a failure must not replace the real error.
- `summarizeChunks(chunks, signal)`: serial `for` loop calling `generator.generate(spec.build({ chunk, index, total }), { model, system: spec.system, signal })`, trimming, skipping empties, joining with `'\n'`. Serial because Ollama serves one model at a time: a parallel fan-out only queues, and it turns one slow call into a whole-page timeout.
- `compare(notes, speech, summarized, signal)`: `generator.generateJson<GapPoint[]>(spec.build({ notes, speech, summarized }), { model, system: spec.system, signal, validate: validateGapPoints })`.
- `analyzePage`:
  1. `const page = await getPage(pageId); if (!page) throw new Error(\`Page not found: ${pageId}\`);`
  2. `const recording = await recordingForNote(page.noteId);`
  3. `const window = speechWindowForPage(page, { leadMs, trailMs });`
  4. `const eligible = gapEligibility(page, recording, window); if (!eligible.ok) return [];` — no meta write (P1-A1).
  5. Narrow: after the guard, `window` and `recording` are non-null and `page.transcript` is `done`; keep local consts so TypeScript sees it.
  6. `const promptVersionDirect = gapPromptVersion(deps.model, false)` for the `running` meta; the final meta uses the version that matches what actually happened.
  7. `await writeMeta(pageId, 'running', promptVersionDirect, false, null);`
  8. `try { … } catch (error) { await writeMeta(pageId, 'failed', …, message(error)); throw error; }`
  9. In the `try`: speech text; `if (speech.length === 0)` → `await deleteGapsByPage(pageId, 'proposed'); await writeMeta(pageId, 'done', promptVersionDirect, false, null); return [];`
  10. Otherwise decide the path on `speech.length > directCharBudget`; on the summarized path `chunkSpeech(speech, { budget: chunkChars, overlap: chunkOverlap })` then `summarizeChunks`; if the bullets come back empty fall back to comparing the raw speech (a summarization that produced nothing must not silently analyze an empty lecture) and keep `summarized: true`, which is the honest flag for "the speech went through the lossy path".
  11. `const points = dropReviewed(await compare(...), await listGapsByPage(pageId));`
  12. `await deleteGapsByPage(pageId, 'proposed');` then `const created = await createGaps(points.map(...))` with `noteId: page.noteId`, `pageId`, `recordingId`, `fromMs`, `toMs`, `text`, `kind`, `sourceQuote`, `model`, `promptVersion`, `summarized`.
  13. `await writeMeta(pageId, 'done', promptVersion, summarized, null); return created;`
- `analyzeNote`: `const pages = await listPages(noteId)`; compute eligibility per page once (reusing `recordingForNote` result for the note, so the listing is read once); `await setPageGapAnalysis(p.id, meta('pending', …))` for the eligible ones; then `for (const p of pages) { try { await analyzePage(p.id, opts) } catch (error) { if (isAbort(error)) throw error; console.error('[gaps] page analysis failed', error) } }`. `isAbort` checks `error instanceof Error && error.name === 'AbortError'`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/gaps/analyzer.test.ts`
Expected: PASS. If a case fails, fix the implementation, not the assertion, unless the assertion contradicts `docs/features/p1-spec.md`.

- [ ] **Step 6: Write `src/gaps/startGaps.ts` (no test — it is the only code that touches the network)**

```ts
import { createGapAnalyzer, type GapAnalyzer } from '@/gaps/analyzer';
import { createOllamaTextGenerator } from '@/llm/ollamaText';
import { getSettingValue } from '@/storage/settingKeys';

/**
 * A gap analyzer wired to the app's settings: the same Ollama host and model as
 * page transcription (A30), and the user's lead/trail margins.
 *
 * Built per run rather than cached: gap analysis is an explicit action a user
 * takes occasionally, and picking up a settings change between two presses is
 * what they expect. Nothing here is exercised by a test - a test injects its own
 * `TextGenerator` instead, so no test can reach Ollama.
 */
export async function createConfiguredGapAnalyzer(): Promise<GapAnalyzer> {
  const [baseUrl, model, leadMs, trailMs] = await Promise.all([
    getSettingValue('ollama.baseUrl'),
    getSettingValue('ollama.model'),
    getSettingValue('gaps.leadMs'),
    getSettingValue('gaps.trailMs'),
  ]);
  return createGapAnalyzer({
    generator: createOllamaTextGenerator({ baseUrl }),
    model,
    leadMs,
    trailMs,
  });
}
```

- [ ] **Step 7: Types, lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx tsc -b
npx eslint src/gaps
git add src/gaps
git commit -m "$(printf 'feat(gaps): gap analyzer over the shared text generator\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 7: The panel lists and reviews suggestions (`GapPanel.tsx`)

**Files:**
- Modify: `src/notes/GapPanel.tsx` (replace the placeholder body; keep the export name, `GapPanelProps` and `aria-label="Gaps"`)
- Test: `src/notes/GapPanel.test.tsx`

**Interfaces:**
- Consumes: `GapAnalyzer` from `@/gaps/analyzer`; `describeGapSkip`, `gapEligibility` from `@/gaps/eligibility`; `speechWindowForPage` from `@/gaps/window`; `recordingForNote` from `@/gaps/analyzer`; `listGapsByPage`, `updateGap` from `@/storage/gaps`; `getPage` from `@/storage/pages`; `Button` from `@/components/ui/button`.
- Produces: `GapPanel({ noteId, pageId, analyzer }: GapPanelProps)` where `GapPanelProps` gains `/** Tests only - a real mount builds one from settings. */ analyzer?: GapAnalyzer`. Also `GAP_KIND_LABELS: Record<GapKind, string>` exported from `GapPanel.tsx` for the test to assert against.

- [ ] **Step 1: Write the failing test `src/notes/GapPanel.test.tsx`**

Set up as `src/app/DeviceStatus.test.tsx` does (`IS_REACT_ACT_ENVIRONMENT`, `createRoot`, `act`, unmount in `afterEach`), plus `await resetDatabase()`. Seed with the real repositories. Render with an injected analyzer stub:

```ts
function createStubAnalyzer() {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  return {
    calls,
    /** Resolves the pending run, for the in-flight assertions. */
    finish() { release?.(); release = null; },
    pending: false,
    analyzePage: vi.fn(async (pageId: string) => { calls.push(`page:${pageId}`); return []; }),
    analyzeNote: vi.fn(async (noteId: string) => { calls.push(`note:${noteId}`); }),
  };
}
```

Cases for this task (spec tests 58–61, 72):

1. `renders the Gaps section` — `container.querySelector('[aria-label="Gaps"]')` is not null and contains `Gaps`.
2. `lists proposed suggestions with kind and quote` — seed two `proposed` gaps; after the mount's reads settle (`await act(async () => {})`), the text contains both texts, the readable kind labels (`Name or date`, `Claim`) and both `sourceQuote`s.
3. `Accept moves a suggestion into the accepted block` — click the suggestion's `Accept` button (find by walking `container.querySelectorAll('button')` for `textContent === 'Accept'`); expect `(await listGapsByPage(pageId))` to show `status: 'accepted'` for that id and the accepted block heading (`From the recording`) to be present.
4. `Reject moves it into the rejected block` — same shape, `status: 'rejected'`, `Rejected` heading present.
5. `accepted suggestions are read-only and never touch the transcript` — seed an `accepted` gap plus a page transcript; expect no `input`, `textarea` or `[contenteditable]` inside the section, expect no `Accept`/`Reject` button for that suggestion, and expect `(await getPage(pageId))?.transcript?.markdown` unchanged.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/notes/GapPanel.test.tsx`
Expected: FAIL — the placeholder renders none of it.

- [ ] **Step 3: Implement the listing and review half of `GapPanel.tsx`**

- Keep the file's existing header comment's intent, updated to describe the real component.
- `GAP_KIND_LABELS: Record<GapKind, string> = { claim: 'Claim', definition: 'Definition', 'name-or-date': 'Name or date', example: 'Example', 'argument-step': 'Argument step', other: 'Other' }`.
- State: `page: PageRecord | null`, `gaps: GapSuggestionRecord[]`, `recording: RecordingRecord | null`, `loadError: string | null`, `revision: number`.
- One effect, keyed on `[pageId, noteId, revision]`, with a `live` flag, loading `getPage(pageId)`, `listGapsByPage(pageId)` and `recordingForNote(noteId)` in one `Promise.all`; `catch` sets `loadError`. Never `setState` synchronously in the effect body (lint rule) — all writes are inside the promise callbacks.
- `review(id, status)` calls `updateGap(id, { status })` then bumps `revision`; errors go to `loadError`.
- Render: a `<section aria-label="Gaps" className="border-t border-border p-4">` with `<h3>Gaps</h3>`, then the proposed list (`text`, kind label as a small badge, the quote in a `<blockquote>` labelled `From the recording`, and `Accept` / `Reject` `Button`s), then an accepted block under a `From the recording` heading with no controls, then a muted `Rejected` block with no controls.
- Nothing in this component writes a transcript; it imports neither `setPageTranscript` nor anything from `@/transcription`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/notes/GapPanel.test.tsx src/notes/NotesView.test.tsx`
Expected: PASS both — `NotesView.test.tsx` must keep passing unmodified.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/notes/GapPanel.tsx src/notes/GapPanel.test.tsx
git add src/notes/GapPanel.tsx src/notes/GapPanel.test.tsx
git commit -m "$(printf 'feat(gaps): review suggestions in the gap panel\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 8: The panel's find actions, status and lossy-source notice (`GapPanel.tsx`)

**Files:**
- Modify: `src/notes/GapPanel.tsx`
- Test: `src/notes/GapPanel.test.tsx` (add cases)

**Interfaces:**
- Consumes: Task 7's component and its state; `createConfiguredGapAnalyzer` from `@/gaps/startGaps` (the default when no `analyzer` prop is given).
- Produces: no new exports.

- [ ] **Step 1: Add the failing cases to `src/notes/GapPanel.test.tsx`**

Spec tests 62–71, plus the Review Focus cases:

1. `Find gaps analyzes this page and reloads the list` — click `Find gaps`; expect `analyzePage` called with the page id, and a gap created by the stub (have the stub `createGaps` one record before resolving) to appear in the DOM.
2. `Find gaps in note analyzes the note` — click `Find gaps in note`; expect `analyzeNote` called with the note id.
3. `both buttons are disabled while a run is in flight and enabled after` — stub `analyzePage` returns a promise you resolve by hand; after the click both buttons have `disabled === true`; after resolving, `false`.
4. `a second press while a run is in flight does not start a second run` — click `Find gaps` twice before resolving; expect `analyzePage` to have been called once.
5. `unmounting mid-run is quiet` — click, unmount the root inside `act`, then resolve the promise; expect no `console.error` call (spy with `vi.spyOn(console, 'error')`) and no thrown error.
6. `shows the running and pending status lines` — seed `gapAnalysis` `{ status: 'running' }` and assert `Looking for gaps…`; then `pending` and assert the waiting line.
7. `shows a failed analysis with its error and still offers Find gaps` — seed `gapAnalysis` `{ status: 'failed', error: 'Ollama 500: boom' }`; expect the error text present and the `Find gaps` button enabled.
8. `shows an error when the analyzer rejects and stays usable` — stub rejects with `new Error('no model')`; expect `no model` in the DOM and the buttons enabled again.
9. `says so when an analysis found nothing` — `gapAnalysis` `done` with no gaps; expect the plain no-gaps sentence.
10. `says when the speech was summarized` — `gapAnalysis` `done` with `summarized: true`; expect wording containing `summarized`; with `summarized: false`, expect it absent.
11. `explains an ineligible page and disables Find gaps` — seed a page with no strokes; expect `describeGapSkip('no-strokes')`'s sentence, `Find gaps` disabled, `Find gaps in note` enabled.
12. `says when the note has no recording and disables both actions` — seed with no recording; expect the sentence and both buttons disabled.

- [ ] **Step 2: Run and confirm the new cases fail**

Run: `npx vitest run src/notes/GapPanel.test.tsx`
Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement the actions and status**

- `const [running, setRunning] = useState<null | 'page' | 'note'>(null)` and `const [runError, setRunError] = useState<string | null>(null)`.
- `async function run(kind: 'page' | 'note')`: return immediately when `running !== null` (Review Focus 2); `setRunning(kind)`, `setRunError(null)`; resolve the analyzer as `props.analyzer ?? (await createConfiguredGapAnalyzer())`; `await` the call; then bump `revision`. `catch` → `setRunError(message)`. `finally` → `setRunning(null)`. Every `setState` after the await is guarded by a mounted ref set in an effect cleanup (Review Focus 3), and the error is only logged with `console.error` when the component is still mounted, so an unmount mid-run is silent.
- Eligibility: `const window = page ? speechWindowForPage(page) : null;` and `const eligible = page ? gapEligibility(page, recording, window) : null;`. `Find gaps` is `disabled={running !== null || eligible?.ok !== true}`; `Find gaps in note` is `disabled={running !== null || recording === null}`.
- Status block from `page.gapAnalysis`: `undefined`/`null` → `Not analyzed yet.`; `pending` → `Waiting to analyze…`; `running` → `Looking for gaps…`; `failed` → `<p className="text-sm text-destructive">Gap analysis failed: {error}</p>`; `done` with no proposed/accepted/rejected gaps → `No gaps found in the recording for this page.`
- The lossy notice, rendered when `page.gapAnalysis?.summarized === true` or any listed suggestion has `summarized: true`: `The speech was too long to compare directly, so it was summarized first — some detail may be lost.`
- When not eligible, render `describeGapSkip(eligible.reason)` as a muted sentence.
- `runError` renders in destructive text.

- [ ] **Step 4: Run the full file and the host test**

Run: `npx vitest run src/notes/GapPanel.test.tsx src/notes/NotesView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
npx eslint src/notes/GapPanel.tsx src/notes/GapPanel.test.tsx
git add src/notes/GapPanel.tsx src/notes/GapPanel.test.tsx
git commit -m "$(printf 'feat(gaps): find gaps, analysis status and the lossy-source notice\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 9: Whole-feature verification

**Files:** none new; fixes only where a check fails.

- [ ] **Step 1: Types**

Run: `npx tsc -b`
Expected: no output.

- [ ] **Step 2: Lint the touched files**

Run: `npx eslint src/gaps src/notes/GapPanel.tsx src/notes/GapPanel.test.tsx`
Expected: no errors and no new warnings.

- [ ] **Step 3: Whole suite**

Run: `npx vitest run`
Expected: every test passes, with at least 769 + the new cases, and `src/notes/NotesView.test.tsx` unmodified.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Confirm the ownership boundary**

Run: `git diff --stat main...HEAD -- src` (or `git diff --name-only main...HEAD`)
Expected: only `src/gaps/**` and `src/notes/GapPanel.tsx`. Anything else must be reverted or reported.

- [ ] **Step 6: Commit any fixes**

```bash
cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p1-gaps
git add -A
git commit -m "$(printf 'chore(gaps): verification fixes\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
