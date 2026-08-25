# Phase 1A — Storage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish test infrastructure and an IndexedDB-backed storage layer for notes, pages, rendered images, transcripts, and settings, and migrate existing `localStorage` notebooks into it.

**Architecture:** A `src/storage/` module with one file per responsibility: schema/connection, per-store repositories, and a one-shot legacy migration. All persistence goes through `idb`, a thin promise wrapper over IndexedDB. Nothing in this phase touches the existing studio app — it is purely additive.

**Tech Stack:** TypeScript (strict), `idb` for IndexedDB, Vitest + `fake-indexeddb` + `happy-dom` for tests.

**Spec:** `docs/superpowers/specs/2026-08-25-note-capture-app.md`

## Global Constraints

- Node `>=20 <23`.
- TypeScript `strict`, plus `noUnusedLocals` and `noUnusedParameters` — do not leave unused symbols; the build fails on them.
- `verbatimModuleSyntax: true` — all type-only imports **must** use `import type { … }`.
- `erasableSyntaxOnly: true` — **no `enum`, no parameter properties, no namespaces.** Use string-literal union types.
- Path alias `@/*` → `./src/*`.
- The existing app must keep working. Do not modify any file under `src/components/`, `src/hooks/`, or `src/App.tsx` in this phase.
- New runtime dependencies: `idb` only (approved in spec D6). Test dependencies are dev-only.
- Database name `takingnotes`, version `1`.

---

### Task 1: Test infrastructure

There is currently **no** test setup in this repo — no test script, no test dependencies, no test files. This task creates it.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Create: `src/test/setup.test.ts`
- Modify: `package.json` (scripts + devDependencies)
- Modify: `tsconfig.node.json` (include the new config file)

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` command; a `happy-dom` environment with a `fake-indexeddb`-backed global `indexedDB`, available to every later task.

- [ ] **Step 1: Install test dependencies**

```bash
npm install --save-dev vitest@^3 fake-indexeddb@^6 happy-dom@^17
```

- [ ] **Step 2: Write the setup file**

Create `src/test/setup.ts`:

```ts
// Installs a fake `indexedDB` onto globalThis for every test file.
import 'fake-indexeddb/auto';
```

- [ ] **Step 3: Write the Vitest config**

Create `vitest.config.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Add test scripts to `package.json`**

Add these two entries to the `"scripts"` object:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Note: these call `vitest` directly rather than routing through `scripts/run.mjs` like the other commands. `run.mjs` invokes tools by hard-coded path inside `node_modules`, which is fragile for a binary we are adding now; npm resolves the `vitest` bin reliably.

- [ ] **Step 5: Include the new config in type-checking**

In `tsconfig.node.json`, change the `include` array from:

```json
"include": ["vite.config.ts"]
```

to:

```json
"include": ["vite.config.ts", "vitest.config.ts"]
```

- [ ] **Step 6: Write the failing test**

Create `src/test/setup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('provides a DOM global from happy-dom', () => {
    expect(typeof document).toBe('object');
  });

  it('provides an indexedDB global from fake-indexeddb', () => {
    expect(globalThis.indexedDB).toBeDefined();
    expect(typeof globalThis.indexedDB.open).toBe('function');
  });

  it('can open and close a database', async () => {
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open('probe-db', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(opened.name).toBe('probe-db');
    opened.close();
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: 3 tests pass. If `indexedDB` is undefined, `setupFiles` is not being applied — check the path in `vitest.config.ts`.

- [ ] **Step 8: Verify the existing build still type-checks**

Run: `npm run build`
Expected: succeeds. This confirms the `tsconfig.node.json` change did not break the project references.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts src/test package.json package-lock.json tsconfig.node.json
git commit -m "test: add vitest, fake-indexeddb and happy-dom test infrastructure"
```

---

### Task 2: Storage types and database connection

**Files:**
- Create: `src/storage/types.ts`
- Create: `src/storage/db.ts`
- Create: `src/test/resetDb.ts`
- Create: `src/storage/db.test.ts`

