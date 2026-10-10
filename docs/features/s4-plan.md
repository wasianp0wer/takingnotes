# S4 Typed Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** a typed page is a first-class page: `engine.newTypedPage()` creates one on the serial op chain (mirroring `newPage`), its text autosaves through `setPageText` (K33, already shipped), it mixes freely with ink pages in one note (K32), and — the one rule needing care — a pen point arriving while the active page is typed opens a **new live page** instead of writing ink into it (K34, A38).

**Spec:** `docs/features/s4-spec.md`. Read it first; this plan is its execution, not a restatement.

## Global constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/s4-typed-pages`, branch `wave2/s4-typed-pages`. Never push, merge, or rebase.
- Edit only: `src/capture/engine.ts`, `src/capture/engine.test.ts`, `src/capture/types.ts`, `src/capture/pageTurnTestEngine.ts`, `src/notes/TypedPageEditor.tsx` (new) + its test, `src/notes/NotesView.tsx`, `src/notes/NotesView.test.tsx`. Plus, narrowly and mechanically (Task 1 only): one line each in `src/audio/RecorderControl.test.tsx` and `src/transcription/startTranscription.test.ts` — the two other `CaptureEngine` object literals the new interface member breaks `tsc -b` on.
- Do **not** edit `src/storage/pages.ts`, `src/capture/SessionControls.tsx`, `src/audio/**` (beyond the one line above), `src/device/**`, `src/notes/NoteToolbar.tsx`, `src/notes/NoteList.tsx`.
- No new runtime/dev dependencies. No `DB_VERSION` bump, no new store/index.
- Commands: `npm test` (baseline 1145 tests / 93 files, all passing — confirmed after the `vitest.config.ts` fix already committed), `npx tsc -b`, `npm run lint`, `npm run build`. All four pass before every commit.
- Mutation-check every new test: break the implementation, confirm red, revert.

---

### Task 1: `newTypedPage` on the interface, plus the three stubs it breaks

**Why first:** adding a member to `CaptureEngine` breaks `tsc -b` everywhere the interface is implemented as a literal. Landing the interface change and all three fixes in one commit keeps `tsc -b` green at every commit boundary, as required.

**Files:** `src/capture/types.ts`, `src/capture/pageTurnTestEngine.ts`, `src/audio/RecorderControl.test.tsx`, `src/transcription/startTranscription.test.ts`.

- [ ] **Step 1 — see it break.** Add to `CaptureEngine` in `src/capture/types.ts`, right after `newPage`:

  ```ts
  /**
   * Finalizes the active page and makes a new *typed* page the active page
   * (K32, K35). No active note -> no-op, resolves null, mirroring `newPage`'s
   * own A7 rule: starting a note at all (pen input, or "New note") is a
   * precondition. Pen input while the active page is typed opens a new
   * *live* page instead of writing ink into it (K34) - that is this
   * interface's caller's business (`src/capture/engine.ts`), not this
   * method's; this method only ever produces a typed page.
   */
  newTypedPage(): Promise<string | null>;
  ```

  Run `npx tsc -b`. Confirm it fails at exactly three places: `src/capture/pageTurnTestEngine.ts`, `src/audio/RecorderControl.test.tsx`, `src/transcription/startTranscription.test.ts` (the brief's own count — verify it, don't assume it).

- [ ] **Step 2 — fix all three, in the style already there.**

  `src/capture/pageTurnTestEngine.ts`, next to the existing `resumeNote` stub:
  ```ts
    // Resume is not exercised through this double.
    resumeNote: () => Promise.reject(new Error('resumeNote is not exercised through this double')),
    // Neither is a typed page.
    newTypedPage: () => Promise.reject(new Error('newTypedPage is not exercised through this double')),
  ```

  `src/audio/RecorderControl.test.tsx`, next to `newPage: notExercised('newPage'),`:
  ```ts
    newPage: notExercised('newPage'),
    newTypedPage: notExercised('newTypedPage'),
  ```

  `src/transcription/startTranscription.test.ts`, same addition next to its own `newPage: notExercised('newPage'),`.

- [ ] **Step 3 — green.** `npx tsc -b` clean. `npm test` still 1145/93. Commit:
  `feat(capture): add newTypedPage to the CaptureEngine interface`

---

### Task 2: `engine.newTypedPage()` — happy path from a live page

