# S6 Find and smart search — Implementation Plan

**Goal:** One query box with two modes. **Find** is an immediate, local,
case-insensitive substring match over note titles, note summaries, page
text (ink transcript or typed text, mirrored into the same field) and audio
transcript segments — no model. **Smart search** is an explicit, two-stage
Gemma pass: screen every note's summary (or, when it has none, its title +
page text — K46) to shortlist candidates, then read only those candidates'
full page text and band each one strong/moderate/weak.

**Architecture:** `corpus.ts` does the one bulk read of storage (notes, all
page text via `listAllPageText`, finished recordings, and a
recording→note map built from `recordingsForNote`) that both modes share.
`find.ts` is a pure match function over that corpus. `prompts.ts` is a
versioned two-prompt registry (screen, band); `validate.ts` turns each
prompt's untrusted JSON into a typed result. `smartSearch.ts` composes
those over a `TextGenerator` from `src/llm/ollamaText.ts`. `startSearch.ts`
wires it to settings. `SearchView.tsx` is the only UI, reading storage
itself and taking injected test doubles the way `GapPanel`/`NotesView`
already do. `AppShell.tsx` gains a fourth tab.

**Tech Stack:** TypeScript 5.9, React 19, Vitest 3 + happy-dom +
fake-indexeddb, `idb`. No testing-library — render with `createRoot` + `act`.

**Spec:** `docs/features/s6-spec.md` — read its "Design", "Tests" and
"Assumptions" before starting any task; this plan does not repeat the
reasoning already written there.

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/s6-search`
  (branch `wave3/s6-search`). Absolute paths. Never push. Never bare
  `git stash`.
- Create and edit only: `src/search/**` and `src/app/AppShell.tsx` (plus its
  own `AppShell.test.tsx`). Do **NOT** edit anything under `src/storage/**`,
  `src/llm/**`, `src/capture/**`, `src/notes/**`, `src/recordings/**`,
  `src/gaps/**`, `src/transcription/**`, `src/audio/**`, `src/triage/**`,
  `src/device/**`, `src/utils/**`, `src/test/**`.
- Import alias `@/` = `src/`. Tests sit beside sources as `*.test.ts(x)`.
- **Tests must never reach a real model or a real network call**: inject a
  fake `TextGenerator` (`src/gaps/fakeTextGenerator.ts`'s shape — reuse the
  pattern, write S6's own copy in `src/search/` since `src/gaps/` is
  off-limits to import test-only code from in a way that would couple the
  two units; a small local copy is cheaper than a cross-unit dependency).
  No test may call `createOllamaTextGenerator`, `getSmartSearchDeps` or
  `fetch`.
- Component tests set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and
  render with `createRoot` inside `act`; use `buttons()`/`buttonByText()`/
  `click()`/`settle()` helpers following `src/notes/NotesView.test.tsx`.
  Storage tests call `await resetDatabase()` from `@/test/resetDb` in
  `beforeEach`.
- Prompt versions, exactly: `search-screen-v1`, `search-band-v1`.
- Error logging uses `console.error` with a `[search]` prefix.
- No new runtime dependency. No `DB_VERSION` bump, no new store, no new
  index.
- No new lint errors or warnings in touched files.
- Commands: one file `npx vitest run <path>`; everything `npm test`
  (baseline to beat: **1367 passing in 108 files**, verified clean before
  this unit started); types `npx tsc -b`; lint `npm run lint`; build
  `npm run build`. **All four pass before every commit.**
- Every commit message ends with a blank line then
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Mutation-check every new test**: after it's green, break the
  implementation it's supposed to pin, confirm the test fails, then revert
  the break. Note the result in the task.

## Review Focus

1. **A note with `summary === null` must still be screened, on its title
   plus page text, and the result must say how many notes were in that
   state** (K44/K46) — Task 5's tests 25/26 pin both halves; test 26 asserts
   the *exact* count, not `toBeGreaterThan(0)`, specifically because a count
   that is merely "truthy" is the kind of assertion the project has already
   shipped once and regretted.
2. **An unreachable Ollama host must surface as a plain error, not a stack
   trace or a silent empty result** — but only reliably for the *first* call
   a run makes (S6-A4). Task 5's test 32 pins that the screen call's
   rejection propagates; test 33 pins that a *band*-stage rejection does not
   (by design) take down the whole run. Both must be read together, not as
   contradictory.
3. **Prompt/validator agreement** — Task 3's test 16 round-trips a literal
   worked example of each prompt's stated output shape through its own
   validator. This is the exact class of bug the brief calls out
   (`toContain('title')` passing against a prompt demanding `title_text`):
   write the worked example from the prompt's *own wording*, not from
   whatever the validator happens to accept.
4. **Cross-tab navigation is the honest limit of "links to note + page"**
   (S6-A6) — `NotesView`/`RecordingsView` are off-limits and expose no
   external selection. Task 8's `onOpenNotes`/`onOpenRecordings` props are
   tab switches, not deep links; do not invent a way around this that edits
   an off-limits file.
5. **The empty-library and blank-query paths must make zero model calls**
   (not merely return an empty result that happens to look right) — Task 5's
   tests 30/31 assert `generator.calls.length === 0`, the same
   "assert what is there" discipline the brief's "weak assertion" warning
   asks for.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/search/corpus.ts` | `loadSearchCorpus` — one bulk read, shared by both modes. |
| `src/search/find.ts` | `findInCorpus`, `snippetAround` — pure substring match. |
| `src/search/prompts.ts` | The versioned two-prompt registry (screen, band). |
| `src/search/validate.ts` | The model's untrusted JSON → typed results. |
| `src/search/fakeTextGenerator.ts` | Test support: a scripted `TextGenerator` (S6's own copy). |
| `src/search/smartSearch.ts` | `runSmartSearch` — composes the above, two Ollama stages. |
| `src/search/startSearch.ts` | `getSmartSearchDeps` — settings-wired, never called by a test. |
| `src/search/SearchView.tsx` | The only UI: query box, Find results, Smart search + bands. |
| `src/app/AppShell.tsx` | Adds the fourth tab and the two navigation callbacks. |

---

### Task 1: The shared corpus (`corpus.ts`)

**Files:**
- Create: `src/search/corpus.ts`
- Test: `src/search/corpus.test.ts`

**Interfaces:**
- Consumes: `listNotes` (`@/storage/notes`), `listAllPageText`
  (`@/storage/pages`), `listFinishedRecordings`, `recordingsForNote`
  (`@/storage/recordings`), `NoteRecord`/`RecordingRecord`
  (`@/storage/types`).
- Produces: `SearchPage`, `SearchNote`, `SearchCorpus`, `loadSearchCorpus()`
  (exact shapes in `s6-spec.md`'s "Design" section).

- [ ] **Step 1: Write the failing test** `src/search/corpus.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { loadSearchCorpus } from '@/search/corpus';
import { createNote } from '@/storage/notes';
import { createPage, createTypedPage, setPageTranscript, setPageText } from '@/storage/pages';
import { createRecording, finalizeRecording } from '@/storage/recordings';
import { createSession } from '@/storage/sessions';
import { resetDatabase } from '@/test/resetDb';

beforeEach(async () => {
  await resetDatabase();
});

describe('loadSearchCorpus', () => {
  it('returns an empty corpus for an empty database', async () => {
    const corpus = await loadSearchCorpus();
    expect(corpus.notes).toEqual([]);
    expect(corpus.recordings).toEqual([]);
    expect(corpus.recordingOwner.size).toBe(0);
  });

  it('groups a note\'s pages by pageIndex, ink and typed alike', async () => {
    const note = await createNote({ title: 'Lecture 1', deviceId: 'd1', pageBaseline: 0 });
    const p1 = await createPage({ noteId: note.id, pageIndex: 1, devicePageNum: 1, source: 'live', strokes: [] });
    await setPageTranscript(p1.id, {
      markdown: 'ink text', model: 'gemma4', promptVersion: 'gemma-v1', status: 'done', error: null, updatedAt: 1,
    });
    const p0 = await createTypedPage({ noteId: note.id, pageIndex: 0, text: 'typed text' });

    const corpus = await loadSearchCorpus();
    const found = corpus.notes.find((n) => n.note.id === note.id)!;
    expect(found.pages.map((p) => p.pageIndex)).toEqual([0, 1]);
    expect(found.pages[0]).toMatchObject({ pageId: p0.id, isTyped: true, text: 'typed text' });
    expect(found.pages[1]).toMatchObject({ pageId: p1.id, isTyped: false, text: 'ink text' });
  });

  it('maps a direct and a session-linked recording to the same note, and leaves a standalone one unmapped', async () => {
    const session = await createSession({ title: 'S' });
    const note = await createNote({ title: 'N', deviceId: 'd1', pageBaseline: 0, sessionId: session.id });
    const direct = await createRecording({ title: 'r1', durationMs: 1000, noteId: note.id }, new Blob(['a']));
    await finalizeRecording(direct.id, new Blob(['a']), { endedAt: 2, durationMs: 1000 });
    const viaSession = await createRecording({ title: 'r2', durationMs: 1000, sessionId: session.id }, new Blob(['b']));
    await finalizeRecording(viaSession.id, new Blob(['b']), { endedAt: 2, durationMs: 1000 });
    const standalone = await createRecording({ title: 'r3', durationMs: 1000 }, new Blob(['c']));
    await finalizeRecording(standalone.id, new Blob(['c']), { endedAt: 2, durationMs: 1000 });

    const corpus = await loadSearchCorpus();
    expect(corpus.recordingOwner.get(direct.id)).toBe(note.id);
    expect(corpus.recordingOwner.get(viaSession.id)).toBe(note.id);
    expect(corpus.recordingOwner.has(standalone.id)).toBe(false);
    expect(corpus.recordings.map((r) => r.id).sort()).toEqual([direct.id, standalone.id, viaSession.id].sort());
  });
});
```

Run `npx vitest run src/search/corpus.test.ts` — fails (`@/search/corpus`
doesn't exist).

- [ ] **Step 2: Implement** `src/search/corpus.ts`:

```ts
import { listAllPageText } from '@/storage/pages';
import { listNotes } from '@/storage/notes';
import { listFinishedRecordings, recordingsForNote } from '@/storage/recordings';
import type { NoteRecord, RecordingRecord } from '@/storage/types';

export interface SearchPage {
  pageId: string;
  pageIndex: number;
  /** `PageTextProjection.text !== undefined` (K32): a typed page, not ink/ROM. */
  isTyped: boolean;
  /** `transcript.markdown`, trimmed; `''` when not (yet) transcribed. */
  text: string;
}

