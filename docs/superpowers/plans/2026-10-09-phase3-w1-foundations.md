# Phase 3 Wave 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land schema v4, the storage writers for every new Phase 3 field, `engine.resumeNote()`, and the notes-view mount points, so the five Wave 2 units can be built in parallel without touching each other's files.

**Architecture:** Additive schema change (`DB_VERSION` 3 → 4) with one new store, `recordingChunks`, and four new optional record fields, each with a documented absent-reading. Every new field gets its repository writer here rather than in the feature unit that consumes it, so two units cannot invent conflicting APIs for the same column. `resumeNote()` joins the capture engine's existing serial op chain. The notes view's sidebar and toolbar are extracted into two components with explicit slot props — those slots are the Wave 2 mount points.

**Tech Stack:** TypeScript, React 19, `idb` for IndexedDB, Vitest with happy-dom (and React's own `act` + `createRoot` for component tests — no testing-library), Tailwind.

**Spec:** `docs/spec-phase3.md` (decisions K1–K45). Read it alongside this plan. Also relevant: `docs/architecture.md` §3.1 (engine behavioural rules), §6.5 (the engine must not depend on the recorder), §6.7 (mount-point ownership), and `docs/assumptions.md`.

## Global Constraints

- **Schema changes are additive only** (K1). New stores, new indexes, new optional fields. No row is rewritten by an upgrade.
- **Each `if (oldVersion < N)` block in `src/storage/db.ts` is frozen once shipped.** Add a new block; never edit an existing one. The inlined `createV1Database`/`createV2Database` helpers in `db.test.ts` are frozen with them.
- **Every new record field is optional with a documented absent-reading**, following `sessionId` (v2) and `gapAnalysis` (v3) in `src/storage/types.ts`. Absent readings: `tags` → `[]`, `titleSource` → `'default'`, `summaryPromptVersion` → `null`, `PageRecord.text` → `undefined`.
- **The capture engine must not depend on the recorder** (`architecture.md` §6.5). Nothing in `src/capture/` may import from `src/audio/`.
- **No new runtime dependencies, and no new dev dependencies.** Phase 3 adds none.
- **Component tests use this project's own idiom, not `@testing-library/react`** — which is not a dependency and is used nowhere in `src/`. The idiom is `createRoot` from `react-dom/client` plus `act` from `react`, under happy-dom, with DOM queries against a `container` div. `src/notes/NotesView.test.tsx:14-140` is the reference, and its `buttons()` / `buttonByText()` / `click()` helpers are the house pattern.
- **Commands:** tests `npm test`, typecheck `npx tsc -b`, lint `npm run lint`, build `npm run build`. All four must pass before each commit.
- **Baseline to preserve:** 1083 tests across 90 files pass on `main`. The count only goes up.
- **Every new test must be mutation-checked**: after it goes green, break the implementation and confirm the test goes red. Two tests in the Phase 2 session passed vacuously. A test that cannot fail is a plan failure, not a passing step.

## Review Focus

Five conditions the spec implies that no obvious happy-path test would exercise. Each has a test assigned to the task that owns the code.

1. **`resumeNote()` on the note that is already open** must be a no-op returning the live ids — closing and reopening would finalize the live page and discard the stroke in progress. (Task 5, Step 13)
2. **`resumeNote()` on a legacy note with `sessionId: null`**, or one whose session row has been deleted, must create and link a session rather than throwing — every note is resumable (K14). (Task 5, Step 9)
3. **`resumeNote()` on a note with no pages at all** must open page index 0, not `NaN` from `Math.max()` over an empty array. (Task 5, Step 11)
4. **A blank or whitespace-only typed page** must leave `transcript: null`, not write a `'done'` transcript with empty markdown — an empty "finished" transcript would poison search (K41) and gap analysis, which skips contentless pages by A22. (Task 3, Step 7)
5. **Stitching chunks whose `seq` values arrived out of order, or have a hole from a failed write**, must concatenate in `seq` order and still return a blob — a dropped chunk is a hole that cannot be filled, and refusing to stitch would turn one lost second into a lost lecture. (Task 4, Step 9)

---

## File Structure

**Created:**
- `src/storage/recordingChunks.ts` — the `recordingChunks` store's repository: append, list, stitch, delete. Separate from `recordings.ts` because it is a different store with a different lifecycle (chunks are transient; recordings are not).
- `src/storage/recordingChunks.test.ts`
- `src/notes/NoteList.tsx` — the sidebar, with `filter` and `rowActions` slots. **Wave 2 mount point.**
- `src/notes/NoteList.test.tsx`
- `src/notes/NoteToolbar.tsx` — the page toolbar, with `title`, `meta`, `actions` and `banner` slots. **Wave 2 mount point.**
- `src/notes/NoteToolbar.test.tsx`

**Modified:**
- `src/storage/types.ts` — new fields and types.
- `src/storage/db.ts` — `DB_VERSION` 4, `recordingChunks` in `NotesDb`, the `oldVersion < 4` block.
- `src/storage/db.test.ts` — a frozen `createV3Database` helper and v3 → v4 assertions.
- `src/storage/notes.ts` — tag, title-provenance and summary writers.
- `src/storage/pages.ts` — typed-page creation and text writer; `pageEndedAt` helper.
- `src/storage/recordings.ts` — `listUnfinishedRecordings`; `deleteRecording` also drops chunks.
- `src/capture/types.ts` — `resumeNote` on the `CaptureEngine` interface.
- `src/capture/engine.ts` — `resumeNote` implementation; `recover()` reuses `pageEndedAt`.
- `src/notes/NotesView.tsx` — renders the two extracted components.

---

### Task 1: Schema v4 — types and the upgrade block

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/db.ts:17` (`DB_VERSION`), `:19-66` (`NotesDb`), `:80-124` (`upgrade`)
- Test: `src/storage/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TitleSource = 'default' | 'auto' | 'manual'`; `PageSource` gains `'typed'`; `NoteRecord.tags?: string[]`, `NoteRecord.titleSource?: TitleSource`, `NoteRecord.summaryPromptVersion?: string | null`; `PageRecord.text?: string`; `RecordingChunkRecord { id, recordingId, seq, data, type }`; `DB_VERSION === 4`; the `recordingChunks` store with index `by-recording`.

- [ ] **Step 1: Add the new types**

In `src/storage/types.ts`, change `PageSource` and add the rest. Keep the comment style of the surrounding file — every optional field says what absent means and why it is optional.

```ts
export type PageSource = 'rom' | 'live' | 'typed';

/**
 * Where a note's title came from, which is what lets auto-naming respect a
 * manual rename (K2). Absent on v1-v3 rows, which reads as `'default'` - the
 * `Note <timestamp>` placeholder `openNote()` writes - so every pre-Phase-3
 * note is eligible for auto-naming. That eligibility is also the summary
 * backfill smart search needs.
 */
export type TitleSource = 'default' | 'auto' | 'manual';
```

On `NoteRecord`, after `sessionId`:

```ts
  /**
   * Free-form tags, normalized on write (K3): trimmed, lowercased,
   * deduplicated, blanks dropped. The displayed form is the stored form, so
   * there is no display name to keep in sync. Absent on pre-v4 rows, which
   * reads as `[]`.
   */
  tags?: string[];
  /** See `TitleSource`. Absent reads as `'default'`. */
  titleSource?: TitleSource;
  /**
   * Identifies the prompt that produced `summary`, for the same reason
   * `TranscriptRecord.promptVersion` exists: prompts get tuned far more often
   * than models get swapped. Absent reads as `null`.
   */
  summaryPromptVersion?: string | null;
```

On `PageRecord`, after `gapAnalysis`:

```ts
  /**
   * The typed content of a `source: 'typed'` page (K32). Absent on ink pages.
   * A typed page's text is also mirrored into its `transcript` (K33), which is
   * what lets transcription skip it while search and gap analysis read it
   * through the one field they already know about.
   */
  text?: string;
```

At the end of the file:

```ts
/**
 * One `MediaRecorder` chunk, persisted as it arrives so an interrupted session
 * keeps its audio (K4). Transient: `stop()` stitches these into
 * `recordingAudio` and deletes them, so a row here means a recording that is
 * either in progress or was interrupted.
 */
export interface RecordingChunkRecord {
  id: string;
  recordingId: string;
  /** Monotonic per recording, starting at 0. Stitch order (K6). */
  seq: number;
  data: ArrayBuffer;
  /** The `MediaRecorder` MIME type, carried so stitching needs no second read. */
  type: string;
}
```

- [ ] **Step 2: Write the failing schema test**

Add to `src/storage/db.test.ts`. The frozen-helper comment matters: this copy of the v3 blocks must never drift from `db.ts`'s.

```ts
/**
 * Builds a database at schema version 3 exactly as the shipped v1, v2 and v3
 * upgrade blocks did, so the upgrade test exercises the real v3 → v4 path
 * rather than a fresh v4 create. Inlined for the same reason as
 * `createV1Database`: those blocks are frozen and this copy stays frozen too.
 */
async function createV3Database(): Promise<void> {
  const db = await openDB(DB_NAME, 3, {
    upgrade(database) {
      const notes = database.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('by-started', 'startedAt');
      notes.createIndex('by-session', 'sessionId');
      const pages = database.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('by-note', 'noteId');
      database.createObjectStore('pageRenders');
      database.createObjectStore('settings', { keyPath: 'key' });
      const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('by-started', 'startedAt');
      const recordings = database.createObjectStore('recordings', { keyPath: 'id' });
      recordings.createIndex('by-session', 'sessionId');
      recordings.createIndex('by-started', 'startedAt');
      database.createObjectStore('recordingAudio');
      const events = database.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('by-start', 'startsAt');
      const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
      tasks.createIndex('by-status', 'status');
      tasks.createIndex('by-event', 'eventId');
      const gaps = database.createObjectStore('gaps', { keyPath: 'id' });
      gaps.createIndex('by-note', 'noteId');
      gaps.createIndex('by-page', 'pageId');
    },
  });
  await db.put('notes', { id: 'note-3', title: 'Phase 2', startedAt: 3_000, sessionId: 'ses-3' });
  await db.put('pages', { id: 'page-3', noteId: 'note-3', pageIndex: 0 });
  await db.put('gaps', { id: 'gap-3', noteId: 'note-3', pageId: 'page-3' });
  db.close();
}
```

And inside `describe('openNotesDb')`:

```ts
  it('creates the v4 recordingChunks store and its index', async () => {
    const db = await openNotesDb();
    expect(db.objectStoreNames).toContain('recordingChunks');
    expect([...db.transaction('recordingChunks').store.indexNames]).toEqual(['by-recording']);
  });

  it('upgrades a v3 database to v4 without losing its rows', async () => {
    await createV3Database();

    const db = await openNotesDb();
    expect(db.version).toBe(4);
    expect(await db.get('notes', 'note-3')).toMatchObject({ title: 'Phase 2' });
    expect(await db.get('pages', 'page-3')).toMatchObject({ noteId: 'note-3' });
    expect(await db.get('gaps', 'gap-3')).toMatchObject({ pageId: 'page-3' });
    expect(db.objectStoreNames).toContain('recordingChunks');
    // The v2 indexes survive the version change untouched.
    expect([...db.transaction('notes').store.indexNames].sort()).toEqual([
      'by-session',
      'by-started',
    ]);
  });
```

Also update the existing `creates the expected object stores` assertion (`db.test.ts:72`), which compares a sorted array. `recordingChunks` sorts between `recordingAudio` and `recordings`, because the default sort is by code unit and `'A'` < `'C'` < `'s'`:

```ts
    expect([...db.objectStoreNames].sort()).toEqual([
      'events',
      'gaps',
      'notes',
      'pageRenders',
      'pages',
      'recordingAudio',
      'recordingChunks',
      'recordings',
      'sessions',
      'settings',
      'tasks',
    ]);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/storage/db.test.ts`
Expected: FAIL — `db.version` is 3, not 4, and `objectStoreNames` has no `recordingChunks`.

- [ ] **Step 4: Bump the schema**

In `src/storage/db.ts`: import `RecordingChunkRecord` from `@/storage/types`, set `export const DB_VERSION = 4;`, add to `NotesDb`:

```ts
  /**
   * In-line keys. Transient per-chunk audio for a recording in progress; see
   * `RecordingChunkRecord`.
   */
  recordingChunks: {
    key: string;
    value: RecordingChunkRecord;
    indexes: { 'by-recording': string };
  };
```

and add a new upgrade block after the `oldVersion < 3` one:

```ts
        if (oldVersion < 4) {
          // Phase 3 incremental audio (K4-K7). Indexed by recording so a
          // stitch reads exactly one recording's chunks, and so a recording
          // deleted mid-flight can drop its own without a full scan.
          const chunks = db.createObjectStore('recordingChunks', { keyPath: 'id' });
          chunks.createIndex('by-recording', 'recordingId');
          // No data migration: every v4 field is optional with a documented
          // absent-reading (K1), so existing rows are already valid v4 rows.
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/storage/db.test.ts`
Expected: PASS

- [ ] **Step 6: Mutation-check**

Temporarily change `chunks.createIndex('by-recording', 'recordingId')` to `'recording'`. Confirm the index test goes red. Revert.

- [ ] **Step 7: Full verification and commit**

Run: `npm test && npx tsc -b && npm run lint`
Expected: all pass, test count up by 2.

```bash
git add src/storage/types.ts src/storage/db.ts src/storage/db.test.ts
git commit -m "feat(storage): schema v4 - tags, title provenance, typed pages, audio chunks"
```

---

### Task 2: Notes repository — tags, title provenance, summaries

**Files:**
- Modify: `src/storage/notes.ts`
- Test: `src/storage/notes.test.ts`

**Interfaces:**
- Consumes: Task 1's `TitleSource`, `NoteRecord.tags`, `NoteRecord.titleSource`, `NoteRecord.summaryPromptVersion`.
- Produces:
  - `normalizeTags(input: readonly string[]): string[]`
  - `tagsOf(note: NoteRecord): string[]`
  - `titleSourceOf(note: NoteRecord): TitleSource`
  - `setNoteTags(id: string, tags: readonly string[]): Promise<NoteRecord>`
  - `renameNote(id: string, title: string): Promise<NoteRecord>` — `async`, so a blank title rejects rather than throwing at the call site
  - `NoteSummaryInput { summary: string; model: string; promptVersion: string; title?: string }`
  - `setNoteSummary(id: string, input: NoteSummaryInput): Promise<NoteRecord>`
  - `listTagVocabulary(): Promise<string[]>`

- [ ] **Step 1: Write the failing tests for tag normalization**

Add to `src/storage/notes.test.ts`:

```ts
describe('tag normalization', () => {
  it('trims, lowercases, deduplicates and drops blanks', () => {
    expect(normalizeTags(['  Math ', 'MATH', 'history', '', '   ', 'History']))
      .toEqual(['math', 'history']);
  });

  it('preserves first-seen order so a note\'s tags do not reshuffle on every write', () => {
    expect(normalizeTags(['zeta', 'alpha', 'ZETA'])).toEqual(['zeta', 'alpha']);
  });

  it('reads an absent tags field as empty', () => {
    expect(tagsOf({ id: 'n' } as NoteRecord)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/storage/notes.test.ts`
Expected: FAIL — `normalizeTags is not a function`.

- [ ] **Step 3: Implement normalization**

In `src/storage/notes.ts`:

```ts
/**
 * K3: trimmed, lowercased, deduplicated, blanks dropped. First-seen order is
 * preserved rather than sorted, so writing a note's tags back does not
 * reshuffle them under the user's cursor.
 */
export function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().toLowerCase();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Absent on pre-v4 rows, which reads as no tags. */
export function tagsOf(note: NoteRecord): string[] {
  return note.tags ?? [];
}

/** Absent on pre-v4 rows, which reads as the `Note <timestamp>` placeholder. */
export function titleSourceOf(note: NoteRecord): TitleSource {
  return note.titleSource ?? 'default';
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/storage/notes.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the writers**

```ts
describe('note tags, titles and summaries', () => {
  async function note(overrides: Partial<CreateNoteInput> = {}) {
    return createNote({ title: 'Note 1', deviceId: 'huion:a', pageBaseline: 0, ...overrides });
  }

  it('normalizes on write', async () => {
    const created = await note();
    const updated = await setNoteTags(created.id, [' Seminar ', 'SEMINAR', 'week-3']);
    expect(updated.tags).toEqual(['seminar', 'week-3']);
    expect((await getNote(created.id))?.tags).toEqual(['seminar', 'week-3']);
  });

  it('renaming marks the title manual', async () => {
    const created = await note();
    const renamed = await renameNote(created.id, '  Hobbes, ch. 13  ');
    expect(renamed.title).toBe('Hobbes, ch. 13');
    expect(titleSourceOf(renamed)).toBe('manual');
  });

  it('refuses a blank rename', async () => {
    const created = await note();
    await expect(renameNote(created.id, '   ')).rejects.toThrow(/blank/i);
    expect((await getNote(created.id))?.title).toBe('Note 1');
  });

  it('a summary writes the title when the title is still the default', async () => {
    const created = await note();
    const summarized = await setNoteSummary(created.id, {
      summary: 'Sovereignty and the state of nature.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: 'Hobbes on sovereignty',
    });
    expect(summarized.title).toBe('Hobbes on sovereignty');
    expect(titleSourceOf(summarized)).toBe('auto');
    expect(summarized.summary).toBe('Sovereignty and the state of nature.');
    expect(summarized.summaryModel).toBe('gemma4:12b');
    expect(summarized.summaryPromptVersion).toBe('summary/1');
  });

  it('a summary never overwrites a manual title, but still writes the summary', async () => {
    const created = await note();
    await renameNote(created.id, 'My own title');
    const summarized = await setNoteSummary(created.id, {
      summary: 'Sovereignty.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: 'Hobbes on sovereignty',
    });
    expect(summarized.title).toBe('My own title');
    expect(titleSourceOf(summarized)).toBe('manual');
    expect(summarized.summary).toBe('Sovereignty.');
  });

  it('a summary with a blank title leaves the title alone', async () => {
    const created = await note();
    const summarized = await setNoteSummary(created.id, {
      summary: 'Something.',
      model: 'gemma4:12b',
      promptVersion: 'summary/1',
      title: '   ',
    });
    expect(summarized.title).toBe('Note 1');
    expect(titleSourceOf(summarized)).toBe('default');
  });

  it('builds the tag vocabulary from every note, sorted and deduplicated', async () => {
    const a = await note({ title: 'A' });
    const b = await note({ title: 'B' });
    await setNoteTags(a.id, ['seminar', 'week-3']);
    await setNoteTags(b.id, ['Seminar', 'lecture']);
    expect(await listTagVocabulary()).toEqual(['lecture', 'seminar', 'week-3']);
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/storage/notes.test.ts`
Expected: FAIL — `setNoteTags is not a function`.

- [ ] **Step 7: Implement the writers**

In `src/storage/notes.ts`, all built on the existing transactional `updateNote`:

```ts
export function setNoteTags(id: string, tags: readonly string[]): Promise<NoteRecord> {
  return updateNote(id, { tags: normalizeTags(tags) });
}

/**
 * A manual rename. Sets `titleSource: 'manual'`, which permanently opts this
 * note out of auto-titling (K20, A34) - the sticky flag is the whole point, so
 * this is the only path that writes a title by hand.
 */
// `async` deliberately, though nothing here awaits: a plain function that
// throws synchronously while declaring `Promise<NoteRecord>` rejects its
// *caller* rather than its promise, so `await expect(...).rejects` never
// sees it and every caller needs a try/catch around the call itself as
// well as around the await. `async` makes the throw a rejection.
export async function renameNote(id: string, title: string): Promise<NoteRecord> {
  const trimmed = title.trim();
  // A blank title would leave the note unidentifiable in the list, with no way
  // back except editing it again from a row that no longer names anything.
  if (trimmed === '') throw new Error('A note title cannot be blank');
  return updateNote(id, { title: trimmed, titleSource: 'manual' });
}

export interface NoteSummaryInput {
  summary: string;
  model: string;
  promptVersion: string;
  /** Written only when the title has not been set by hand (K18). */
  title?: string;
}

/**
 * K18: the summary always lands; the title lands only when the user has not
 * renamed the note. Read-modify-write in one transaction via `updateNote`,
 * after reading the existing row to decide about the title - two separate
 * transactions would let a rename land in between and be overwritten.
 */
export async function setNoteSummary(id: string, input: NoteSummaryInput): Promise<NoteRecord> {
  const existing = await getNote(id);
  if (!existing) throw new Error(`Note not found: ${id}`);

  const patch: Partial<Omit<NoteRecord, 'id'>> = {
    summary: input.summary,
    summaryModel: input.model,
    summaryPromptVersion: input.promptVersion,
  };

  const title = input.title?.trim() ?? '';
  // A blank generated title is a failed generation, not an instruction to
  // clear the title.
  if (title !== '' && titleSourceOf(existing) !== 'manual') {
    patch.title = title;
    patch.titleSource = 'auto';
  }
  return updateNote(id, patch);
}

/**
 * A35: derived by scanning rather than stored. A stored vocabulary would be a
 * cache to invalidate on every tag write, and the note count here is in the
 * hundreds.
 */
export async function listTagVocabulary(): Promise<string[]> {
  const notes = await listNotes();
  const all = new Set<string>();
  for (const note of notes) for (const tag of tagsOf(note)) all.add(tag);
  return [...all].sort();
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run src/storage/notes.test.ts`
Expected: PASS

- [ ] **Step 9: Mutation-check**

Delete the `titleSourceOf(existing) !== 'manual'` guard in `setNoteSummary`. Confirm `a summary never overwrites a manual title` goes red. Revert. Then change `renameNote`'s guard to `if (false)` and confirm `refuses a blank rename` goes red. Revert.

- [ ] **Step 10: Full verification and commit**

Run: `npm test && npx tsc -b && npm run lint`

```bash
git add src/storage/notes.ts src/storage/notes.test.ts
git commit -m "feat(storage): tag, title-provenance and summary writers"
```

---

### Task 3: Pages repository — typed pages

**Files:**
- Modify: `src/storage/pages.ts`
- Test: `src/storage/pages.test.ts`

**Interfaces:**
- Consumes: Task 1's `PageSource` `'typed'` and `PageRecord.text`.
- Produces:
  - `TYPED_MODEL = 'typed'`, `TYPED_PROMPT_VERSION = 'typed/1'`
  - `isTypedPage(page: PageRecord): boolean`
  - `CreateTypedPageInput { noteId: string; pageIndex: number; text?: string; capturedAt?: number }`
  - `createTypedPage(input: CreateTypedPageInput): Promise<PageRecord>`
  - `setPageText(id: string, text: string): Promise<PageRecord>`
  - `pageEndedAt(page: PageRecord): number` — the page's last activity, used by Task 5 and by `recover()`

- [ ] **Step 1: Write the failing tests**

Add to `src/storage/pages.test.ts`:

```ts
describe('typed pages', () => {
  it('creates a typed page with no strokes and no transcript', async () => {
    const page = await createTypedPage({ noteId: 'note-1', pageIndex: 2 });
    expect(page.source).toBe('typed');
    expect(page.strokes).toEqual([]);
    expect(page.pointCount).toBe(0);
    expect(page.devicePageNum).toBeNull();
    expect(page.text).toBe('');
    expect(page.transcript).toBeNull();
    expect(page.finalizedAt).toBeNull();
    expect(isTypedPage(page)).toBe(true);
  });

  it('writing text mirrors it into the transcript as already done', async () => {
    const page = await createTypedPage({ noteId: 'note-1', pageIndex: 0 });
    const updated = await setPageText(page.id, '  Leviathan ch. 13  ');
    expect(updated.text).toBe('  Leviathan ch. 13  ');
    expect(updated.transcript).toMatchObject({
      markdown: 'Leviathan ch. 13',
      model: TYPED_MODEL,
      promptVersion: TYPED_PROMPT_VERSION,
      status: 'done',
      error: null,
    });
  });

  it('leaves a blank typed page without a transcript', async () => {
    const page = await createTypedPage({ noteId: 'note-1', pageIndex: 0 });
    await setPageText(page.id, 'something');
    const cleared = await setPageText(page.id, '   \n  ');
    expect(cleared.text).toBe('   \n  ');
    expect(cleared.transcript).toBeNull();
  });

  it('refuses to write text onto an ink page', async () => {
    const ink = await createPage({
      noteId: 'note-1', pageIndex: 0, devicePageNum: null, source: 'live', strokes: [],
    });
    await expect(setPageText(ink.id, 'typed')).rejects.toThrow(/typed/i);
  });
});

describe('pageEndedAt', () => {
  it('uses the latest stroke end when there is one', () => {
    const page = {
      capturedAt: 1_000,
      strokes: [{ points: [], endedAt: 5_000 }, { points: [], endedAt: 9_000 }],
    } as PageRecord;
    expect(pageEndedAt(page)).toBe(9_000);
  });

  it('falls back to capturedAt for a page with no timestamped strokes', () => {
    const page = { capturedAt: 1_000, strokes: [{ points: [] }] } as PageRecord;
    expect(pageEndedAt(page)).toBe(1_000);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/storage/pages.test.ts`
Expected: FAIL — `createTypedPage is not a function`.

- [ ] **Step 3: Implement typed pages**

In `src/storage/pages.ts`:

```ts
/** K33: a typed page's "transcription" is the typing itself. */
export const TYPED_MODEL = 'typed';
export const TYPED_PROMPT_VERSION = 'typed/1';

export function isTypedPage(page: PageRecord): boolean {
  return page.source === 'typed';
}

export interface CreateTypedPageInput {
  noteId: string;
  pageIndex: number;
  /** Defaults to empty - the editor opens blank and autosaves. */
  text?: string;
  capturedAt?: number;
}

/**
 * A typed page (K32): no strokes, no device page number, and its text mirrored
 * into `transcript` by `setPageText` so every existing consumer of page text -
 * search, gap analysis - reads the one field it already knows about (K33).
 */
export async function createTypedPage(input: CreateTypedPageInput): Promise<PageRecord> {
  const page = await createPage({
    noteId: input.noteId,
    pageIndex: input.pageIndex,
    devicePageNum: null,
    source: 'typed',
    strokes: [],
    capturedAt: input.capturedAt,
  });
  return setPageText(page.id, input.text ?? '');
}

/**
 * Writes a typed page's text and mirrors it into the transcript.
 *
 * Blank text leaves `transcript: null` rather than writing a `'done'`
 * transcript with empty markdown: a contentless "finished" transcript would
 * reach smart search as a real document and gap analysis as a page worth
 * comparing, when A22 already says a contentless page is skipped.
 */
export async function setPageText(id: string, text: string): Promise<PageRecord> {
  const db = await openNotesDb();
  const tx = db.transaction('pages', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page not found: ${id}`);
  }
  if (!isTypedPage(existing)) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`Page ${id} is not a typed page`);
  }

  const markdown = text.trim();
  const transcript: TranscriptRecord | null =
    markdown === ''
      ? null
      : {
          markdown,
          model: TYPED_MODEL,
          promptVersion: TYPED_PROMPT_VERSION,
          status: 'done',
          error: null,
          updatedAt: Date.now(),
        };

  const merged: PageRecord = { ...existing, text, transcript };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

/**
 * When a page last received writing: the latest stroke end, falling back to
 * `capturedAt` for a page whose strokes carry no timestamps (ROM, legacy, or a
 * typed page). Shared by startup recovery and by `resumeNote`, both of which
 * must finalize an interrupted page at the time the writing stopped rather than
 * at the time the app noticed - a `finalizedAt` of "now", days later, would
 * stretch that page's gap-analysis speech window across the whole gap.
 */
export function pageEndedAt(page: PageRecord): number {
  let latest = 0;
  for (const stroke of page.strokes) {
    if (stroke.endedAt !== undefined && stroke.endedAt > latest) latest = stroke.endedAt;
  }
  return latest > 0 ? latest : page.capturedAt;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/storage/pages.test.ts`
Expected: PASS

- [ ] **Step 5: Point `recover()` at the shared helper**

In `src/capture/engine.ts`'s `recover()`, replace the inline stroke/capturedAt scan with `pageEndedAt`:

```ts
          const pages = await listPages(note.id);
          let endedAt = 0;
          for (const page of pages) {
            const at = pageEndedAt(page);
            if (at > endedAt) endedAt = at;
          }
```

Import `pageEndedAt` alongside the other `@/storage/pages` imports. The existing recovery tests must stay green — this is a refactor with no behaviour change.

- [ ] **Step 6: Run the engine tests**

Run: `npx vitest run src/capture/engine.test.ts`
Expected: PASS, unchanged count.

- [ ] **Step 7: Mutation-check**

Change `setPageText`'s blank branch to always build a transcript. Confirm `leaves a blank typed page without a transcript` goes red. Revert. Then make `pageEndedAt` always return `page.capturedAt` and confirm its first test goes red. Revert.

- [ ] **Step 8: Full verification and commit**

Run: `npm test && npx tsc -b && npm run lint`

```bash
git add src/storage/pages.ts src/storage/pages.test.ts src/capture/engine.ts
git commit -m "feat(storage): typed pages, and share the page-ended-at rule with recovery"
```

---

### Task 4: Recording chunks repository

**Files:**
- Create: `src/storage/recordingChunks.ts`, `src/storage/recordingChunks.test.ts`
- Modify: `src/storage/recordings.ts` (add `listUnfinishedRecordings`; `deleteRecording` drops chunks)
- Test: `src/storage/recordings.test.ts`

**Interfaces:**
- Consumes: Task 1's `recordingChunks` store and `RecordingChunkRecord`.
- Produces:
  - `appendRecordingChunk(recordingId: string, seq: number, blob: Blob): Promise<void>`
  - `listRecordingChunks(recordingId: string): Promise<RecordingChunkRecord[]>` — `seq`-ordered
  - `stitchRecordingChunks(recordingId: string): Promise<Blob | null>` — `null` when there are none
  - `deleteRecordingChunks(recordingId: string): Promise<void>`
  - `listUnfinishedRecordings(): Promise<RecordingRecord[]>` — those with `endedAt === null`, newest first

- [ ] **Step 1: Write the failing chunk tests**

Create `src/storage/recordingChunks.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import {
  appendRecordingChunk,
  deleteRecordingChunks,
  listRecordingChunks,
  stitchRecordingChunks,
} from '@/storage/recordingChunks';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

const TYPE = 'audio/webm;codecs=opus';

function chunk(text: string): Blob {
  return new Blob([text], { type: TYPE });
}

describe('recording chunks', () => {
  it('appends and lists in seq order', async () => {
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-1', 1, chunk('b'));
    const chunks = await listRecordingChunks('rec-1');
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks[0].type).toBe(TYPE);
  });

  it('keeps recordings apart', async () => {
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-2', 0, chunk('z'));
    expect(await listRecordingChunks('rec-1')).toHaveLength(1);
    expect(await listRecordingChunks('rec-2')).toHaveLength(1);
  });

  it('stitches in seq order regardless of write order', async () => {
    await appendRecordingChunk('rec-1', 2, chunk('c'));
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-1', 1, chunk('b'));
    const blob = await stitchRecordingChunks('rec-1');
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('abc');
    expect(blob!.type).toBe(TYPE);
  });

  it('stitches across a hole left by a failed write', async () => {
    // A dropped chunk is a hole that cannot be filled. Refusing to stitch
    // would turn one lost second into a lost lecture.
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-1', 2, chunk('c'));
    const blob = await stitchRecordingChunks('rec-1');
    expect(await blob!.text()).toBe('ac');
  });

  it('stitches nothing to null', async () => {
    expect(await stitchRecordingChunks('rec-nope')).toBeNull();
  });

  it('deletes one recording\'s chunks and leaves the others', async () => {
    await appendRecordingChunk('rec-1', 0, chunk('a'));
    await appendRecordingChunk('rec-2', 0, chunk('z'));
    await deleteRecordingChunks('rec-1');
    expect(await listRecordingChunks('rec-1')).toEqual([]);
    expect(await listRecordingChunks('rec-2')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/storage/recordingChunks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chunk repository**

Create `src/storage/recordingChunks.ts`:

```ts
import { openNotesDb } from '@/storage/db';
import type { RecordingChunkRecord } from '@/storage/types';

/**
 * The `recordingChunks` store (K4-K6): one `MediaRecorder` chunk per row,
 * written as it arrives so an interruption costs at most one timeslice of
 * audio. Chunks are transient - `stop()` stitches them into `recordingAudio`
 * and deletes them - so a row surviving a reload means a recording that was
 * interrupted, which is exactly what startup recovery looks for.
 *
 * The id is `<recordingId>:<seq>` rather than a random one: a retried write of
 * the same chunk then overwrites itself instead of duplicating a second of
 * audio into the stitched file.
 */
function chunkId(recordingId: string, seq: number): string {
  return `${recordingId}:${seq}`;
}

export async function appendRecordingChunk(
  recordingId: string,
  seq: number,
  blob: Blob,
): Promise<void> {
  const data = await blob.arrayBuffer();
  const record: RecordingChunkRecord = {
    id: chunkId(recordingId, seq),
    recordingId,
    seq,
    data,
    type: blob.type,
  };
  const db = await openNotesDb();
  await db.put('recordingChunks', record);
}

/** `seq`-ordered, which is stitch order. The index is on `recordingId` only. */
export async function listRecordingChunks(
  recordingId: string,
): Promise<RecordingChunkRecord[]> {
  const db = await openNotesDb();
  const chunks = await db.getAllFromIndex(
    'recordingChunks',
    'by-recording',
    IDBKeyRange.only(recordingId),
  );
  return chunks.sort((a, b) => a.seq - b.seq);
}

/**
 * Concatenates a recording's chunks in `seq` order, or `null` when it has none.
 *
 * A hole in the sequence (a write that failed) is concatenated across rather
 * than treated as an error: the missing second is unrecoverable either way, and
 * refusing to stitch would discard every second that did land.
 */
export async function stitchRecordingChunks(recordingId: string): Promise<Blob | null> {
  const chunks = await listRecordingChunks(recordingId);
  if (chunks.length === 0) return null;
  return new Blob(
    chunks.map((c) => c.data),
    { type: chunks[0].type },
  );
}

export async function deleteRecordingChunks(recordingId: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction('recordingChunks', 'readwrite');
  const keys = await tx.store.index('by-recording').getAllKeys(IDBKeyRange.only(recordingId));
  for (const key of keys) await tx.store.delete(key);
  await tx.done;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/storage/recordingChunks.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the recordings changes**

Add to `src/storage/recordings.test.ts`:

```ts
describe('unfinished recordings', () => {
  it('lists only those with no endedAt, newest first', async () => {
    const open = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Open', startedAt: 2_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    const closed = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Closed', startedAt: 1_000, durationMs: 500 },
      new Blob(['y'], { type: 'audio/webm' }),
    );
    await updateRecording(closed.id, { endedAt: 1_500 });

    const unfinished = await listUnfinishedRecordings();
    expect(unfinished.map((r) => r.id)).toEqual([open.id]);
  });

  it('deleting a recording drops its chunks too', async () => {
    const rec = await createRecording(
      { sessionId: 's1', noteId: 'n1', title: 'Open', startedAt: 1_000, durationMs: 0, endedAt: null },
      new Blob([], { type: 'audio/webm' }),
    );
    await appendRecordingChunk(rec.id, 0, new Blob(['a'], { type: 'audio/webm' }));
    await deleteRecording(rec.id);
    expect(await listRecordingChunks(rec.id)).toEqual([]);
  });
});
```

`CreateRecordingInput` already carries `endedAt?: number | null` defaulting to `null`, so K5's "created at start" recording needs no new field: it is `createRecording({ ..., durationMs: 0 }, new Blob([]))`. That writes an empty `recordingAudio` row which `stop()` later overwrites — deliberate, because it keeps `createRecording`'s invariant that a recording never exists without its audio row.

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/storage/recordings.test.ts`
Expected: FAIL — `listUnfinishedRecordings is not a function`.

- [ ] **Step 7: Implement the recordings changes**

In `src/storage/recordings.ts`: add the lister, and extend the deleter. No change to `CreateRecordingInput` is needed (see Step 5).

```ts
/**
 * K5: a recording created at start, before any chunk exists, so recovery can
 * find it by `endedAt === null` and knows its link, title and start time.
 * Newest first, matching `listRecordings`.
 */
export async function listUnfinishedRecordings(): Promise<RecordingRecord[]> {
  const all = await listRecordings();
  return all.filter((recording) => recording.endedAt === null);
}
```

and extend `deleteRecording` to cover the chunk store **in its existing single transaction**, rather than calling `deleteRecordingChunks` after it — two transactions could leave the chunks behind if the second failed, and `deleteRecording`'s whole point is that a recording is never half-deleted:

```ts
/** Deletes the record, its bytes and any chunks left over, in one transaction. */
export async function deleteRecording(id: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(['recordings', 'recordingAudio', 'recordingChunks'], 'readwrite');
  await tx.objectStore('recordings').delete(id);
  await tx.objectStore('recordingAudio').delete(id);
  // A recording deleted while still open would otherwise leave its chunks
  // behind forever: nothing else scans for orphans.
  const chunkStore = tx.objectStore('recordingChunks');
  const keys = await chunkStore.index('by-recording').getAllKeys(IDBKeyRange.only(id));
  for (const key of keys) await chunkStore.delete(key);
  await tx.done;
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run src/storage/recordings.test.ts src/storage/recordingChunks.test.ts`
Expected: PASS

- [ ] **Step 9: Mutation-check**

Remove the `.sort((a, b) => a.seq - b.seq)` from `listRecordingChunks` and confirm `stitches in seq order regardless of write order` goes red. Revert. Remove the `deleteRecordingChunks` call from `deleteRecording` and confirm the orphan test goes red. Revert.

- [ ] **Step 10: Full verification and commit**

Run: `npm test && npx tsc -b && npm run lint`

```bash
git add src/storage/recordingChunks.ts src/storage/recordingChunks.test.ts src/storage/recordings.ts src/storage/recordings.test.ts
git commit -m "feat(storage): recording chunk store, stitching and unfinished-recording lookup"
```

---

### Task 5: `engine.resumeNote()`

**Files:**
- Modify: `src/capture/types.ts` (the `CaptureEngine` interface)
- Modify: `src/capture/engine.ts`
- Test: `src/capture/engine.test.ts`

**Interfaces:**
- Consumes: Task 3's `pageEndedAt`; the existing `createSession`/`updateSession`/`getSession`, `getNote`/`updateNote`, `listPages`/`createPage`/`finalizePage`/`isPageFinalized`.
- Produces: `resumeNote(noteId: string): Promise<{ sessionId: string; noteId: string }>` on `CaptureEngine`.

- [ ] **Step 1: Declare it on the interface**

In `src/capture/types.ts`, after `endSession`:

```ts
  /**
   * Reopens an existing note and appends a new page after its last one (K10,
   * K11). One mechanism serves both restarting an interrupted session and
   * returning to a finished note. Ends any other open note first. Appending
   * only: no existing page is modified and none is re-finalized.
   */
  resumeNote(noteId: string): Promise<{ sessionId: string; noteId: string }>;
```

- [ ] **Step 2: Write the failing tests**

Add to `src/capture/engine.test.ts`, following the existing harness there for building an engine over a fake controller.

```ts
describe('resumeNote', () => {
  it('reopens the note and its session and appends a page after the last', async () => {
    const { engine } = makeEngine();
    const noteId = await engine.startNote({ title: 'Lecture 1' });
    await engine.newPage('manual');
    await engine.endNote();
    await engine.flush();

    const before = await getNote(noteId);
    expect(before?.status).toBe('complete');

    const ids = await engine.resumeNote(noteId);
    await engine.flush();

    expect(ids.noteId).toBe(noteId);
    const after = await getNote(noteId);
    expect(after?.status).toBe('active');
    expect(after?.endedAt).toBeNull();
    expect(after?.startedAt).toBe(before?.startedAt);
    expect((await getSession(ids.sessionId))?.status).toBe('active');

    const pages = await listPages(noteId);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(engine.getState().activePageId).toBe(pages[2].id);
    expect(engine.getState().pageIndex).toBe(2);
  });

  it('never modifies or re-finalizes an existing page', async () => {
    const { engine } = makeEngine();
    const noteId = await engine.startNote();
    await engine.endNote();
    await engine.flush();
    const [first] = await listPages(noteId);

    await engine.resumeNote(noteId);
    await engine.flush();

    const [againFirst] = await listPages(noteId);
    expect(againFirst).toEqual(first);
  });

  it('publishes a fresh sessionStartedAt so the clock measures this sitting', async () => {
    const clock = { t: 1_000 };
    const { engine } = makeEngine({ now: () => clock.t });
    const noteId = await engine.startNote();
    await engine.endNote();
    await engine.flush();

    clock.t = 90_000_000;
    await engine.resumeNote(noteId);
    await engine.flush();

    expect(sessionStartedAtOf(engine.getState())).toBe(90_000_000);
  });

  it('creates and links a session for a note that has none', async () => {
    const { engine } = makeEngine();
    const orphan = await createNote({ title: 'Imported', deviceId: 'legacy', pageBaseline: 0, status: 'complete', sessionId: null });

    const ids = await engine.resumeNote(orphan.id);
    await engine.flush();

    expect(ids.sessionId).toBeTruthy();
    expect((await getNote(orphan.id))?.sessionId).toBe(ids.sessionId);
    expect((await getSession(ids.sessionId))?.status).toBe('active');
  });

  it('creates a session when the note names one that no longer exists', async () => {
    const { engine } = makeEngine();
    const dangling = await createNote({ title: 'Dangling', deviceId: 'huion', pageBaseline: 0, status: 'complete', sessionId: 'ses-gone' });

    const ids = await engine.resumeNote(dangling.id);
    await engine.flush();

    expect(ids.sessionId).not.toBe('ses-gone');
    expect((await getSession(ids.sessionId))?.status).toBe('active');
  });

  it('opens page 0 for a note with no pages', async () => {
    const { engine } = makeEngine();
    const bare = await createNote({ title: 'Bare', deviceId: 'huion', pageBaseline: 0, status: 'complete' });

    await engine.resumeNote(bare.id);
    await engine.flush();

    expect(engine.getState().pageIndex).toBe(0);
    expect((await listPages(bare.id)).map((p) => p.pageIndex)).toEqual([0]);
  });

  it('is a no-op for the note that is already open', async () => {
    const { engine } = makeEngine();
    const noteId = await engine.startNote();
    await engine.flush();
    const openPageId = engine.getState().activePageId;

    const ids = await engine.resumeNote(noteId);
    await engine.flush();

    expect(ids.noteId).toBe(noteId);
    // No new page, and the live page is still the live page: reopening would
    // finalize it and drop the stroke in progress.
    expect(engine.getState().activePageId).toBe(openPageId);
    expect(await listPages(noteId)).toHaveLength(1);
  });

  it('ends a different open note before reopening', async () => {
    const { engine } = makeEngine();
    const first = await engine.startNote({ title: 'First' });
    await engine.endNote();
    await engine.flush();
    const second = await engine.startNote({ title: 'Second' });
    await engine.flush();

    await engine.resumeNote(first);
    await engine.flush();

    expect((await getNote(second))?.status).toBe('complete');
    expect((await getNote(first))?.status).toBe('active');
  });

  it('finalizes a page left open, at the time the writing stopped', async () => {
    const { engine } = makeEngine();
    const note = await createNote({ title: 'Interrupted', deviceId: 'huion', pageBaseline: 0, status: 'interrupted' });
    const open = await createPage({
      noteId: note.id, pageIndex: 0, devicePageNum: null, source: 'live',
      strokes: [{ points: [], endedAt: 7_000 }], capturedAt: 1_000,
    });

    await engine.resumeNote(note.id);
    await engine.flush();

    expect((await getPage(open.id))?.finalizedAt).toBe(7_000);
  });

  it('rejects an unknown note and leaves nothing open', async () => {
    const { engine } = makeEngine();
    await expect(engine.resumeNote('no-such-note')).rejects.toThrow(/not found/i);
    await engine.flush();
    expect(engine.getState().activeNoteId).toBeNull();
  });
});
```

Adapt `makeEngine()` to whatever the existing file calls its harness, and import `createNote`, `getNote`, `getSession`, `getPage`, `createPage`, `listPages` and `sessionStartedAtOf` as that file already does for its other tests.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/capture/engine.test.ts`
Expected: FAIL — `engine.resumeNote is not a function`.

- [ ] **Step 4: Implement `resumeNote`**

In `src/capture/engine.ts`. Add `getNote` to the `@/storage/notes` import, `getSession` to `@/storage/sessions`, and `pageEndedAt` to `@/storage/pages`.

```ts
  /**
   * Reopens an existing note (K10, K11). Appending only: the note's existing
   * pages are never rewritten, and the note keeps its original `startedAt` -
   * only `status`/`endedAt` move.
   *
   * It is deliberately not a call into `openNote`: that function's whole job is
   * creating a Session, Note and page 0, and the two share only the flag
   * discipline around `noteOpen`/`openerSeq`, which is reproduced here for the
   * same reason - a `newPage` or `endNote` arriving while these async reads run
   * must queue behind them rather than see no active note and drop the turn.
   */
  function resumeNote(noteId: string): Promise<{ sessionId: string; noteId: string }> {
    void start();

    // Already the open note. Falling through would close and reopen it,
    // finalizing the live page and discarding the stroke in progress - a
    // double-click on Resume must not cost the sentence being written.
    if (noteOpen && state.activeNoteId === noteId && state.activeSessionId !== null) {
      return Promise.resolve({ sessionId: state.activeSessionId, noteId });
    }

    if (noteOpen) void closeNote();
    noteOpen = true;
    const opener = ++openerSeq;
    const b = buffer;

    return enqueue(async () => {
      let createdSessionId: string | null = null;
      const finalized: string[] = [];
      try {
        const at = now();
        const note = await getNote(noteId);
        if (!note) throw new Error(`Note not found: ${noteId}`);

        // A legacy or imported note has no session, and a note can name a
        // session row that has since been deleted. Either way every note is
        // resumable (K14), so a missing session is created rather than fatal.
        let sessionId = note.sessionId ?? null;
        if (sessionId !== null && !(await getSession(sessionId))) sessionId = null;
        if (sessionId === null) {
          const session = await createSession({
            title: note.title,
            startedAt: note.startedAt,
          });
          createdSessionId = session.id;
          sessionId = session.id;
        } else {
          await updateSession(sessionId, { status: 'active', endedAt: null });
        }

        const pages = await listPages(noteId);
        // A page left open by an interruption is closed before appending, so
        // the note never holds two unfinalized pages. Finalized at the time the
        // writing stopped, not now: see `pageEndedAt`.
        for (const page of pages) {
          if (isPageFinalized(page)) continue;
          await finalizePage(page.id, pageEndedAt(page));
          finalized.push(page.id);
        }

        // `pages` is `pageIndex`-sorted by `listPages`, but max-of-last is read
        // from the sort rather than assumed: an empty note starts at 0.
        const pageIndex = pages.length > 0 ? pages[pages.length - 1].pageIndex + 1 : 0;

        await updateNote(noteId, {
          status: 'active',
          endedAt: null,
          ...(note.sessionId === sessionId ? {} : { sessionId }),
        });

        // Whatever the pen wrote during these reads belongs to the new page.
        const buffered = [...b.strokes];
        const page = await createPage({
          noteId,
          pageIndex,
          devicePageNum: devicePageNum(),
          source: 'live',
          strokes: buffered,
          capturedAt: at,
        });

        b.pageId = page.id;
        if (b.strokes.length === buffered.length) b.dirty = false;
        setState({
          activeSessionId: sessionId,
          activeNoteId: noteId,
          activePageId: page.id,
          pageIndex,
          // K13: the header clock measures this sitting. A note resumed three
          // days later must not show a 72-hour timer.
          sessionStartedAt: at,
        });
        void flushBuffer(b);
        for (const pageId of finalized) emitPageFinalized(pageId);
        return { sessionId, noteId };
      } catch (error) {
        if (openerSeq === opener) noteOpen = false;
        if (createdSessionId !== null) {
          try {
            await updateSession(createdSessionId, { status: 'ended', endedAt: now() });
          } catch (cleanupError) {
            console.error('[capture] ending a half-created session failed', cleanupError);
          }
        }
        throw error;
      }
    });
  }
```

Add `resumeNote` to the returned object, beside `startSession`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/capture/engine.test.ts`
Expected: PASS

- [ ] **Step 6: Mutation-check the three Review Focus cases**

For each, break it, confirm the named test goes red, revert:
- Remove the already-open early return → `is a no-op for the note that is already open` red.
- Change the missing-session branch to `throw` → `creates and links a session for a note that has none` red.
- Change `pageIndex` to `pages[pages.length - 1].pageIndex + 1` unconditionally → `opens page 0 for a note with no pages` red.
- Change `finalizePage(page.id, pageEndedAt(page))` to `finalizePage(page.id, now())` → `finalizes a page left open, at the time the writing stopped` red.

- [ ] **Step 7: Check the fake engine implementations**

`resumeNote` is now on the `CaptureEngine` interface, so any test double implementing it must grow the method. Run `npx tsc -b` and add `resumeNote` to each one it names (likely `src/capture/pageTurnTestEngine.ts`), implemented as a rejecting stub with a comment saying resume is not exercised through that double.

- [ ] **Step 8: Full verification and commit**

Run: `npm test && npx tsc -b && npm run lint`

```bash
git add src/capture/types.ts src/capture/engine.ts src/capture/engine.test.ts src/capture/pageTurnTestEngine.ts
git commit -m "feat(capture): resumeNote appends to an existing note and reopens its session"
```

---

### Task 6: Notes-view mount points

**Files:**
- Create: `src/notes/NoteList.tsx`, `src/notes/NoteList.test.tsx`, `src/notes/NoteToolbar.tsx`, `src/notes/NoteToolbar.test.tsx`
- Modify: `src/notes/NotesView.tsx:140-205` (the sidebar and toolbar JSX)
- Test: `src/notes/NotesView.test.tsx` (existing assertions must stay green)

**Interfaces:**
- Consumes: `sessionStartedAtOf` from `@/capture/engine`.
- Produces: `NoteList` with slots `filter: ReactNode` and `rowActions: (note) => ReactNode`; `NoteToolbar` with slots `title`, `meta`, `actions`, `banner`, and a `sessionLocked: boolean` prop that disables New note.

**Why this task exists:** five Wave 2 units need to add things to this view — Resume buttons per row (S1), a tag filter bar and a tag editor (S5), an editable title (S1), a "Type page" button (S4), a "writing still goes to X" banner (S1). Without named slots they would all edit the same JSX and conflict on merge. This is the same mount-point discipline `architecture.md` §6.7 records for Phase 2.

- [ ] **Step 1: Write the failing `NoteList` tests**

Create `src/notes/NoteList.test.tsx`. The harness is this project's idiom — `createRoot` + `act`, no testing-library. `NoteList` is presentational and reads no storage, so it needs neither `resetDatabase` nor a settle loop.

```tsx
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteList } from '@/notes/NoteList';
import type { NoteRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function note(overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'n1',
    title: 'Lecture 1',
    status: 'complete',
    deviceId: 'huion',
    deviceType: 'huion',
    deviceName: null,
    startedAt: 1_000,
    endedAt: 2_000,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
    sessionId: 's1',
    ...overrides,
  };
}

async function render(ui: ReactElement): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent?.trim()),
      )}`,
    );
  }
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('NoteList', () => {
  it('renders each note and reports selection', async () => {
    const onSelect = vi.fn();
    await render(
      <NoteList
        notes={[note({ id: 'a', title: 'Alpha' }), note({ id: 'b', title: 'Beta' })]}
        selectedNoteId="a"
        activeNoteId={null}
        onSelect={onSelect}
      />,
    );

    await click(buttonByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('marks the selected note for assistive tech', async () => {
    await render(
      <NoteList
        notes={[note({ id: 'a', title: 'Alpha' })]}
        selectedNoteId="a"
        activeNoteId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(buttonByText('Alpha').getAttribute('aria-current')).toBe('true');
  });

  it('renders the filter slot above the list', async () => {
    await render(
      <NoteList
        notes={[]}
        selectedNoteId={null}
        activeNoteId={null}
        onSelect={vi.fn()}
        filter={<div data-testid="filter-slot">filter</div>}
      />,
    );

    expect(container.querySelector('[data-testid="filter-slot"]')).not.toBeNull();
  });

  it('renders row actions per note', async () => {
    await render(
      <NoteList
        notes={[note({ id: 'a', title: 'Alpha' })]}
        selectedNoteId={null}
        activeNoteId={null}
        onSelect={vi.fn()}
        rowActions={(n) => <button type="button">Resume {n.title}</button>}
      />,
    );

    expect(buttonByText('Resume Alpha')).toBeTruthy();
  });

  it('badges the active, legacy and interrupted states', async () => {
    await render(
      <NoteList
        notes={[
          note({ id: 'a', title: 'Active' }),
          note({ id: 'b', title: 'Old', legacy: true }),
          note({ id: 'c', title: 'Broken', status: 'interrupted' }),
        ]}
        selectedNoteId={null}
        activeNoteId="a"
        onSelect={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('Recording');
    expect(container.textContent).toContain('Legacy');
    expect(container.textContent).toContain('Interrupted');
  });

  it('shows the empty state when there are no notes', async () => {
    await render(
      <NoteList notes={[]} selectedNoteId={null} activeNoteId={null} onSelect={vi.fn()} />,
    );

    expect(container.textContent).toContain('write on the pad to start one');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/notes/NoteList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract `NoteList`**

Create `src/notes/NoteList.tsx`, moving `Badge` and `NoteListItem` out of `NotesView.tsx` unchanged and wrapping them:

```tsx
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { NoteRecord } from '@/storage/types';

export interface NoteListProps {
  notes: readonly NoteRecord[];
  selectedNoteId: string | null;
  activeNoteId: string | null;
  onSelect: (id: string) => void;
  /**
   * Rendered above the list. **Wave 2 mount point**: S5's tag filter bar goes
   * here, so adding it does not mean editing this component.
   */
  filter?: ReactNode;
  /**
   * Trailing controls for one row. **Wave 2 mount point**: S1's Resume button
   * goes here.
   */
  rowActions?: (note: NoteRecord) => ReactNode;
}
```

Keep the existing markup, classes and the `aria-current` / title-only-button structure exactly — `NotesView.test.tsx` asserts against them. The `<h2>Notes</h2>` heading stays, with `filter` rendered directly after it and `rowActions?.(note)` rendered inside each `<li>` after the metadata row.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/notes/NoteList.test.tsx`
Expected: PASS

- [ ] **Step 5: Write the failing `NoteToolbar` tests**

Create `src/notes/NoteToolbar.test.tsx`.

⚑ **`NoteToolbar` mounts `PageTurnControls`**, which calls `useCaptureEngine()` and `useCaptureState()`. The tests must therefore wrap it in a `CaptureProvider` over a real engine built on a fake device controller — the same construction `NotesView.test.tsx` uses. Without the provider every test fails on a context error before asserting anything.

```tsx
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import type { LiveCaptureEngine } from '@/capture/engine';
import { NoteToolbar } from '@/notes/NoteToolbar';
import type { NoteToolbarProps } from '@/notes/NoteToolbar';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let engine: LiveCaptureEngine;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // The engine runs its startup recovery against storage on first subscribe.
  await resetDatabase();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  engine = createCaptureEngine({ controller: createFakeDeviceController() });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engine.dispose();
});

const base: NoteToolbarProps = {
  noteTitle: 'Lecture 1',
  sessionLocked: false,
  hasActiveNote: true,
  onNewNote: vi.fn(),
  onEndNote: vi.fn(),
  pageCount: 2,
  viewedIndex: 0,
  onGoToPage: vi.fn(),
};

async function render(props: Partial<NoteToolbarProps> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CaptureProvider engine={engine}>
        <NoteToolbar {...base} {...props} />
      </CaptureProvider>,
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) {
    throw new Error(
      `no button with text ${JSON.stringify(text)}; have ${JSON.stringify(
        buttons().map((b) => b.textContent?.trim()),
      )}`,
    );
  }
  return found;
}

describe('NoteToolbar', () => {
  it('shows the note title when no title slot is given', async () => {
    await render();
    expect(container.textContent).toContain('Lecture 1');
  });

  it('a title slot replaces the plain title', async () => {
    await render({ title: <input aria-label="Note title" defaultValue="x" /> });
    expect(container.querySelector('input[aria-label="Note title"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Lecture 1');
  });

  it('renders the meta, actions and banner slots', async () => {
    await render({
      meta: <span data-testid="meta-slot" />,
      actions: <span data-testid="actions-slot" />,
      banner: <span data-testid="banner-slot" />,
    });
    expect(container.querySelector('[data-testid="meta-slot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="actions-slot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="banner-slot"]')).not.toBeNull();
  });

  it('disables New note while a session is locked', async () => {
    await render({ sessionLocked: true });
    expect(buttonByText('New note').disabled).toBe(true);
  });

  it('leaves New note enabled when no session is running', async () => {
    await render({ sessionLocked: false });
    expect(buttonByText('New note').disabled).toBe(false);
  });

  it('keeps End note enabled while locked, so ending is always reachable', async () => {
    await render({ sessionLocked: true, hasActiveNote: true });
    expect(buttonByText('End note').disabled).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/notes/NoteToolbar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Extract `NoteToolbar`**

Create `src/notes/NoteToolbar.tsx` holding the toolbar row from `NotesView.tsx:164-207` — title, New note, End note, page navigation, `PageTurnControls` — with these props:

```tsx
export interface NoteToolbarProps {
  /** Shown when `title` is not given. */
  noteTitle: string | null;
  /** **Wave 2 mount point**: S1's inline title editor. Replaces the plain title. */
  title?: ReactNode;
  /** **Wave 2 mount point**: S5's tag editor. Rendered under the title. */
  meta?: ReactNode;
  /** **Wave 2 mount point**: S4's "Type page" button. Rendered before page navigation. */
  actions?: ReactNode;
  /** **Wave 2 mount point**: S1's "writing still goes to X" notice. A full-width row below the toolbar. */
  banner?: ReactNode;
  /**
   * K15: a session locks you into its note, so New note is disabled. End note
   * deliberately stays enabled - ending must never be reachable only by reload.
   */
  sessionLocked: boolean;
  hasActiveNote: boolean;
  onNewNote: () => void;
  onEndNote: () => void;
  pageCount: number;
  viewedIndex: number;
  onGoToPage: (index: number) => void;
}
```

`PageTurnControls` stays mounted inside this component — `architecture.md` §4 names the notes toolbar as its only mount point, and moving it would break that.

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run src/notes/NoteToolbar.test.tsx`
Expected: PASS

- [ ] **Step 9: Rewire `NotesView`**

Replace the sidebar and toolbar JSX with the two components. `sessionLocked` comes from the engine:

```tsx
  const sessionLocked = sessionStartedAtOf(state) !== null;
```

Import `sessionStartedAtOf` from `@/capture/engine`. Everything else in `NotesView` — selection resolution, page following, the canvas, `TranscriptPanel`, `GapPanel` — is untouched.

- [ ] **Step 10: Run the whole notes suite**

Run: `npx vitest run src/notes src/capture src/app`
Expected: PASS with no change to the existing assertion count — this step is a pure refactor plus the New-note lock.

- [ ] **Step 11: Mutation-check**

Change `sessionLocked` to a hard-coded `false` and confirm `disables New note while a session is locked` goes red. Revert. Remove the `filter` slot render and confirm its test goes red. Revert.

- [ ] **Step 12: Full verification and commit**

Run: `npm test && npx tsc -b && npm run lint && npm run build`

```bash
git add src/notes/NoteList.tsx src/notes/NoteList.test.tsx src/notes/NoteToolbar.tsx src/notes/NoteToolbar.test.tsx src/notes/NotesView.tsx
git commit -m "refactor(notes): extract NoteList and NoteToolbar with Wave 2 mount points"
```

---

### Task 7: Record the foundations contract

**Files:**
- Modify: `docs/architecture.md` (new §8)

- [ ] **Step 1: Write §8**

Add a Phase 3 section recording, for the Wave 2 orchestrators: schema v4's fields and their absent-readings; which repository function owns each new field; `resumeNote`'s contract; the four `NoteToolbar` slots and two `NoteList` slots with the unit that owns each; and the rule that a Wave 2 unit adds to a slot rather than editing `NotesView`.

Include the ownership table:

| Mount point | Owner |
|---|---|
| `NoteList.filter` | S5 tags |
| `NoteList.rowActions` | S1 sessions (Resume) |
| `NoteToolbar.title` | S1 sessions (inline title) |
| `NoteToolbar.meta` | S5 tags (tag editor) |
| `NoteToolbar.actions` | S4 typed pages ("Type page") |
| `NoteToolbar.banner` | S1 sessions (writing-destination notice) |

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: record the Phase 3 foundations contract and Wave 2 mount points"
```

---

## Done when

- `npm test`, `npx tsc -b`, `npm run lint` and `npm run build` all pass.
- Test count is above the 1083 baseline, and every new test has been mutation-checked.
- `DB_VERSION === 4`, and a v3 database upgrades without losing rows.
- `engine.resumeNote()` satisfies all ten of its tests, including the four Review Focus cases.
- `docs/architecture.md` §8 names every Wave 2 mount point and its owner.