**Files:** `src/capture/engine.ts`, `src/capture/engine.test.ts`.

- [ ] **Step 1 — write the failing test.** Append inside `describe('capture engine', ...)` in `engine.test.ts` (new nested `describe`):

  ```ts
  describe('newTypedPage', () => {
    it('finalizes the outgoing live page, emits pageFinalized for it, and creates a typed page', async () => {
      const noteId = await engine.startNote();
      const first = engine.getState().activePageId!;
      const finalized: string[] = [];
      engine.subscribePageFinalized((id) => finalized.push(id));

      const second = await engine.newTypedPage();

      expect(second).toBeTruthy();
      expect(second).not.toBe(first);

      const pages = await listPages(noteId);
      expect(pages.map((p) => p.pageIndex)).toEqual([0, 1]);
      expect(pages[0].finalizedAt).toBeTypeOf('number');
      expect(pages[1]).toMatchObject({
        id: second,
        pageIndex: 1,
        source: 'typed',
        devicePageNum: null,
        finalizedAt: null,
        strokes: [],
      });
      expect(finalized).toEqual([first]);
      expect(engine.getState()).toMatchObject({ activePageId: second, pageIndex: 1 });
    });

    it('is a no-op with no active note', async () => {
      await engine.start();

      expect(await engine.newTypedPage()).toBeNull();

      expect(await listNotes()).toEqual([]);
      expect(engine.getState()).toEqual(IDLE);
    });
  });
  ```

  Run `npx vitest run src/capture/engine.test.ts`. Both fail (`engine.newTypedPage is not a function`).

- [ ] **Step 2 — implement.** In `src/capture/engine.ts`:

  Add to the imports from `@/storage/pages`:
  ```ts
  import {
    createPage,
    createTypedPage,
    finalizePage,
    isPageFinalized,
    isTypedPage,
    listPages,
    pageEndedAt,
    setPageStrokes,
  } from '@/storage/pages';
  ```
  and add `PageRecord` to the `@/storage/types` type import (needed by Task 6 too — add it now):
  ```ts
  import type { PageRecord, PageStroke, SessionStatus } from '@/storage/types';
  ```

  Add the new flag next to `pendingResume`'s declaration:
  ```ts
    /**
     * The typed page currently active, if any (K34, A38). Mirrors `noteOpen`'s
     * own discipline: a synchronous flag, flipped before any `await`, never
     * derived from `state` (stale until an op runs). Non-null only while
     * `noteOpen` is true, and only while `buffer.pageId` is null - the ink
     * buffer stays parked the whole time a typed page is active, so nothing
     * ever flushes a stroke onto it.
     */
    let activeTypedPageId: string | null = null;
  ```

  Add a helper right after `closeOldPage`:
  ```ts
    /**
     * Finalizes a typed page being left behind by a live transition
     * (`newTypedPage`, `startLivePageAfterTyping`) at `now()` - the same
     * instant `closeOldPage` uses for a live page. Never returns an id to
     * emit `pageFinalized` with: a typed page's transcript is already
     * `'done'` (K33), and the transcription queue's `markPending` would
     * overwrite it with `pending` the moment it saw one.
     */
    async function finalizeTypedPage(id: string): Promise<void> {
      try {
        await finalizePage(id, now());
      } catch (error) {
        console.error('[capture] finalizing a typed page failed', error);
      }
    }
  ```

  Add `newTypedPage`, right after `newPage`:
  ```ts
    /**
     * Finalizes the active page and makes a new *typed* page the active page
     * (K32, K35). No active note -> no-op, mirroring `newPage`'s own A7 rule.
     */
    function newTypedPage(): Promise<string | null> {
      void start();
      if (!noteOpen) return Promise.resolve(null);

      const old = closeBuffer();
      const typedId = activeTypedPageId;
      activeTypedPageId = null;

      return enqueue(async () => {
        const finalizedId = await closeOldPage(old);
        if (typedId !== null) await finalizeTypedPage(typedId);
        const noteId = state.activeNoteId;
        if (noteId === null) return null;

        const pageIndex = state.pageIndex + 1;
        const page = await createTypedPage({ noteId, pageIndex, capturedAt: now() });

        activeTypedPageId = page.id;
        setState({ ...state, activePageId: page.id, pageIndex });
        if (finalizedId !== null) emitPageFinalized(finalizedId);
        return page.id;
      });
    }
  ```

  Add it to the returned object, next to `newPage`:
  ```ts
      newPage,
      newTypedPage,
  ```