export interface SearchNote {
  note: NoteRecord;
  /** This note's pages, `pageIndex` order. */
  pages: SearchPage[];
}

export interface SearchCorpus {
  notes: SearchNote[];
  recordings: RecordingRecord[];
  /** recordingId -> noteId, built from `recordingsForNote` (architecture.md §8.5). */
  recordingOwner: Map<string, string>;
}

/**
 * One bulk read of storage, shared by Find and smart search so neither mode
 * re-reads notes/pages/recordings on its own (S6-spec "Design").
 */
export async function loadSearchCorpus(): Promise<SearchCorpus> {
  const [notes, pageRows, recordings] = await Promise.all([
    listNotes(),
    listAllPageText(),
    listFinishedRecordings(),
  ]);

  const pagesByNote = new Map<string, SearchPage[]>();
  for (const row of pageRows) {
    const list = pagesByNote.get(row.noteId) ?? [];
    list.push({
      pageId: row.id,
      pageIndex: row.pageIndex,
      isTyped: row.text !== undefined,
      text: (row.transcript?.markdown ?? '').trim(),
    });
    pagesByNote.set(row.noteId, list);
  }
  for (const list of pagesByNote.values()) list.sort((a, b) => a.pageIndex - b.pageIndex);

  // §8.5: `recordingsForNote` is the one place that knows both link paths
  // (direct `noteId`, or via the note's session) - called once per note
  // rather than re-derived, per the brief.
  const recordingOwner = new Map<string, string>();
  for (const note of notes) {
    for (const recording of await recordingsForNote(note.id)) {
      recordingOwner.set(recording.id, note.id);
    }
  }

  const searchNotes: SearchNote[] = notes.map((note) => ({
    note,
    pages: pagesByNote.get(note.id) ?? [],
  }));

  return { notes: searchNotes, recordings, recordingOwner };
}
```

Run `npx vitest run src/search/corpus.test.ts` — green.

- [ ] **Step 3: Mutation-check.** Break `isTyped: row.text !== undefined` to
  `isTyped: false` → the typed-page test must fail. Break the
  `recordingOwner` loop to only check `recording.noteId === note.id` (drop
  the session path) → the session-linked assertion must fail. Revert both.
  Record the result.

- [ ] **Step 4: Gates and commit.** `npx tsc -b && npm run lint && npm run
  build && npm test`. Commit: `feat(search): add the shared search corpus
  reader`.

---

### Task 2: Find mode (`find.ts`)

**Files:**
- Create: `src/search/find.ts`
- Test: `src/search/find.test.ts`

**Interfaces:**
- Consumes: `SearchCorpus` (Task 1).
- Produces: `FindHitSource`, `FindHit`, `findInCorpus(corpus, query)`,
  `snippetAround(text, query, radius?)`.

- [ ] **Step 1: Write the failing test** `src/search/find.test.ts` — build a
  `SearchCorpus` literal by hand (no storage needed, `find.ts` is pure)
  covering: title match, summary match, `summary: null` skipped, ink page
  match (`isTyped: false`), typed page match (`isTyped: true`), audio
  segment match with a known owner and with no owner (standalone), two
  matching pages of one note give two hits, two segments of one recording
  where only one matches give one hit, a blank query gives `[]`, and
  `snippetAround` truncates with ellipses but returns short text verbatim.
  Example shape for one case:

```ts
it('finds a note by its summary, and skips a null summary without throwing', () => {
  const corpus: SearchCorpus = {
    notes: [
      { note: makeNote({ id: 'n1', summary: 'Covers recursion and base cases.' }), pages: [] },
      { note: makeNote({ id: 'n2', summary: null }), pages: [] },
    ],
    recordings: [],
    recordingOwner: new Map(),
  };
  const hits = findInCorpus(corpus, 'recursion');
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ source: 'note-summary', noteId: 'n1' });
});
```

  (`makeNote` is a tiny local helper building a minimal valid `NoteRecord`.)
  Run — fails (`@/search/find` doesn't exist).

- [ ] **Step 2: Implement** `src/search/find.ts`:

```ts
import type { SearchCorpus } from '@/search/corpus';