**Interfaces:**
- Consumes: test infrastructure from Task 1.
- Produces:
  - Types `NoteStatus`, `PageSource`, `TranscriptStatus`, `TranscriptRecord`, `StrokePoint`, `PageStroke`, `NoteRecord`, `PageRecord`, `SettingRecord`.
  - `openNotesDb(): Promise<IDBPDatabase<NotesDb>>`
  - `resetNotesDbForTests(): Promise<void>` — closes the cached connection
  - `resetDatabase(): Promise<void>` (from `@/test/resetDb`) — the teardown helper **every** later test file uses
  - Constants `DB_NAME`, `DB_VERSION`.

- [ ] **Step 1: Install the runtime dependency**

```bash
npm install idb@^8
```

- [ ] **Step 2: Write the types**

Create `src/storage/types.ts`:

```ts
export type NoteStatus = 'active' | 'interrupted' | 'complete';
export type PageSource = 'rom' | 'live';
export type TranscriptStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StrokePoint {
  /** Normalized 0-1, matching HuionNoteBLE.scaleRawPoint output. */
  x: number;
  y: number;
  pressure: number;
}

export interface PageStroke {
  points: StrokePoint[];
}

export interface TranscriptRecord {
  markdown: string;
  model: string;
  status: TranscriptStatus;
  error: string | null;
  updatedAt: number;
}

export interface NoteRecord {
  id: string;
  title: string;
  status: NoteStatus;
  deviceId: string;
  deviceType: 'huion';
  startedAt: number;
  endedAt: number | null;
  /** Device page count at session start; session pages are baseline..end. */
  pageBaseline: number;
  summary: string | null;
  summaryModel: string | null;
  /** True for notebooks imported from the pre-existing localStorage library. */
  legacy: boolean;
}

export interface PageRecord {
  id: string;
  noteId: string;
  /** Zero-based position within the note. */
  pageIndex: number;
  /** Page number as reported by the device, when known. */
  devicePageNum: number | null;
  source: PageSource;
  strokes: PageStroke[];
  pointCount: number;
  capturedAt: number;
  render: Blob | null;
  renderW: number | null;
  renderH: number | null;
  transcript: TranscriptRecord | null;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}
```

- [ ] **Step 3: Write the shared test teardown helper**

Every storage test needs a clean database. `deleteDatabase` **blocks** while a
connection is still open, so the helper must close the cached connection first —
otherwise tests leak state into each other and fail intermittently. It rejects
on `blocked` rather than resolving, so that bug surfaces loudly instead of
silently corrupting the next test.

Create `src/test/resetDb.ts`:

```ts
import { DB_NAME, resetNotesDbForTests } from '@/storage/db';

/** Closes any open connection and deletes the database so each test starts clean. */
export async function resetDatabase(): Promise<void> {
  await resetNotesDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('deleteDatabase blocked - a connection was left open'));
  });
}
```

- [ ] **Step 4: Write the failing test**

Create `src/storage/db.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { DB_VERSION, openNotesDb } from '@/storage/db';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('openNotesDb', () => {
  it('creates the expected object stores', async () => {
    const db = await openNotesDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(['notes', 'pages', 'settings']);
  });

  it('creates the by-note index on pages', async () => {
    const db = await openNotesDb();
    const index = db.transaction('pages').store.index('by-note');
    expect(index.name).toBe('by-note');
  });

  it('returns the same connection on repeated calls', async () => {
    const first = await openNotesDb();
    const second = await openNotesDb();
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/storage/db.test.ts`
Expected: FAIL — cannot resolve `@/storage/db`. Both the test file and
`src/test/resetDb.ts` import it, so this failure is expected until Step 6.

- [ ] **Step 6: Write the implementation**

Create `src/storage/db.ts`:

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { NoteRecord, PageRecord, SettingRecord } from '@/storage/types';

export const DB_NAME = 'takingnotes';
export const DB_VERSION = 1;