- [ ] **Step 3 — green.** `npx vitest run src/capture/engine.test.ts`. Both new tests pass.

- [ ] **Step 4 — mutation-check.** Temporarily change `pageIndex` to `state.pageIndex` (drop the `+ 1`) — confirm the first test fails on `pages.map(p=>p.pageIndex)`. Revert. Temporarily remove the `if (finalizedId !== null) emitPageFinalized(finalizedId);` line — confirm the first test fails on `expect(finalized).toEqual([first])`. Revert. Temporarily make `newTypedPage` skip the `!noteOpen` check — confirm the second test fails (a note gets created). Revert.

- [ ] **Step 5.** `npx tsc -b`, `npm run lint`, `npm run build`, `npm test` (1147/93 now). Commit:
  `feat(capture): implement newTypedPage from a live page`

---

### Task 3: `newTypedPage()` from an already-typed page — no double emit

**Files:** `src/capture/engine.ts` (no new implementation code expected — this proves Task 2's code already handles it via `activeTypedPageId`/`finalizeTypedPage`), `src/capture/engine.test.ts`.

- [ ] **Step 1 — write the failing-if-wrong test.**

  ```ts
    it('finalizes an outgoing typed page without emitting pageFinalized for it', async () => {
      await engine.startNote();
      const first = (await engine.newTypedPage())!;
      const finalized: string[] = [];
      engine.subscribePageFinalized((id) => finalized.push(id));

      const second = await engine.newTypedPage();

      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect((await getPage(first))!.finalizedAt).toBeTypeOf('number');
      expect(finalized).toEqual([]);
    });
  ```

  (`getPage` is already imported in `engine.test.ts`.) This should already pass given Task 2's implementation - run it to confirm, since it is a real behavioral claim about code just written, not yet exercised by this exact scenario.

- [ ] **Step 2.** `npx vitest run src/capture/engine.test.ts`. If it fails, the bug is almost certainly `closeOldPage(old)` being called on a buffer whose `pageId` is *not* null when it should be (i.e. the "ink buffer stays parked while typed" invariant from Task 2 broke) - re-check `newTypedPage`'s `const old = closeBuffer();` line runs *before* `buffer.pageId` was ever set to the outgoing typed page (it never is, by construction), so `old.pageId` should already be `null` here. It should pass without changes.

- [ ] **Step 3 — mutation-check.** Temporarily make `newTypedPage` emit `pageFinalized` for the typed page too (e.g. add `if (typedId !== null) emitPageFinalized(typedId);`) — confirm the test fails (`finalized` is no longer `[]`). Revert.

- [ ] **Step 4.** All four gates. Commit: `test(capture): cover newTypedPage leaving another typed page behind`

---

### Task 4: K34 — pen input while the active page is typed opens a new live page

**Files:** `src/capture/engine.ts`, `src/capture/engine.test.ts`.

- [ ] **Step 1 — write the failing tests.**

  ```ts
  describe('typed pages and pen input (K34)', () => {
    it('opens a new, unsplit live page when the pen writes while the active page is typed', async () => {
      const noteId = await engine.startNote();
      const typedId = (await engine.newTypedPage())!;

      stroke(fake, [[0.1, 0.1], [0.2, 0.2]]);
      await engine.flush();

      const pages = await listPages(noteId);
      expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);

      const typedPage = pages.find((p) => p.id === typedId)!;
      expect(typedPage.strokes).toEqual([]);
      expect(typedPage.finalizedAt).toBeTypeOf('number');

      const liveAfterTyped = pages[2];
      expect(liveAfterTyped.source).toBe('live');
      expect(liveAfterTyped.strokes).toHaveLength(1);
      expect(liveAfterTyped.strokes[0].points).toHaveLength(2);
      expect(engine.getState()).toMatchObject({ activePageId: liveAfterTyped.id, pageIndex: 2 });
    });

    it('does not emit pageFinalized for the typed page it leaves behind', async () => {
      await engine.startNote();
      const typedId = (await engine.newTypedPage())!;
      const finalized: string[] = [];
      engine.subscribePageFinalized((id) => finalized.push(id));

      stroke(fake, [[0.1, 0.1]]);
      await engine.flush();

      expect(finalized).not.toContain(typedId);
    });

    it('does not re-trigger on later points of the same stroke', async () => {
      await engine.startNote();
      await engine.newTypedPage();

      fake.emitPen({ x: 0.1, y: 0.1 });
      fake.emitPen({ x: 0.2, y: 0.2 });
      fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
      await engine.flush();

      const noteId = engine.getState().activeNoteId!;
      const pages = await listPages(noteId);
      // Exactly one new live page, not one per point.
      expect(pages.map((p) => p.source)).toEqual(['live', 'typed', 'live']);
    });
  });
  ```

  Run `npx vitest run src/capture/engine.test.ts`. All three fail: the pen's ink currently has nowhere to go (`buffer.pageId` stays `null` forever once a typed page is active, since nothing sets it), so no third page is ever created and the strokes are silently dropped.

- [ ] **Step 2 — implement.** In `src/capture/engine.ts`, add `startLivePageAfterTyping` right before `handlePen`:

  ```ts
    /**
     * K34: the pad coming back to life while the active page is typed must not
     * write ink into it (A38). Deliberately *not* `newPage`'s pattern: `newPage`
     * calls `closeBuffer()`, which force-ends whatever stroke is open onto the
     * *outgoing* page - correct for a deliberate turn, where that stroke
     * belongs to the page being left. Here the open stroke is the one that
     * just triggered this transition, and it must land on the *new* page, so
     * this function does not call `closeBuffer()` at all: `buffer` is already
     * parked (`pageId: null`) and is about to receive exactly this stroke.
     */
    function startLivePageAfterTyping(): void {
      const typedId = activeTypedPageId;
      activeTypedPageId = null; // before any await - same discipline as noteOpen
      const b = buffer;

      void enqueue(async () => {
        if (typedId !== null) await finalizeTypedPage(typedId);
        const noteId = state.activeNoteId;
        if (noteId === null) return;
        const pageIndex = state.pageIndex + 1;
        const buffered = [...b.strokes];
        const page = await createPage({
          noteId,
          pageIndex,
          devicePageNum: null,
          source: 'live',
          strokes: buffered,
          capturedAt: now(),
        });
        b.pageId = page.id;
        if (b.strokes.length === buffered.length) b.dirty = false;
        setState({ ...state, activePageId: page.id, pageIndex });
        void flushBuffer(b);
      });
    }
  ```

  Update `handlePen`'s existing auto-start check:
  ```ts
      // An open stroke after the push means a down point just arrived. Asking the
      // segmenter rather than re-deciding what "down" means keeps one definition
      // of it (segmenter.ts), so the two can never drift apart.
      //
      // Writing is never dropped: the points already sit in `buffer`, and the
      // note this starts adopts that same buffer as its page 0. K34: if the
      // active page is typed rather than idle, the pad coming back to life
      // opens a new live page instead - ink never lands on a typed page (A38).
      if (segmenter.current() !== null) {
        if (!noteOpen) void startNote();
        else if (activeTypedPageId !== null) startLivePageAfterTyping();
      }
  ```
  (replacing the previous single-line `if (segmenter.current() !== null && !noteOpen) void startNote();`).

- [ ] **Step 3 — green.** `npx vitest run src/capture/engine.test.ts`. All three pass.

- [ ] **Step 4 — mutation-check.** Temporarily call `closeBuffer()` at the top of `startLivePageAfterTyping` (the "wrong pattern" the spec calls out) — confirm the "unsplit" test fails (the stroke gets force-closed onto nothing / the new page gets 0 strokes instead of 1). Revert. Temporarily drop the `activeTypedPageId = null` line (clear) — confirm the "does not re-trigger" test fails (three new pages instead of one, or a crash). Revert.

- [ ] **Step 5.** All four gates. Commit: `feat(capture): open a new live page when the pen writes on a typed page (K34)`

---

### Task 5: `recover()` and `resumeNote()` must never emit `pageFinalized` for a typed page

**Files:** `src/capture/engine.ts`, `src/capture/engine.test.ts`.

- [ ] **Step 1 — write the failing tests.** Add `createTypedPage` to `engine.test.ts`'s import from `@/storage/pages`:
  ```ts
  import { createPage, createTypedPage, getPage, listPages } from '@/storage/pages';
  ```

  In the top-level `describe('capture engine', ...)`, near the existing `'recovers notes left active by a crash'` test:
  ```ts
    it('recovers a typed page left open without queuing it for transcription (A38)', async () => {
      const note = await createNote({
        title: 'Crashed with a typed page',
        deviceId: 'huion',
        pageBaseline: 0,
        status: 'active',
      });
      const livePage = await createPage({
        noteId: note.id,
        pageIndex: 0,
        devicePageNum: null,
        source: 'live',
        strokes: [{ points: [{ x: 0.1, y: 0.1, pressure: 0.5, t: 1000 }], startedAt: 900, endedAt: 1000 }],
        finalizedAt: null,
      });
      const typedPage = await createTypedPage({
        noteId: note.id,
        pageIndex: 1,
        text: 'left open',
        capturedAt: 1200,
      });

      const finalized: string[] = [];
      engine.subscribePageFinalized((id) => finalized.push(id));
      await engine.start();

      expect((await getPage(livePage.id))!.finalizedAt).toBe(1000);
      expect((await getPage(typedPage.id))!.finalizedAt).toBe(1200);
      expect((await getPage(typedPage.id))!.transcript?.status).toBe('done');
      expect(finalized).toEqual([livePage.id]);
    });
  ```

  In `describe('resumeNote', ...)`, near `'finalizes a page left open, at the time the writing stopped'`:
  ```ts
    it('resumes a note whose last page was typed and left open, without emitting pageFinalized for it', async () => {
      const note = await createNote({
        title: 'Typed then interrupted',
        deviceId: 'huion',
        pageBaseline: 0,
        status: 'interrupted',
      });
      const typedPage = await createTypedPage({ noteId: note.id, pageIndex: 0, text: 'unfinished', capturedAt: 1_000 });
      const finalized: string[] = [];
      engine.subscribePageFinalized((id) => finalized.push(id));

      await engine.resumeNote(note.id);
      await engine.flush();

      expect((await getPage(typedPage.id))!.finalizedAt).toBe(1_000);
      expect(finalized).toEqual([]);
      expect((await listPages(note.id)).map((p) => p.pageIndex)).toEqual([0, 1]);
    });
  ```

  Run `npx vitest run src/capture/engine.test.ts`. Both fail on `finalized`: today, both loops push every unfinalized page's id regardless of source, so `finalized` includes the typed page's id too.

- [ ] **Step 2 — implement.** Add a shared helper next to `finalizeTypedPage`:
  ```ts
    /**
     * `recover()`/`resumeNote()`'s shared "finalize whatever was left open"
     * step (A38 defense in depth, independent of whether the live engine
     * paths above already prevent an unfinalized typed page from reaching
     * here in practice). Finalizes at `pageEndedAt`, as both callers already
     * did - but only a *live* page's id is worth emitting `pageFinalized`
     * for; see `finalizeTypedPage` for why a typed one is not.
     */
    async function finalizeLeftOpen(page: PageRecord): Promise<string | null> {
      await finalizePage(page.id, pageEndedAt(page));
      return isTypedPage(page) ? null : page.id;
    }
  ```

  In `recover()`, replace:
  ```ts
          for (const page of pages) {
            if (isPageFinalized(page)) continue;
            // At the time writing stopped, not at the time recovery noticed:
            // see `pageEndedAt`.
            await finalizePage(page.id, pageEndedAt(page));
            finalized.push(page.id);
          }
  ```
  with:
  ```ts
          for (const page of pages) {
            if (isPageFinalized(page)) continue;
            const id = await finalizeLeftOpen(page);
            if (id !== null) finalized.push(id);
          }
  ```

  In `resumeNote()`, replace:
  ```ts
        for (const page of pages) {
          if (isPageFinalized(page)) continue;
          await finalizePage(page.id, pageEndedAt(page));
          finalized.push(page.id);
        }
  ```
  with the same two-line body (`const id = await finalizeLeftOpen(page); if (id !== null) finalized.push(id);`).

- [ ] **Step 3 — green.** `npx vitest run src/capture/engine.test.ts`. Both pass, and every pre-existing test in the file (the full live/ink `recover`/`resumeNote` suites) still passes unchanged.

- [ ] **Step 4 — mutation-check.** Temporarily make `finalizeLeftOpen` always return `page.id` (drop the `isTypedPage` guard) — confirm both new tests fail. Revert.

- [ ] **Step 5.** All four gates. Commit: `fix(capture): never queue a left-open typed page for transcription`

---

### Task 6: `TypedPageEditor.tsx` — the autosaved textarea

**Files:** `src/notes/TypedPageEditor.tsx` (new), `src/notes/TypedPageEditor.test.tsx` (new).

- [ ] **Step 1 — write the failing tests.**

  ```tsx
  import { act } from 'react';
  import { createRoot } from 'react-dom/client';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

  import { TypedPageEditor } from '@/notes/TypedPageEditor';
  import { createNote } from '@/storage/notes';
  import { createTypedPage, getPage, setPageText } from '@/storage/pages';
  import { resetDatabase } from '@/test/resetDb';

  declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
  }

  vi.mock('@/storage/pages', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/storage/pages')>();
    return {
      ...actual,
      setPageText: vi.fn(actual.setPageText),
    };
  });

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

  async function settle(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function mountEditor(props: { pageId: string; initialText: string; debounceMs?: number }) {
    await act(async () => {
      root.render(<TypedPageEditor {...props} />);
    });
    await settle();
  }

  function textarea(): HTMLTextAreaElement {
    const el = container.querySelector('textarea');
    if (!el) throw new Error('no textarea');
    return el;
  }

  function typeInto(el: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, value);
    act(() => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  describe('TypedPageEditor', () => {
    it('shows the text it was given', async () => {
      await mountEditor({ pageId: 'p1', initialText: 'hello' });
      expect(textarea().value).toBe('hello');
    });

    it('debounce-saves an edit through setPageText, mirroring it into the transcript', async () => {
      const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
      const page = await createTypedPage({ noteId: note.id, pageIndex: 0 });

      await mountEditor({ pageId: page.id, initialText: '', debounceMs: 20 });
      typeInto(textarea(), 'Newton on motion');
      await settle();

      const stored = await getPage(page.id);
      expect(stored?.text).toBe('Newton on motion');
      expect(stored?.transcript?.markdown).toBe('Newton on motion');
      expect(stored?.transcript?.status).toBe('done');
    });

    it('flushes pending text on unmount before the debounce fires', async () => {
      const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
      const page = await createTypedPage({ noteId: note.id, pageIndex: 0 });

      await mountEditor({ pageId: page.id, initialText: '', debounceMs: 10_000 });
      typeInto(textarea(), 'unsaved until unmount');
      act(() => root.unmount());
      await settle();

      expect((await getPage(page.id))?.text).toBe('unsaved until unmount');
    });

    it('surfaces a failed save without losing the typed text, and clears it once a later write succeeds', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const note = await createNote({ title: 'N', deviceId: 'huion', pageBaseline: 0 });
      const page = await createTypedPage({ noteId: note.id, pageIndex: 0 });

      await mountEditor({ pageId: page.id, initialText: '', debounceMs: 20 });
      vi.mocked(setPageText).mockRejectedValueOnce(new Error('disk full'));
      typeInto(textarea(), 'resilient');
      await settle();

      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't save this page — copy your text somewhere safe.",
      );
      expect(textarea().value).toBe('resilient');
      expect((await getPage(page.id))?.text ?? '').toBe('');

      typeInto(textarea(), 'resilient!');
      await settle();

      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect((await getPage(page.id))?.text).toBe('resilient!');

      consoleError.mockRestore();
    });
  });
  ```

  Run `npx vitest run src/notes/TypedPageEditor.test.tsx`. Fails: the module doesn't exist.

- [ ] **Step 2 — implement** `src/notes/TypedPageEditor.tsx`:

  ```tsx
  import { useCallback, useEffect, useRef, useState } from 'react';

  import { setPageText } from '@/storage/pages';

  export interface TypedPageEditorProps {
    pageId: string;
    /**
     * Seeds local state once. The parent remounts this component per page
     * (`key={page.id}`, the pattern `TranscriptPanel`/`GapPanel` already use),
     * so a stale value from a previously-viewed page is never a concern.
     */
    initialText: string;
    /** Tests only; defaults to 500ms like `useScratchpad`. */
    debounceMs?: number;
  }

  const SAVE_FAILED = "Couldn't save this page — copy your text somewhere safe.";

  /**
   * A typed page's text (K32, K35), autosaved on a debounce through
   * `setPageText` - which mirrors it into the page's transcript (K33), so
   * nothing here writes `transcript` directly. Follows `useScratchpad`'s own
   * dirty-tracking and flush-on-unmount pattern; it cannot reuse that hook,
   * which is hardwired to the single `triage.scratchpad` setting key rather
   * than a per-page write. "Dirty" is `pendingTextRef.current !==
   * persistedRef.current`, not a boolean, so a write that lands after a
   * newer edit already superseded it can never falsely mark the page saved.
   */
  export function TypedPageEditor({ pageId, initialText, debounceMs = 500 }: TypedPageEditorProps) {
    const [text, setTextState] = useState(initialText);
    const [error, setError] = useState<string | null>(null);

    const pendingTextRef = useRef(initialText);
    const persistedRef = useRef(initialText);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
    const mountedRef = useRef(true);
    const errorRef = useRef<string | null>(null);

    const showError = useCallback((next: string | null) => {
      if (!mountedRef.current || errorRef.current === next) return;
      errorRef.current = next;
      setError(next);
    }, []);

    const isDirty = useCallback(() => pendingTextRef.current !== persistedRef.current, []);

    const writeNow = useCallback(
      (value: string): Promise<void> => {
        const run = writeQueueRef.current
          .then(() => setPageText(pageId, value))
          .then(
            () => {
              persistedRef.current = value;
              showError(null);
            },
            (err: unknown) => {
              console.error('[notes] typed page save failed', err);
              showError(SAVE_FAILED);
            },
          );
        writeQueueRef.current = run;
        return run;
      },
      [pageId, showError],
    );

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (isDirty()) writeNow(pendingTextRef.current);
      };
    }, [isDirty, writeNow]);

    const setText = useCallback(
      (next: string) => {
        pendingTextRef.current = next;
        setTextState(next);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          writeNow(next);
        }, debounceMs);
      },
      [debounceMs, writeNow],
    );

    return (
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Typed page</h2>
          {error ? (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Saved automatically.</span>
          )}
        </div>
        <textarea
          aria-label="Typed page text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-96 w-full flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
    );
  }
  ```

- [ ] **Step 3 — green.** `npx vitest run src/notes/TypedPageEditor.test.tsx`. All four pass.

- [ ] **Step 4 — mutation-check.** Temporarily drop the unmount-flush (`if (isDirty()) writeNow(...)` → remove) — confirm the "flushes pending text on unmount" test fails. Revert. Temporarily make `showError` always clear (`setError(null)` unconditionally) — confirm the failure test's error assertion fails. Revert.

- [ ] **Step 5.** All four gates. Commit: `feat(notes): add TypedPageEditor, an autosaved textarea for a typed page`

---

### Task 7: Wire it into `NotesView` — the "Type page" button and the canvas swap

**Files:** `src/notes/NotesView.tsx`, `src/notes/NotesView.test.tsx`.

- [ ] **Step 1 — write the failing tests.** Add to `NotesView.test.tsx`'s import from `@/storage/pages`:
  ```ts
  import { createPage, getPage, setPageTranscript } from '@/storage/pages';
  ```

  Append inside `describe('NotesView', ...)`:
  ```tsx
    it('disables "Type page" with no active note', async () => {
      await render();
      expect(buttonByText('Type page').disabled).toBe(true);
    });

    it('creates a typed page via "Type page" and lets it be typed into', async () => {
      await render();
      await click(buttonByText('New note'));

      await click(buttonByText('Type page'));

      expect(engine.getState().pageIndex).toBe(1);
      const activePageId = engine.getState().activePageId!;
      const activePage = await getPage(activePageId);
      expect(activePage?.source).toBe('typed');

      const ta = container.querySelector('textarea')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(ta, 'Newton: F=ma');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      // The real default debounce (500ms) - this is the one place it's worth
      // proving the full NotesView -> TypedPageEditor -> setPageText wiring
      // against it; TypedPageEditor.test.tsx covers the debounce logic itself
      // with a fast override.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });

      const saved = await getPage(activePageId);
      expect(saved?.text).toBe('Newton: F=ma');
      expect(saved?.transcript?.markdown).toBe('Newton: F=ma');
    });

    it('does not show the "not yet transcribed" message for the active typed page', async () => {
      await render();
      await click(buttonByText('New note'));
      await click(buttonByText('Type page'));

      expect(container.textContent).not.toContain('Transcribed when the page is finished');
    });
  ```

  Run `npx vitest run src/notes/NotesView.test.tsx`. All three fail: no "Type page" button exists yet.

- [ ] **Step 2 — implement.** In `src/notes/NotesView.tsx`:

  Imports:
  ```tsx
  import { useRef, useState } from 'react';

  import { useCaptureEngine, useCaptureState } from '@/capture/CaptureContext';
  import { sessionStartedAtOf } from '@/capture/engine';
  import { ensureTranscriptionQueue } from '@/transcription/startTranscription';
  import type { TranscriptionQueue } from '@/transcription/queue';
  import { Button } from '@/components/ui/button';
  import { GapPanel } from '@/notes/GapPanel';
  import { InkCanvas } from '@/notes/InkCanvas';
  import { NoteList } from '@/notes/NoteList';
  import { NoteToolbar } from '@/notes/NoteToolbar';
  import { TranscriptPanel } from '@/notes/TranscriptPanel';
  import { TypedPageEditor } from '@/notes/TypedPageEditor';
  import { isTypedPage } from '@/storage/pages';
  import { useNotesData } from '@/notes/useNotesData';
  ```

  Inside the component, near the other `useState` calls:
  ```tsx
    const [creatingTypedPage, setCreatingTypedPage] = useState(false);
    const typedPageInFlight = useRef(false);

    async function handleTypePage() {
      if (typedPageInFlight.current) return;
      typedPageInFlight.current = true;
      setCreatingTypedPage(true);
      try {
        await engine.newTypedPage();
      } catch (error) {
        console.error('[notes] starting a typed page failed', error);
      } finally {
        typedPageInFlight.current = false;
        setCreatingTypedPage(false);
      }
    }
  ```

  `NoteToolbar`'s `actions` prop:
  ```tsx
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={state.activeNoteId === null || creatingTypedPage}
              title={
                state.activeNoteId === null
                  ? 'Start a note to begin typing'
                  : 'Finish this page and start a new, typed one'
              }
              onClick={() => void handleTypePage()}
            >
              Type page
            </Button>
          }
  ```

  Main canvas area:
  ```tsx
            {viewedPage &&
              (isTypedPage(viewedPage) ? (
                <TypedPageEditor key={viewedPage.id} pageId={viewedPage.id} initialText={viewedPage.text ?? ''} />
              ) : viewedPage.id === state.activePageId ? (
                <InkCanvas live dims={dims} />
              ) : (
                <InkCanvas strokes={viewedPage.strokes} dims={dims} />
              ))}
  ```

  Side panel - skip `TranscriptPanel` for a typed page (it would otherwise show "Transcribed when the page is finished" for the active one, which is wrong: a typed page's "transcription" is already done the moment its text is non-blank, and its content is already visible in the editor):
  ```tsx
            {viewedPage && (
              <>
                {!isTypedPage(viewedPage) && (
                  <TranscriptPanel
                    key={viewedPage.id}
                    page={viewedPage}
                    isActivePage={viewedPage.id === state.activePageId}
                    onRetry={(pageId) => queue.retry(pageId)}
                  />
                )}
                <GapPanel key={`gaps-${viewedPage.id}`} noteId={viewedPage.noteId} pageId={viewedPage.id} />
              </>
            )}
  ```

- [ ] **Step 3 — green.** `npx vitest run src/notes/NotesView.test.tsx`. All three new tests pass, and every pre-existing test in the file still passes (in particular `"renders F4's page-turn controls in the toolbar"` and the two other button-row tests, which must still find `New page`/`New note`/`End note` unaffected by the new `actions` content sitting between them).

- [ ] **Step 4 — mutation-check.** Temporarily render `TranscriptPanel` unconditionally again — confirm the "does not show the not yet transcribed message" test fails. Revert. Temporarily swap `isTypedPage(viewedPage)` for `false` in the canvas swap — confirm the "creates a typed page" test fails (no textarea found). Revert.

- [ ] **Step 5.** All four gates (`npm test` now 1145 + 2(Task2) + 1(Task3) + 3(Task4) + 2(Task5) + 4(Task6) + 3(Task7) = 1160). Commit: `feat(notes): mount "Type page" and swap the canvas for a typed page's editor`

---

### Task 8: Write the report

`docs/features/s4-report.md` — status, commits, test summary, decisions implemented, any mutation not detected, concerns. Commit it.