export type FindHitSource = 'note-title' | 'note-summary' | 'page-text' | 'audio-segment';

export interface FindHit {
  source: FindHitSource;
  noteId: string | null;
  noteTitle: string | null;
  pageIndex?: number;
  isTyped?: boolean;
  recordingId?: string;
  recordingTitle?: string;
  startMs?: number;
  snippet: string;
}

/** Text around the first case-insensitive match, trimmed, with ellipses when truncated. */
export function snippetAround(text: string, query: string, radius = 60): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query.toLowerCase());
  if (at === -1) return text.trim().slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/** Immediate, local, case-insensitive substring match (K40) over the five sources (K41). */
export function findInCorpus(corpus: SearchCorpus, query: string): FindHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const hits: FindHit[] = [];

  for (const { note, pages } of corpus.notes) {
    if (note.title.toLowerCase().includes(q)) {
      hits.push({ source: 'note-title', noteId: note.id, noteTitle: note.title, snippet: snippetAround(note.title, q) });
    }
    if (note.summary !== null && note.summary.toLowerCase().includes(q)) {
      hits.push({ source: 'note-summary', noteId: note.id, noteTitle: note.title, snippet: snippetAround(note.summary, q) });
    }
    for (const page of pages) {
      if (page.text.toLowerCase().includes(q)) {
        hits.push({
          source: 'page-text',
          noteId: note.id,
          noteTitle: note.title,
          pageIndex: page.pageIndex,
          isTyped: page.isTyped,
          snippet: snippetAround(page.text, q),
        });
      }
    }
  }

  for (const recording of corpus.recordings) {
    const segments = recording.transcript?.segments ?? [];
    for (const segment of segments) {
      if (segment.text.toLowerCase().includes(q)) {
        const noteId = corpus.recordingOwner.get(recording.id) ?? null;
        const noteTitle = noteId ? corpus.notes.find((n) => n.note.id === noteId)?.note.title ?? null : null;
        hits.push({
          source: 'audio-segment',
          noteId,
          noteTitle,
          recordingId: recording.id,
          recordingTitle: recording.title,
          startMs: segment.startMs,
          snippet: snippetAround(segment.text, q),
        });
      }
    }
  }

  return hits;
}
```

  Run — green.

- [ ] **Step 3: Mutation-check.** Remove the `if (q === '')` early return →
  the blank-query test must fail (every note's title would otherwise match
  `''.includes('')`). Change `note.summary !== null &&` to drop the null
  check → the null-summary test must throw instead of skipping. Revert both.

- [ ] **Step 4: Gates and commit.** `feat(search): add Find, a pure
  substring match over the corpus`.

---

### Task 3: The prompt registry (`prompts.ts`)

**Files:**
- Create: `src/search/prompts.ts`
- Test: `src/search/prompts.test.ts` (shares file with Task 4's round-trip
  test, or keep the round-trip test here — either is fine; this plan puts
  it here since it is a prompt-registry property).

**Interfaces:**
- Produces: `ScreenCandidate`, `ScreenPromptInput`, `BandPromptInput`,
  `SCREEN_PROMPT_VERSION`, `BAND_PROMPT_VERSION`, `getScreenPrompt()`,
  `getBandPrompt()`.

- [ ] **Step 1: Write the failing test** `src/search/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getBandPrompt, getScreenPrompt } from '@/search/prompts';
import { validateBandResult, validateScreenIndices } from '@/search/validate';