export interface NotesDb extends DBSchema {
  notes: {
    key: string;
    value: NoteRecord;
    indexes: { 'by-started': number };
  };
  pages: {
    key: string;
    value: PageRecord;
    indexes: { 'by-note': string };
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<NotesDb>> | null = null;

export function openNotesDb(): Promise<IDBPDatabase<NotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<NotesDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('notes')) {
          const notes = db.createObjectStore('notes', { keyPath: 'id' });
          notes.createIndex('by-started', 'startedAt');
        }
        if (!db.objectStoreNames.contains('pages')) {
          const pages = db.createObjectStore('pages', { keyPath: 'id' });
          pages.createIndex('by-note', 'noteId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Closes and drops the cached connection so each test starts from a fresh
 * database. Closing matters: `indexedDB.deleteDatabase` blocks indefinitely
 * while any connection to it is still open.
 */
export async function resetNotesDbForTests(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/storage/db.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/storage/types.ts src/storage/db.ts src/test/resetDb.ts src/storage/db.test.ts package.json package-lock.json
git commit -m "feat(storage): add IndexedDB schema and connection"
```

---

### Task 3: Notes repository

**Files:**
- Create: `src/storage/id.ts`
- Create: `src/storage/notes.ts`
- Create: `src/storage/notes.test.ts`

**Interfaces:**
- Consumes: `openNotesDb()`, `NoteRecord`, `NoteStatus` from Task 2.
- Produces:
  - `newId(): string`
  - `createNote(input: CreateNoteInput): Promise<NoteRecord>` where
    `CreateNoteInput = { title: string; deviceId: string; pageBaseline: number }`
  - `getNote(id: string): Promise<NoteRecord | undefined>`
  - `updateNote(id: string, patch: Partial<Omit<NoteRecord, 'id'>>): Promise<NoteRecord>`
  - `listNotes(): Promise<NoteRecord[]>` — newest first
  - `deleteNote(id: string): Promise<void>` — cascades to that note's pages

- [ ] **Step 1: Write the id helper**

Create `src/storage/id.ts`:

```ts
/** Random identifier for stored records. Available in Node 20+ and secure browser contexts. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
```

- [ ] **Step 2: Write the failing test**

Create `src/storage/notes.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { createNote, deleteNote, getNote, listNotes, updateNote } from '@/storage/notes';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('notes repository', () => {
  it('creates a note with sensible defaults', async () => {
    const note = await createNote({ title: 'Standup', deviceId: 'huion:abc', pageBaseline: 3 });

    expect(note.id).toBeTruthy();
    expect(note.title).toBe('Standup');
    expect(note.status).toBe('active');
    expect(note.deviceType).toBe('huion');
    expect(note.pageBaseline).toBe(3);
    expect(note.endedAt).toBeNull();
    expect(note.summary).toBeNull();
    expect(note.legacy).toBe(false);
    expect(note.startedAt).toBeGreaterThan(0);
  });

  it('round-trips a note through the database', async () => {
    const created = await createNote({ title: 'Design', deviceId: 'huion:abc', pageBaseline: 0 });
    const loaded = await getNote(created.id);
    expect(loaded).toEqual(created);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getNote('missing')).toBeUndefined();
  });

  it('applies a partial update and returns the merged record', async () => {
    const created = await createNote({ title: 'Draft', deviceId: 'huion:abc', pageBaseline: 0 });
    const updated = await updateNote(created.id, { status: 'complete', endedAt: 1234 });

    expect(updated.status).toBe('complete');
    expect(updated.endedAt).toBe(1234);
    expect(updated.title).toBe('Draft');
    expect(await getNote(created.id)).toEqual(updated);
  });

  it('throws when updating an unknown id', async () => {
    await expect(updateNote('missing', { title: 'x' })).rejects.toThrow('missing');
  });

  it('lists notes newest first', async () => {
    const first = await createNote({ title: 'One', deviceId: 'huion:abc', pageBaseline: 0 });
    await updateNote(first.id, { startedAt: 1000 });
    const second = await createNote({ title: 'Two', deviceId: 'huion:abc', pageBaseline: 0 });
    await updateNote(second.id, { startedAt: 2000 });

    const listed = await listNotes();
    expect(listed.map((note) => note.title)).toEqual(['Two', 'One']);
  });

  it('deletes a note', async () => {
    const created = await createNote({ title: 'Temp', deviceId: 'huion:abc', pageBaseline: 0 });
    await deleteNote(created.id);
    expect(await getNote(created.id)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/storage/notes.test.ts`
Expected: FAIL — cannot resolve `@/storage/notes`.

- [ ] **Step 4: Write the implementation**

Create `src/storage/notes.ts`:

```ts
import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { NoteRecord } from '@/storage/types';

export interface CreateNoteInput {
  title: string;
  deviceId: string;
  pageBaseline: number;
}

export async function createNote(input: CreateNoteInput): Promise<NoteRecord> {
  const note: NoteRecord = {
    id: newId(),
    title: input.title,
    status: 'active',
    deviceId: input.deviceId,
    deviceType: 'huion',
    startedAt: Date.now(),
    endedAt: null,
    pageBaseline: input.pageBaseline,
    summary: null,
    summaryModel: null,
    legacy: false,
  };

  const db = await openNotesDb();
  await db.put('notes', note);
  return note;
}

export async function getNote(id: string): Promise<NoteRecord | undefined> {
  const db = await openNotesDb();
  return db.get('notes', id);
}

export async function updateNote(
  id: string,
  patch: Partial<Omit<NoteRecord, 'id'>>,
): Promise<NoteRecord> {
  const db = await openNotesDb();
  const existing = await db.get('notes', id);
  if (!existing) {
    throw new Error(`Note not found: ${id}`);
  }
  const merged: NoteRecord = { ...existing, ...patch, id: existing.id };
  await db.put('notes', merged);
  return merged;
}

export async function listNotes(): Promise<NoteRecord[]> {
  const db = await openNotesDb();
  const ascending = await db.getAllFromIndex('notes', 'by-started');
  return ascending.reverse();
}

/** Deletes a note and every page belonging to it, in one transaction. */
export async function deleteNote(id: string): Promise<void> {
  const db = await openNotesDb();
  const tx = db.transaction(['notes', 'pages'], 'readwrite');

  await tx.objectStore('notes').delete(id);

  const index = tx.objectStore('pages').index('by-note');
  let cursor = await index.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.done;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/storage/notes.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/id.ts src/storage/notes.ts src/storage/notes.test.ts
git commit -m "feat(storage): add notes repository"
```

---

### Task 4: Pages repository

The Blob round-trip test in this task is deliberately load-bearing: if
`fake-indexeddb` cannot structured-clone a `Blob`, we need to know now, not in
Phase 3 when rendered images arrive. See Step 6 for the fallback.

**Files:**
- Create: `src/storage/pages.ts`
- Create: `src/storage/pages.test.ts`

**Interfaces:**
- Consumes: `openNotesDb()`, `PageRecord`, `PageStroke`, `PageSource`, `TranscriptRecord` from Task 2; `newId()` from Task 3; `deleteNote()` from Task 3 (tested here for cascade).
- Produces:
  - `createPage(input: CreatePageInput): Promise<PageRecord>` where
    `CreatePageInput = { noteId: string; pageIndex: number; devicePageNum: number | null; source: PageSource; strokes: PageStroke[] }`
  - `getPage(id: string): Promise<PageRecord | undefined>`
  - `listPages(noteId: string): Promise<PageRecord[]>` — ordered by `pageIndex`
  - `setPageRender(id: string, render: Blob, width: number, height: number): Promise<PageRecord>`
  - `setPageTranscript(id: string, transcript: TranscriptRecord): Promise<PageRecord>`
  - `countPoints(strokes: PageStroke[]): number`

- [ ] **Step 1: Write the failing test**

Create `src/storage/pages.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { createNote, deleteNote } from '@/storage/notes';
import {
  countPoints,
  createPage,
  getPage,
  listPages,
  setPageRender,
  setPageTranscript,
} from '@/storage/pages';
import type { PageStroke } from '@/storage/types';
import { resetDatabase } from '@/test/resetDb';

const STROKES: PageStroke[] = [
  { points: [{ x: 0.1, y: 0.1, pressure: 0.5 }, { x: 0.2, y: 0.2, pressure: 0.6 }] },
  { points: [{ x: 0.3, y: 0.3, pressure: 0.4 }] },
];

beforeEach(resetDatabase);

describe('countPoints', () => {
  it('sums points across strokes', () => {
    expect(countPoints(STROKES)).toBe(3);
  });

  it('returns zero for no strokes', () => {
    expect(countPoints([])).toBe(0);
  });
});

describe('pages repository', () => {
  it('creates a page and derives its point count', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: 4,
      source: 'rom',
      strokes: STROKES,
    });

    expect(page.pointCount).toBe(3);
    expect(page.source).toBe('rom');
    expect(page.devicePageNum).toBe(4);
    expect(page.render).toBeNull();
    expect(page.transcript).toBeNull();
    expect(await getPage(page.id)).toEqual(page);
  });

  it('lists pages ordered by pageIndex regardless of insertion order', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    for (const pageIndex of [2, 0, 1]) {
      await createPage({
        noteId: note.id,
        pageIndex,
        devicePageNum: null,
        source: 'live',
        strokes: [],
      });
    }

    const listed = await listPages(note.id);
    expect(listed.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
  });

  it('scopes listPages to one note', async () => {
    const first = await createNote({ title: 'A', deviceId: 'huion:abc', pageBaseline: 0 });
    const second = await createNote({ title: 'B', deviceId: 'huion:abc', pageBaseline: 0 });
    await createPage({ noteId: first.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [] });
    await createPage({ noteId: second.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [] });

    expect(await listPages(first.id)).toHaveLength(1);
  });

  it('round-trips a Blob render through IndexedDB', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    await setPageRender(page.id, blob, 800, 1000);

    const loaded = await getPage(page.id);
    expect(loaded?.renderW).toBe(800);
    expect(loaded?.renderH).toBe(1000);
    expect(loaded?.render).toBeInstanceOf(Blob);
    expect(loaded?.render?.type).toBe('image/png');
    expect(new Uint8Array(await loaded!.render!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it('stores a transcript on a page', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
    });

    await setPageTranscript(page.id, {
      markdown: '# Heading',
      model: 'some-vision-model',
      status: 'done',
      error: null,
      updatedAt: 42,
    });

    const loaded = await getPage(page.id);
    expect(loaded?.transcript?.markdown).toBe('# Heading');
    expect(loaded?.transcript?.status).toBe('done');
  });

  it('throws when updating an unknown page', async () => {
    await expect(
      setPageTranscript('missing', {
        markdown: '',
        model: 'm',
        status: 'failed',
        error: 'nope',
        updatedAt: 1,
      }),
    ).rejects.toThrow('missing');
  });

  it('deletes pages when their note is deleted', async () => {
    const note = await createNote({ title: 'N', deviceId: 'huion:abc', pageBaseline: 0 });
    await createPage({ noteId: note.id, pageIndex: 0, devicePageNum: null, source: 'live', strokes: [] });
    await createPage({ noteId: note.id, pageIndex: 1, devicePageNum: null, source: 'live', strokes: [] });

    await deleteNote(note.id);
    expect(await listPages(note.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/pages.test.ts`
Expected: FAIL — cannot resolve `@/storage/pages`.

- [ ] **Step 3: Write the implementation**

Create `src/storage/pages.ts`:

```ts
import { openNotesDb } from '@/storage/db';
import { newId } from '@/storage/id';
import type { PageRecord, PageSource, PageStroke, TranscriptRecord } from '@/storage/types';

export interface CreatePageInput {
  noteId: string;
  pageIndex: number;
  devicePageNum: number | null;
  source: PageSource;
  strokes: PageStroke[];
}

export function countPoints(strokes: PageStroke[]): number {
  return strokes.reduce((total, stroke) => total + stroke.points.length, 0);
}

export async function createPage(input: CreatePageInput): Promise<PageRecord> {
  const page: PageRecord = {
    id: newId(),
    noteId: input.noteId,
    pageIndex: input.pageIndex,
    devicePageNum: input.devicePageNum,
    source: input.source,
    strokes: input.strokes,
    pointCount: countPoints(input.strokes),
    capturedAt: Date.now(),
    render: null,
    renderW: null,
    renderH: null,
    transcript: null,
  };

  const db = await openNotesDb();
  await db.put('pages', page);
  return page;
}

export async function getPage(id: string): Promise<PageRecord | undefined> {
  const db = await openNotesDb();
  return db.get('pages', id);
}

export async function listPages(noteId: string): Promise<PageRecord[]> {
  const db = await openNotesDb();
  const pages = await db.getAllFromIndex('pages', 'by-note', IDBKeyRange.only(noteId));
  return pages.sort((a, b) => a.pageIndex - b.pageIndex);
}

async function patchPage(
  id: string,
  patch: Partial<Omit<PageRecord, 'id'>>,
): Promise<PageRecord> {
  const db = await openNotesDb();
  const existing = await db.get('pages', id);
  if (!existing) {
    throw new Error(`Page not found: ${id}`);
  }
  const merged: PageRecord = { ...existing, ...patch, id: existing.id };
  await db.put('pages', merged);
  return merged;
}

export function setPageRender(
  id: string,
  render: Blob,
  width: number,
  height: number,
): Promise<PageRecord> {
  return patchPage(id, { render, renderW: width, renderH: height });
}

export function setPageTranscript(
  id: string,
  transcript: TranscriptRecord,
): Promise<PageRecord> {
  return patchPage(id, { transcript });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/pages.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 5: Fallback if the Blob test fails**

Only if `round-trips a Blob render` fails with a structured-clone error: change
`PageRecord.render` from `Blob | null` to `ArrayBuffer | null`, add
`renderType: string | null` alongside `renderW`/`renderH`, and have
`setPageRender` accept `(id, buffer: ArrayBuffer, type: string, width, height)`.
Update the test to assert on the buffer and type. Record the change in the spec's
Decisions table, since Phase 2's renderer and Phase 4's viewer both depend on
this shape.

- [ ] **Step 6: Commit**

```bash
git add src/storage/pages.ts src/storage/pages.test.ts
git commit -m "feat(storage): add pages repository with render and transcript support"
```

---

### Task 5: Settings repository

**Files:**
- Create: `src/storage/settings.ts`
- Create: `src/storage/settings.test.ts`

**Interfaces:**
- Consumes: `openNotesDb()` from Task 2, and `resetDatabase()` from `@/test/resetDb`.
  `SettingRecord` is reached through the `NotesDb` schema type rather than
  imported directly — do not add an unused import, `noUnusedLocals` will fail the build.
- Produces:
  - `getSetting<T>(key: string, fallback: T): Promise<T>`
  - `setSetting<T>(key: string, value: T): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/storage/settings.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { getSetting, setSetting } from '@/storage/settings';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('settings repository', () => {
  it('returns the fallback for an unset key', async () => {
    expect(await getSetting('visionModel', 'none')).toBe('none');
  });

  it('round-trips a string value', async () => {
    await setSetting('visionModel', 'my-model');
    expect(await getSetting('visionModel', 'none')).toBe('my-model');
  });

  it('round-trips an object value', async () => {
    await setSetting('layout', { columns: 2, dense: true });
    expect(await getSetting('layout', { columns: 1, dense: false })).toEqual({
      columns: 2,
      dense: true,
    });
  });

  it('overwrites an existing value', async () => {
    await setSetting('visionModel', 'first');
    await setSetting('visionModel', 'second');
    expect(await getSetting('visionModel', 'none')).toBe('second');
  });

  it('distinguishes a stored null from an unset key', async () => {
    await setSetting('maybe', null);
    expect(await getSetting<string | null>('maybe', 'fallback')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/settings.test.ts`
Expected: FAIL — cannot resolve `@/storage/settings`.

- [ ] **Step 3: Write the implementation**

Create `src/storage/settings.ts`:

```ts
import { openNotesDb } from '@/storage/db';

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await openNotesDb();
  const record = await db.get('settings', key);
  // A stored `null` is a real value; only a missing record uses the fallback.
  return record === undefined ? fallback : (record.value as T);
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await openNotesDb();
  await db.put('settings', { key, value });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/settings.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/settings.ts src/storage/settings.test.ts
git commit -m "feat(storage): add settings key-value repository"
```

---

### Task 6: Legacy localStorage migration

Imports the existing notebook library from `localStorage` key
`takingnotes_downloaded_memory` (written by `src/App.tsx:853`). The legacy shape
is `DownloadedMemoryNotebook` from `src/types/memory.ts`.

**This must not delete the localStorage key.** It is the only copy of that data
until the user has confirmed the migration.

**Files:**
- Create: `src/storage/migrate.ts`
- Create: `src/storage/migrate.test.ts`

**Interfaces:**
- Consumes: `createNote`/`updateNote` from Task 3, `createPage` from Task 4, `getSetting`/`setSetting` from Task 5.
- Produces:
  - `LEGACY_STORAGE_KEY: string`
  - `MIGRATION_SETTING_KEY: string`
  - `migrateLegacyNotebooks(storage?: Storage): Promise<MigrationResult>` where
    `MigrationResult = { imported: number; pages: number; skipped: boolean }`

- [ ] **Step 1: Write the failing test**

Create `src/storage/migrate.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_STORAGE_KEY,
  MIGRATION_SETTING_KEY,
  migrateLegacyNotebooks,
} from '@/storage/migrate';
import { listNotes } from '@/storage/notes';
import { listPages } from '@/storage/pages';
import { getSetting } from '@/storage/settings';
import { resetDatabase } from '@/test/resetDb';

const LEGACY_NOTEBOOK = {
  id: 'nb-1',
  deviceId: 'huion:abc',
  notebookUuid: 'huion:abc',
  deviceType: 'huion',
  deviceName: 'Huion Note',
  notebookName: 'Meeting notes',
  downloadedAt: 1700000000000,
  pageWidth: 1409,
  pageHeight: 1869,
  pageCount: 2,
  pages: [
    {
      id: 'p-1',
      pageNum: 0,
      strokeCount: 1,
      pointCount: 2,
      timestamp: 1700000000000,
      strokes: [{ points: [{ x: 0.1, y: 0.2, pressure: 0.5 }, { x: 0.3, y: 0.4, pressure: 0.6 }] }],
    },
    {
      id: 'p-2',
      pageNum: 1,
      strokeCount: 1,
      pointCount: 1,
      timestamp: 1700000001000,
      strokes: [{ points: [{ x: 0.5, y: 0.6, pressure: 0.7 }] }],
    },
  ],
};

function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

beforeEach(resetDatabase);

describe('migrateLegacyNotebooks', () => {
  it('imports a notebook as a completed legacy note', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });

    const result = await migrateLegacyNotebooks(storage);
    expect(result).toEqual({ imported: 1, pages: 2, skipped: false });

    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Meeting notes');
    expect(notes[0].status).toBe('complete');
    expect(notes[0].legacy).toBe(true);
    expect(notes[0].startedAt).toBe(1700000000000);
    expect(notes[0].endedAt).toBe(1700000000000);
  });

  it('imports pages in order with rom as the source', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);

    const [note] = await listNotes();
    const pages = await listPages(note.id);

    expect(pages.map((page) => page.pageIndex)).toEqual([0, 1]);
    expect(pages.map((page) => page.devicePageNum)).toEqual([0, 1]);
    expect(pages.every((page) => page.source === 'rom')).toBe(true);
    expect(pages[0].pointCount).toBe(2);
    expect(pages[1].pointCount).toBe(1);
  });

  it('never deletes the legacy localStorage key', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  it('is idempotent - a second run imports nothing', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });

    await migrateLegacyNotebooks(storage);
    const second = await migrateLegacyNotebooks(storage);

    expect(second.skipped).toBe(true);
    expect(await listNotes()).toHaveLength(1);
  });

  it('records when the migration ran', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify([LEGACY_NOTEBOOK]) });
    await migrateLegacyNotebooks(storage);
    expect(await getSetting(MIGRATION_SETTING_KEY, 0)).toBeGreaterThan(0);
  });

  it('handles a missing key', async () => {
    const result = await migrateLegacyNotebooks(makeStorage());
    expect(result).toEqual({ imported: 0, pages: 0, skipped: false });
  });

  it('handles malformed JSON without throwing', async () => {
    const storage = makeStorage({ [LEGACY_STORAGE_KEY]: 'not json' });
    const result = await migrateLegacyNotebooks(storage);
    expect(result.imported).toBe(0);
  });

  it('skips notebooks that are not objects', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([null, 'nope', LEGACY_NOTEBOOK]),
    });
    const result = await migrateLegacyNotebooks(storage);
    expect(result.imported).toBe(1);
  });

  it('falls back to a placeholder title when the name is missing', async () => {
    const storage = makeStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify([{ ...LEGACY_NOTEBOOK, notebookName: '' }]),
    });
    await migrateLegacyNotebooks(storage);
    const [note] = await listNotes();
    expect(note.title).toBe('Imported notebook');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/migrate.test.ts`
Expected: FAIL — cannot resolve `@/storage/migrate`.

- [ ] **Step 3: Write the implementation**

Create `src/storage/migrate.ts`:

```ts
import { createNote, updateNote } from '@/storage/notes';
import { createPage } from '@/storage/pages';
import { getSetting, setSetting } from '@/storage/settings';
import type { PageStroke, StrokePoint } from '@/storage/types';

/** Written by the studio app at src/App.tsx:853. */
export const LEGACY_STORAGE_KEY = 'takingnotes_downloaded_memory';
export const MIGRATION_SETTING_KEY = 'legacyMigratedAt';

export interface MigrationResult {
  imported: number;
  pages: number;
  /** True when the migration had already run and was not repeated. */
  skipped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStrokes(value: unknown): PageStroke[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((stroke): PageStroke[] => {
    if (!isRecord(stroke) || !Array.isArray(stroke.points)) return [];

    const points = stroke.points.flatMap((point): StrokePoint[] => {
      if (!isRecord(point)) return [];
      return [{
        x: toNumber(point.x, 0),
        y: toNumber(point.y, 0),
        pressure: toNumber(point.pressure, 0.5),
      }];
    });

    return points.length > 0 ? [{ points }] : [];
  });
}

/**
 * One-shot import of the pre-existing localStorage notebook library.
 * Never removes the localStorage key - it remains the only other copy.
 */
export async function migrateLegacyNotebooks(
  storage: Storage = globalThis.localStorage,
): Promise<MigrationResult> {
  const alreadyRan = await getSetting(MIGRATION_SETTING_KEY, 0);
  if (alreadyRan > 0) {
    return { imported: 0, pages: 0, skipped: true };
  }

  let parsed: unknown;
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    parsed = raw === null ? [] : JSON.parse(raw);
  } catch {
    parsed = [];
  }

  const notebooks = Array.isArray(parsed) ? parsed : [];
  let imported = 0;
  let pages = 0;

  for (const notebook of notebooks) {
    if (!isRecord(notebook)) continue;

    const downloadedAt = toNumber(notebook.downloadedAt, Date.now());
    const title =
      typeof notebook.notebookName === 'string' && notebook.notebookName.trim().length > 0
        ? notebook.notebookName
        : 'Imported notebook';
    const deviceId =
      typeof notebook.notebookUuid === 'string' ? notebook.notebookUuid : 'unknown';

    const note = await createNote({ title, deviceId, pageBaseline: 0 });
    await updateNote(note.id, {
      status: 'complete',
      startedAt: downloadedAt,
      endedAt: downloadedAt,
      legacy: true,
    });

    const legacyPages = Array.isArray(notebook.pages) ? notebook.pages : [];
    for (const [pageIndex, legacyPage] of legacyPages.entries()) {
      if (!isRecord(legacyPage)) continue;
      await createPage({
        noteId: note.id,
        pageIndex,
        devicePageNum: toNumber(legacyPage.pageNum, pageIndex),
        source: 'rom',
        strokes: toStrokes(legacyPage.strokes),
      });
      pages += 1;
    }

    imported += 1;
  }

  await setSetting(MIGRATION_SETTING_KEY, Date.now());
  return { imported, pages, skipped: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/migrate.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Run the full suite, lint, and build**

```bash
npm test
npm run lint
npm run build
```
Expected: all tests pass; lint clean; build succeeds. The build check confirms
the studio app still compiles — this phase must not have changed its behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrate.ts src/storage/migrate.test.ts
git commit -m "feat(storage): migrate legacy localStorage notebooks into IndexedDB"
```

---

## Phase exit criteria

- [ ] `npm test` passes with all six tasks' tests green.
- [ ] `npm run lint` is clean.
- [ ] `npm run build` succeeds and the studio app is behaviourally unchanged.
- [ ] A note with pages and a `Blob` render survives a full database round-trip.
- [ ] Legacy `localStorage` notebooks import without loss, idempotently, and the
      original key is left in place.

## Verification against real data

Automated tests use synthetic fixtures. Before considering this phase done,
verify the migration against the real library on your machine:

1. Run `npm run dev` and open the studio app so any existing notebooks are present.
2. In DevTools console: `localStorage.getItem('takingnotes_downloaded_memory')?.length`
   — note the size and the number of notebooks.
3. In DevTools console, run the migration against the real store:
   ```js
   const { migrateLegacyNotebooks } = await import('/src/storage/migrate.ts');
   await migrateLegacyNotebooks();
   ```
4. Confirm the reported `imported` and `pages` counts match what the studio's
   memory page shows.
5. Confirm `localStorage.getItem('takingnotes_downloaded_memory')` is still present.