describe('search prompts', () => {
  it('getScreenPrompt builds a numbered candidate list the validator can key back into', () => {
    const spec = getScreenPrompt();
    const text = spec.build({
      query: 'recursion',
      candidates: [
        { index: 1, title: 'Lecture 1', text: 'covers loops' },
        { index: 2, title: 'Lecture 2', text: 'covers recursion and base cases' },
      ],
    });
    expect(text).toContain('recursion');
    expect(text).toContain('Lecture 1');
    expect(text).toContain('Lecture 2');
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/2\./);
  });

  it('round-trips a worked screen reply, written from the prompt\'s own stated shape, through its validator', () => {
    const spec = getScreenPrompt();
    expect(spec.system).toContain('JSON array of integers');
    // The example is `[1, 4, 7]` per the prompt's own wording - not whatever
    // shape would merely happen to satisfy validateScreenIndices.
    const reply = '[1, 3]';
    const parsed = JSON.parse(reply) as unknown;
    expect(validateScreenIndices(parsed, 5)).toEqual([1, 3]);
  });

  it('round-trips a worked band reply, written from the prompt\'s own stated shape, through its validator', () => {
    const spec = getBandPrompt();
    expect(spec.system).toContain('"band"');
    expect(spec.system).toContain('"reason"');
    const reply = '{"band": "strong", "reason": "mentions recursion directly"}';
    const parsed = JSON.parse(reply) as unknown;
    expect(validateBandResult(parsed)).toEqual({ band: 'strong', reason: 'mentions recursion directly' });
  });

  it('prompt versions are stable, non-empty and distinct from every existing registry', () => {
    expect(getScreenPrompt().promptVersion).toBe('search-screen-v1');
    expect(getBandPrompt().promptVersion).toBe('search-band-v1');
    expect(getScreenPrompt().promptVersion).not.toBe(getBandPrompt().promptVersion);
  });
});
```

  Run — fails (neither module exists yet; write Task 4's `validate.ts`
  stub alongside, or write this test after Task 4 — **recommended order:
  do Task 4 first, then come back and write this file**, since the
  round-trip tests need both. Reorder the two tasks' *tests* accordingly;
  the plan lists them in reading order, not strict execution order).

- [ ] **Step 2: Implement** `src/search/prompts.ts`:

```ts
/**
 * K42/K43: the smart-search prompt registry, versioned like
 * `src/transcription/prompts.ts` and `src/gaps/prompts.ts`. Not keyed by
 * model family - following `src/notes/naming/prompts.ts`'s reasoning (A36:
 * this reuses `ollama.model` as-is; a future revision that needs
 * per-family wording adds the parameter the way `transcription/prompts.ts`
 * does).
 */

export interface ScreenCandidate {
  index: number;
  title: string;
  text: string;
}

export interface ScreenPromptInput {
  query: string;
  candidates: ScreenCandidate[];
}

export interface BandPromptInput {
  query: string;
  noteTitle: string;
  text: string;
}

export const SCREEN_PROMPT_VERSION = 'search-screen-v1';
export const BAND_PROMPT_VERSION = 'search-band-v1';

const SCREEN_SYSTEM = `You screen a student's lecture notes to find which ones might answer a search query, before a closer check reads them in full.

Rules:
- You are given a search query and a numbered list of notes, each with a title and either a short summary or, when no summary exists, its page text.
- Return the numbers of every note that might plausibly be relevant to the query, even loosely. A closer check will narrow this down afterward, so err on the side of including a note you are unsure about rather than leaving it out.
- Do not include a note that is clearly about something else entirely.
- Answer with a JSON array of integers only, for example [1, 4, 7]. Return [] if none might be relevant.
- No commentary, no preamble, no explanation, no code fences.

Return the JSON array and nothing else.`;

const BAND_SYSTEM = `You judge how well one set of lecture notes answers a search query.

Rules:
- Read the notes given and decide how strongly they relate to the query.
- Answer with a JSON object of exactly { "band": string, "reason": string }.
- "band" is one of "strong" (the notes substantially cover what the query asks about), "moderate" (the notes mention it but only partly), "weak" (there is only a tangential or passing connection), or "none" (the notes are not actually about this).
- "reason" is a short span copied verbatim from the notes that supports your answer, or a brief explanation when band is "none".
- Never invent a quote that is not in the notes.
- No commentary, no preamble, no explanation, no code fences.

Return the JSON object and nothing else.`;

function buildScreen(input: ScreenPromptInput): string {
  const lines = input.candidates.map(
    (c) => `${c.index}. ${c.title} — ${c.text.trim() || '(no content)'}`,
  );
  return ['QUERY:', input.query.trim(), '', 'NOTES:', ...lines].join('\n');
}

function buildBand(input: BandPromptInput): string {
  return [
    `QUERY: ${input.query.trim()}`,
    '',
    `NOTES (titled "${input.noteTitle}"):`,
    input.text.trim() || '(the note has no content)',
  ].join('\n');
}

export function getScreenPrompt() {
  return { promptVersion: SCREEN_PROMPT_VERSION, system: SCREEN_SYSTEM, build: buildScreen };
}

export function getBandPrompt() {
  return { promptVersion: BAND_PROMPT_VERSION, system: BAND_SYSTEM, build: buildBand };
}
```

  Run — green once Task 4's `validate.ts` exists.

- [ ] **Step 3: Mutation-check.** Change `buildScreen` to omit the index
  (`${c.title} — ${c.text}` with no leading number) → the "numbered
  candidate list" test must fail on the `toMatch(/1\./)` assertion. Revert.

- [ ] **Step 4: Gates and commit** (after Task 4 lands):
  `feat(search): add the versioned screen/band prompt registry`.

---

### Task 4: Validating the model's JSON (`validate.ts`)

**Files:**
- Create: `src/search/validate.ts`
- Test: `src/search/validate.test.ts`

**Interfaces:**
- Produces: `SmartSearchBand`, `BandResult`, `SEARCH_REASON_MAX`,
  `validateScreenIndices(value, candidateCount)`, `validateBandResult(value)`.

- [ ] **Step 1: Write the failing test** `src/search/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { validateBandResult, validateScreenIndices } from '@/search/validate';

describe('validateScreenIndices', () => {
  it('validates a clean array, deduped and sorted', () => {
    expect(validateScreenIndices([3, 1, 1, 2], 5)).toEqual([1, 2, 3]);
  });

  it('unwraps a common wrapper object', () => {
    expect(validateScreenIndices({ indices: [1, 2] }, 5)).toEqual([1, 2]);
    expect(validateScreenIndices({ candidates: [1] }, 5)).toEqual([1]);
    expect(validateScreenIndices({ relevant: [2] }, 5)).toEqual([2]);
  });

  it('drops out-of-range and non-integer entries without throwing', () => {
    expect(validateScreenIndices([0, -1, 1.5, 6, 2], 5)).toEqual([2]);
  });

  it('throws on a non-array, non-wrapper value', () => {
    expect(() => validateScreenIndices('sure, note 2 looks relevant', 5)).toThrow();
    expect(() => validateScreenIndices(null, 5)).toThrow();
  });

  it('an empty array, or an array that fully drops, validates to []', () => {
    expect(validateScreenIndices([], 5)).toEqual([]);
    expect(validateScreenIndices([0, 99], 5)).toEqual([]);
  });
});

describe('validateBandResult', () => {
  it.each(['strong', 'moderate', 'weak', 'none', ' STRONG '] as const)(
    'accepts band %s case/whitespace-insensitively',
    (raw) => {
      const result = validateBandResult({ band: raw, reason: 'x' });
      expect(result.band).toBe(raw.trim().toLowerCase());
    },
  );

  it('defaults an unrecognised band to none rather than throwing', () => {
    expect(validateBandResult({ band: 'maybe', reason: 'x' }).band).toBe('none');
  });

  it('throws on a non-object value', () => {
    expect(() => validateBandResult('strong')).toThrow();
    expect(() => validateBandResult(null)).toThrow();
  });

  it('coerces a missing or non-string reason to "", and caps an over-long one', () => {
    expect(validateBandResult({ band: 'weak' }).reason).toBe('');
    const long = 'x'.repeat(10_000);
    expect(validateBandResult({ band: 'weak', reason: long }).reason.length).toBeLessThanOrEqual(500);
  });
});
```

  Run — fails.

- [ ] **Step 2: Implement** `src/search/validate.ts`:

```ts
export type SmartSearchBand = 'strong' | 'moderate' | 'weak';
export interface BandResult {
  band: SmartSearchBand | 'none';
  reason: string;
}

/** A row longer than this is noise, not a reason; same convention as gaps/validate.ts's GAP_TEXT_MAX. */
export const SEARCH_REASON_MAX = 500;

const WRAPPER_KEYS = ['indices', 'candidates', 'relevant', 'matches', 'ids'];
const BAND_VALUES: ReadonlySet<string> = new Set(['strong', 'moderate', 'weak', 'none']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const cap = (text: string, max: number): string => text.trim().slice(0, max);

function toIndex(row: unknown): number | null {
  if (typeof row === 'number' && Number.isInteger(row)) return row;
  if (isRecord(row) && typeof row.index === 'number' && Number.isInteger(row.index)) return row.index;
  return null;
}

/**
 * The screen stage's `validate` (docs/architecture.md §6.4). A row outside
 * `1..candidateCount`, or not a number at all, is dropped - one bad entry
 * costs one candidate, not the whole screen. A non-array, non-wrapper value
 * throws: the model did not do the task, which must not look like "found
 * nothing".
 */
export function validateScreenIndices(value: unknown, candidateCount: number): number[] {
  let rows: unknown[];
  if (Array.isArray(value)) {
    rows = value;
  } else if (isRecord(value)) {
    const wrapped = WRAPPER_KEYS.map((key) => value[key]).find((v) => Array.isArray(v));
    if (!Array.isArray(wrapped)) {
      throw new Error('The model did not return a JSON array of note numbers.');
    }
    rows = wrapped;
  } else {
    throw new Error('The model did not return a JSON array of note numbers.');
  }

  const seen = new Set<number>();
  for (const row of rows) {
    const index = toIndex(row);
    if (index === null || index < 1 || index > candidateCount) continue;
    seen.add(index);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The band stage's `validate`. Throws only when the value is not even a
 * JSON object (prose). An unrecognised `band` defaults to `'none'` rather
 * than throwing - a malformed label on an otherwise-answered call sinks
 * only this candidate, matching gaps/validate.ts's "unknown kind becomes
 * 'other'" convention.
 */
export function validateBandResult(value: unknown): BandResult {
  if (!isRecord(value)) {
    throw new Error('The model did not return a JSON object with "band" and "reason".');
  }
  const raw = typeof value.band === 'string' ? value.band.trim().toLowerCase() : '';
  const band = (BAND_VALUES.has(raw) ? raw : 'none') as SmartSearchBand | 'none';
  const reason = typeof value.reason === 'string' ? cap(value.reason, SEARCH_REASON_MAX) : '';
  return { band, reason };
}
```

  Run — green.

- [ ] **Step 3: Mutation-check.** Remove the `index < 1 || index >
  candidateCount` bound check → the out-of-range test must fail (`6` would
  survive). Change the `band` default from `'none'` to leaving `raw`
  unchecked → the "unrecognised band" test must fail. Revert both.

- [ ] **Step 4: Gates and commit.** `feat(search): add the smart-search
  JSON validators`. (This commit should land before, or together with,
  Task 3's commit, since Task 3's test imports from here — fine to squash
  Tasks 3 and 4 into one commit if that's how the work actually happened;
  keep them as two logical steps either way.)

---

### Task 5: `runSmartSearch` (`smartSearch.ts`)

**Files:**
- Create: `src/search/fakeTextGenerator.ts` (test support)
- Create: `src/search/smartSearch.ts`
- Test: `src/search/smartSearch.test.ts`

**Interfaces:**
- Consumes: `SearchCorpus` (Task 1), `getScreenPrompt`/`getBandPrompt`
  (Task 3), `validateScreenIndices`/`validateBandResult` (Task 4),
  `TextGenerator` (`@/llm/ollamaText`).
- Produces: `SmartSearchHit`, `SmartSearchResult`, `SmartSearchDeps`,
  `runSmartSearch(query, corpus, deps, opts?)`.

- [ ] **Step 1: Write the test support** `src/search/fakeTextGenerator.ts`
  — a small local copy of `src/gaps/fakeTextGenerator.ts`'s shape (don't
  import across units): `calls: FakeGeneratorCall[]`, `replies: string[]`,
  `failWith: Error | null`, `onGenerate` hook, same `generate`/`generateJson`
  semantics.

- [ ] **Step 2: Write the failing test** `src/search/smartSearch.test.ts`
  covering the 11 cases in `s6-spec.md`'s Tests §"smartSearch.test.ts"
  (25–35). Representative cases:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createFakeTextGenerator } from '@/search/fakeTextGenerator';
import { runSmartSearch } from '@/search/smartSearch';
import type { SearchCorpus } from '@/search/corpus';

function note(id: string, summary: string | null, pages: { pageIndex: number; text: string }[] = []) {
  return {
    note: { id, title: `Note ${id}`, summary, /* ...other NoteRecord fields with sane defaults */ } as any,
    pages: pages.map((p) => ({ pageId: `${id}-${p.pageIndex}`, pageIndex: p.pageIndex, isTyped: false, text: p.text })),
  };
}

describe('runSmartSearch', () => {
  it('screens a summary-less note on its title and page text instead (K46)', async () => {
    const corpus: SearchCorpus = {
      notes: [note('a', null, [{ pageIndex: 0, text: 'recursion and base cases' }])],
      recordings: [],
      recordingOwner: new Map(),
    };
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"recursion and base cases"}']);
    await runSmartSearch('recursion', corpus, { generator: gen, model: 'gemma4:12b' });
    expect(gen.calls[0].prompt).toContain('recursion and base cases');
    expect(gen.calls[0].prompt).not.toContain('undefined');
  });

  it('counts exactly the summary === null notes, independent of what the screen returns', async () => {
    const corpus: SearchCorpus = {
      notes: [note('a', null), note('b', 'has a summary'), note('c', null)],
      recordings: [],
      recordingOwner: new Map(),
    };
    const gen = createFakeTextGenerator(['[]']);
    const result = await runSmartSearch('anything', corpus, { generator: gen, model: 'm' });
    expect(result.unsummarizedCount).toBe(2);
  });

  it('makes zero generator calls for an empty corpus', async () => {
    const corpus: SearchCorpus = { notes: [], recordings: [], recordingOwner: new Map() };
    const gen = createFakeTextGenerator();
    const result = await runSmartSearch('anything', corpus, { generator: gen, model: 'm' });
    expect(gen.calls.length).toBe(0);
    expect(result).toEqual({ strong: [], moderate: [], weak: [], unsummarizedCount: 0 });
  });

  it('makes zero generator calls for a blank query', async () => {
    const corpus: SearchCorpus = { notes: [note('a', 's')], recordings: [], recordingOwner: new Map() };
    const gen = createFakeTextGenerator();
    await runSmartSearch('   ', corpus, { generator: gen, model: 'm' });
    expect(gen.calls.length).toBe(0);
  });

  it('propagates a screen-call rejection (an unreachable host) rather than swallowing it', async () => {
    const corpus: SearchCorpus = { notes: [note('a', 's')], recordings: [], recordingOwner: new Map() };
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://localhost:11434: fetch failed');
    await expect(runSmartSearch('q', corpus, { generator: gen, model: 'm' })).rejects.toThrow(/Could not reach Ollama/);
  });

  it('drops only the candidate whose band call rejects; the others still come back', async () => {
    const corpus: SearchCorpus = {
      notes: [note('a', 's1'), note('b', 's2')],
      recordings: [],
      recordingOwner: new Map(),
    };
    const gen = createFakeTextGenerator(['[1, 2]']);
    let call = 0;
    gen.onGenerate = (c) => {
      if (c.json && call++ === 1) throw new Error('boom');
    };
    gen.replies.push('{"band":"strong","reason":"r1"}', '{"band":"strong","reason":"r2"}');
    const result = await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(result.strong).toHaveLength(1);
  });

  it('runs band calls serially, never overlapping', async () => {
    const corpus: SearchCorpus = {
      notes: [note('a', 's1'), note('b', 's2')],
      recordings: [],
      recordingOwner: new Map(),
    };
    const gen = createFakeTextGenerator(['[1, 2]', '{"band":"weak","reason":"r"}', '{"band":"weak","reason":"r"}']);
    let inFlight = 0;
    let overlapped = false;
    gen.onGenerate = async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight--;
    };
    await runSmartSearch('q', corpus, { generator: gen, model: 'm' });
    expect(overlapped).toBe(false);
  });
});
```

  (Fill in the remaining cases from the spec's test list: `'none'`
  exclusion, section placement by band, only-screened-candidates-get-banded,
  abort before the screen call, abort between band calls.) Run — fails.

- [ ] **Step 3: Implement** `src/search/smartSearch.ts`:

```ts
import type { SearchCorpus, SearchNote } from '@/search/corpus';
import { getBandPrompt, getScreenPrompt, type ScreenCandidate } from '@/search/prompts';
import { validateBandResult, validateScreenIndices, type SmartSearchBand } from '@/search/validate';
import type { TextGenerator } from '@/llm/ollamaText';

export const SCREEN_TEXT_MAX = 1000;
export const SCREEN_FALLBACK_TEXT_MAX = 800;
export const DETAIL_TEXT_MAX_CHARS = 12_000;

export interface SmartSearchHit {
  noteId: string;
  noteTitle: string;
  band: SmartSearchBand;
  reason: string;
}

export interface SmartSearchResult {
  strong: SmartSearchHit[];
  moderate: SmartSearchHit[];
  weak: SmartSearchHit[];
  /** Notes with `summary === null`, screened by title + page text instead (K44/K46). */
  unsummarizedCount: number;
}

export interface SmartSearchDeps {
  generator: TextGenerator;
  model: string;
}

const cap = (text: string, max: number): string => text.trim().slice(0, max);

function joinedPageText(note: SearchNote): string {
  return note.pages.map((p) => p.text).filter((t) => t.length > 0).join('\n\n');
}

function buildCandidates(notes: SearchNote[]): ScreenCandidate[] {
  return notes.map((n, i) => {
    const summary = n.note.summary;
    const text = summary !== null
      ? cap(summary, SCREEN_TEXT_MAX)
      : cap(joinedPageText(n), SCREEN_FALLBACK_TEXT_MAX);
    return { index: i + 1, title: n.note.title, text };
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Smart search aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * K42: two-stage, summary-first smart search. See docs/features/s6-spec.md
 * "Design" for the full reasoning behind each numbered step below.
 */
export async function runSmartSearch(
  query: string,
  corpus: SearchCorpus,
  deps: SmartSearchDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<SmartSearchResult> {
  const trimmedQuery = query.trim();
  const unsummarizedCount = corpus.notes.filter((n) => n.note.summary === null).length;
  const empty: SmartSearchResult = { strong: [], moderate: [], weak: [], unsummarizedCount };

  if (corpus.notes.length === 0 || trimmedQuery === '') return empty;

  throwIfAborted(opts.signal);

  const candidates = buildCandidates(corpus.notes);
  const screenSpec = getScreenPrompt();
  // Not caught here: an unreachable host must surface through this
  // rejection (K44), the first Ollama call this function makes.
  const chosenIndices = await deps.generator.generateJson(
    screenSpec.build({ query: trimmedQuery, candidates }),
    {
      model: deps.model,
      system: screenSpec.system,
      signal: opts.signal,
      validate: (value) => validateScreenIndices(value, candidates.length),
    },
  );

  const chosen = candidates.filter((c) => chosenIndices.includes(c.index));
  const bandSpec = getBandPrompt();
  const result: SmartSearchResult = { ...empty };

  for (const candidate of chosen) {
    throwIfAborted(opts.signal);
    const note = corpus.notes[candidate.index - 1];
    const text = cap(joinedPageText(note), DETAIL_TEXT_MAX_CHARS);
    try {
      const banded = await deps.generator.generateJson(
        bandSpec.build({ query: trimmedQuery, noteTitle: candidate.title, text }),
        {
          model: deps.model,
          system: bandSpec.system,
          signal: opts.signal,
          validate: validateBandResult,
        },
      );
      if (banded.band === 'none') continue;
      result[banded.band].push({ noteId: note.note.id, noteTitle: candidate.title, band: banded.band, reason: banded.reason });
    } catch (error) {
      if (isAbort(error)) throw error;
      // S6-A4: one candidate's bad answer must not cost the rest of an
      // already-screened run.
      console.error('[search] smart search band scoring failed for a candidate', note.note.id, error);
    }
  }

  return result;
}
```

  Run — green.

- [ ] **Step 4: Mutation-check** each pinned behaviour: remove the
  `corpus.notes.length === 0 || trimmedQuery === ''` short-circuit → the
  zero-calls tests must fail; remove the `try/catch` around the band call →
  the "drops only the failing candidate" test must fail (the whole run
  would reject instead); change the loop to `Promise.all` → the
  serial-calls test must fail. Revert each.

- [ ] **Step 5: Gates and commit.** `feat(search): add the two-stage smart
  search (screen, then band)`.

---

### Task 6: Settings-wired deps (`startSearch.ts`)

**Files:**
- Create: `src/search/startSearch.ts` (no dedicated test — mirrors
  `src/gaps/startGaps.ts`, which also has none; never called by a test).

- [ ] **Step 1: Implement**:

```ts
import { createOllamaTextGenerator } from '@/llm/ollamaText';
import type { SmartSearchDeps } from '@/search/smartSearch';
import { getSettingValue } from '@/storage/settingKeys';

/**
 * A smart-search generator wired to the app's settings - the same Ollama
 * host and model as everything else (A30/A36). Built per run, not cached,
 * so a settings change between two presses is picked up. Never called by a
 * test - a test injects its own deps instead.
 */
export async function getSmartSearchDeps(): Promise<SmartSearchDeps> {
  const [baseUrl, model] = await Promise.all([
    getSettingValue('ollama.baseUrl'),
    getSettingValue('ollama.model'),
  ]);
  return { generator: createOllamaTextGenerator({ baseUrl }), model };
}
```

- [ ] **Step 2: Gates and commit.** `feat(search): wire smart search to the
  app's Ollama settings`.

---

### Task 7: `SearchView.tsx`

**Files:**
- Create: `src/search/SearchView.tsx`
- Test: `src/search/SearchView.test.tsx`

**Interfaces:**
- Consumes: `loadSearchCorpus` (Task 1), `findInCorpus` (Task 2),
  `runSmartSearch`/`SmartSearchDeps` (Task 5), `getSmartSearchDeps`
  (Task 6), `Button`/`Input` (`@/components/ui`).
- Produces: `SearchViewProps { smartSearchDeps?; onOpenNotes?; onOpenRecordings? }`,
  `SearchView`.

- [ ] **Step 1: Write the failing test** `src/search/SearchView.test.tsx`,
  following `src/notes/NotesView.test.tsx`'s `createRoot`/`act` pattern
  and `buttons()`/`buttonByText()`/`click()` helpers, against the **real**
  database (`resetDatabase()` + `createNote`/`createPage`/
  `setPageTranscript`/`createRecording` etc., same as `NotesView.test.tsx`
  does) with an injected `smartSearchDeps` built on `createFakeTextGenerator`.
  Cover the 9 cases in the spec (36–44):

```ts
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeTextGenerator } from '@/search/fakeTextGenerator';
import { SearchView } from '@/search/SearchView';
import { createNote } from '@/storage/notes';
import { createPage, setPageTranscript } from '@/storage/pages';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

function queryInput(): HTMLInputElement {
  return container.querySelector('input')!;
}

async function type(value: string) {
  const input = queryInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}
function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}`);
  return found;
}
async function click(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
}

function render(props: Parameters<typeof SearchView>[0] = {}) {
  act(() => { root.render(<SearchView {...props} />); });
}

describe('SearchView', () => {
  it('renders the empty-library message and no Smart search button when there is nothing to search', async () => {
    render();
    await settle();
    expect(container.textContent).toContain('Nothing to search yet');
    expect(() => buttonByText('Smart search')).toThrow();
  });

  it('finds a note by title live, with no explicit submit', async () => {
    await createNote({ title: 'Thermodynamics', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    await type('thermo');
    expect(container.textContent).toContain('Thermodynamics');
  });

  it('Smart search is disabled for a blank query and enabled once both a note and a query exist', async () => {
    await createNote({ title: 'N', deviceId: 'd', pageBaseline: 0 });
    render();
    await settle();
    expect(buttonByText('Smart search').disabled).toBe(true);
    await type('x');
    expect(buttonByText('Smart search').disabled).toBe(false);
  });

  it('renders Strong/Moderate/Weak from a smart search run, excluding a none band', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[1]', '{"band":"strong","reason":"it matches"}']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('Strong');
    expect(container.textContent).toContain('it matches');
  });

  it('shows a plain error string, and stays interactive, when the generator rejects', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator();
    gen.failWith = new Error('Could not reach Ollama at http://x: fetch failed');
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('something');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toContain('Could not reach Ollama');
    await type('still works');
    expect(queryInput().value).toBe('still works');
  });

  it('shows the unsummarizedCount line after a run over an all-null-summary library', async () => {
    await createNote({ title: 'A', deviceId: 'd', pageBaseline: 0 });
    const gen = createFakeTextGenerator(['[]']);
    render({ smartSearchDeps: { generator: gen, model: 'm' } });
    await settle();
    await type('x');
    await click(buttonByText('Smart search'));
    expect(container.textContent).toMatch(/1 note.*no summary/);
  });

  it('a Find hit\'s Open button calls onOpenNotes for a note hit', async () => {
    await createNote({ title: 'Unique Title', deviceId: 'd', pageBaseline: 0 });
    const onOpenNotes = vi.fn();
    render({ onOpenNotes });
    await settle();
    await type('unique');
    await click(buttonByText('Open'));
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });
});
```

  Run — fails (`@/search/SearchView` doesn't exist).

- [ ] **Step 2: Implement** `src/search/SearchView.tsx` per `s6-spec.md`'s
  "Design" §`SearchView.tsx`. Key shape:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatClock } from '@/audio/format';
import { loadSearchCorpus, type SearchCorpus } from '@/search/corpus';
import { findInCorpus, type FindHit } from '@/search/find';
import { getSmartSearchDeps } from '@/search/startSearch';
import { runSmartSearch, type SmartSearchDeps, type SmartSearchResult } from '@/search/smartSearch';

export interface SearchViewProps {
  /** Tests only - a real mount builds its own via getSmartSearchDeps. */
  smartSearchDeps?: SmartSearchDeps;
  onOpenNotes?: () => void;
  onOpenRecordings?: () => void;
}

const SOURCE_LABEL: Record<FindHit['source'], string> = {
  'note-title': 'Title',
  'note-summary': 'Summary',
  'page-text': 'Page',
  'audio-segment': 'Recording',
};

export function SearchView({ smartSearchDeps, onOpenNotes, onOpenRecordings }: SearchViewProps = {}) {
  const [corpus, setCorpus] = useState<SearchCorpus | null>(null);
  const [query, setQuery] = useState('');
  const [smart, setSmart] = useState<SmartSearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    let live = true;
    void loadSearchCorpus().then((c) => { if (live) setCorpus(c); });
    return () => { live = false; };
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
    <section aria-label="Search" className="flex h-full flex-col gap-4 p-4">
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

          <ul className="space-y-2">
            {hits.map((hit, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-sm">
                <div>
                  <span className="font-medium">{SOURCE_LABEL[hit.source]}</span>
                  {hit.noteTitle && <span> — {hit.noteTitle}</span>}
                  {hit.pageIndex !== undefined && <span> (page {hit.pageIndex + 1}{hit.isTyped ? ', typed' : ''})</span>}
                  {hit.recordingTitle && <span> — {hit.recordingTitle}</span>}
                  {hit.startMs !== undefined && <span> at {formatClock(hit.startMs)}</span>}
                  <p className="text-muted-foreground">{hit.snippet}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openFor(hit)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>

          {smart && (
            <div className="space-y-3">
              {smart.unsummarizedCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {smart.unsummarizedCount} {smart.unsummarizedCount === 1 ? 'note' : 'notes'} have no
                  summary yet and were screened by title and page text instead.
                </p>
              )}
              {(['strong', 'moderate', 'weak'] as const).map((band) => (
                <div key={band}>
                  <h3 className="text-sm font-medium capitalize">{band}</h3>
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
```

  Run — iterate until green. (The `Button`/`Input` prop names and the
  exact copy above are a starting point; adjust wording as needed as long
  as every spec'd test assertion still holds — e.g. "Nothing to search
  yet", the `/1 note.*no summary/` match, and the `Open` button text are
  the three strings under test and must not drift without updating the
  test.)

- [ ] **Step 3: Mutation-check** at least: remove the `runningRef` guard →
  a double-click test (add one if not already covered) must be able to
  double-fire; remove the `isEmptyLibrary` branch → the empty-library test
  must fail; change `onOpenRecordings?.()` to always call `onOpenNotes?.()`
  → an audio-hit-routing test must fail (add one asserting `onOpenRecordings`
  specifically, if the spec's test 44 didn't already cover both kinds
  explicitly — strengthen it here if needed).

- [ ] **Step 4: Gates and commit.** `feat(search): add the Search view
  (Find live, Smart search on demand)`.

---

### Task 8: Mount the Search tab (`AppShell.tsx`)

**Files:**
- Edit: `src/app/AppShell.tsx`
- Edit: `src/app/AppShell.test.tsx`

- [ ] **Step 1: Update the failing test** in `src/app/AppShell.test.tsx`:
  change `'shows the three tabs...'` to assert four
  (`tab('Search')` truthy too), and add:

```ts
it('switches to Search and renders its landmark', async () => {
  renderShell();
  await act(async () => {
    tab('Search').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab('Search').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(tab('Search').getAttribute('data-state')).toBe('active');
  expect(container.querySelector('[aria-label="Search"]')).not.toBeNull();
});
```

  Run `npx vitest run src/app/AppShell.test.tsx` — fails.

- [ ] **Step 2: Implement.** In `src/app/AppShell.tsx`, import
  `SearchView`, add `<TabsTrigger value="search">Search</TabsTrigger>`
  after Triage's trigger, and a matching `<TabsContent value="search">`
  rendering `<SearchView onOpenNotes={() => setTab('notes')}
  onOpenRecordings={() => setTab('recordings')} />`.

  Run — green.

- [ ] **Step 3: Gates and commit.** `feat(app): add the Search tab,
  wired to cross-tab navigation`.

---

### Task 9: Full mutation-check pass and final gates

- [ ] Re-run every mutation-check from Tasks 1–8 in one pass, back to back,
  to catch any that a later refactor (e.g. Task 7 changing copy Task 1–5
  didn't anticipate) might have silently defeated. Record each result in
  the report.
- [ ] `npx tsc -b && npm run lint && npm run build && npm test` — all four
  green, test count ≥ 1367 + the new files' counts.
- [ ] Write `docs/features/s6-report.md` (status, branch, commits, test
  summary, decisions implemented, any mutation not detected, concerns —
  including S6-A6's cross-tab-only navigation and S6-A4's band-stage
  resilience trade-off, both already flagged in the spec but worth
  repeating in the report for visibility). Commit it.
