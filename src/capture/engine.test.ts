import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCaptureEngine, sessionStartedAtOf, type LiveCaptureEngine } from '@/capture/engine';
import type { CaptureState } from '@/capture/types';
import { createNote, getNote, listNotes } from '@/storage/notes';
import { createPage, getPage, listPages } from '@/storage/pages';
import { createSession, getSession, listSessions } from '@/storage/sessions';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';

/**
 * How many of the next `createSession` calls fail, so a test can make the first
 * write of `startNote` fail. A countdown rather than a flag: the write happens
 * on the engine's op chain, well after the call that armed it, so a test cannot
 * disarm it by hand without racing the op it is trying to break.
 */
const hooks = vi.hoisted(() => ({ failSessionWrites: 0, failNoteWrites: 0, failNoteUpdates: 0 }));

vi.mock('@/storage/notes', async () => {
  const actual = await vi.importActual<typeof import('@/storage/notes')>('@/storage/notes');
  return {
    ...actual,
    // Same countdown shape and same reason as `failSessionWrites`: it lets a test
    // fail the note write *after* the session write has already landed.
    createNote: (input: Parameters<typeof actual.createNote>[0]) => {
      if (hooks.failNoteWrites > 0) {
        hooks.failNoteWrites -= 1;
        return Promise.reject(new Error('note write failed'));
      }
      return actual.createNote(input);
    },
    // Separate from `failNoteWrites`: `resumeNote` never calls `createNote`, so
    // a test needs its own lever to fail *after* resume's finalize loop and
    // session reuse have already committed, to prove the failure path owes
    // both of those their cleanup/trigger.
    updateNote: (
      id: Parameters<typeof actual.updateNote>[0],
      patch: Parameters<typeof actual.updateNote>[1],
    ) => {
      if (hooks.failNoteUpdates > 0) {
        hooks.failNoteUpdates -= 1;
        return Promise.reject(new Error('note update failed'));
      }
      return actual.updateNote(id, patch);
    },
  };
});

vi.mock('@/storage/sessions', async () => {
  const actual = await vi.importActual<typeof import('@/storage/sessions')>('@/storage/sessions');
  return {
    ...actual,
    createSession: (input: Parameters<typeof actual.createSession>[0]) => {
      if (hooks.failSessionWrites > 0) {
        hooks.failSessionWrites -= 1;
        return Promise.reject(new Error('session write failed'));
      }
      return actual.createSession(input);
    },
  };
});

const IDLE: CaptureState = {
  activeSessionId: null,
  activeNoteId: null,
  activePageId: null,
  pageIndex: -1,
};

/** Draws one complete stroke: `pts` down points followed by a pen-up. */
function stroke(fake: FakeDeviceController, pts: Array<[number, number]>) {
  for (const [x, y] of pts) fake.emitPen({ x, y, status: 1, pressure: 0.5 });
  fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
}

/** Lets already-scheduled microtasks and timers run. */
function tick(ms = 10) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let fake: FakeDeviceController;
let engine: LiveCaptureEngine;

beforeEach(async () => {
  hooks.failSessionWrites = 0;
  hooks.failNoteWrites = 0;
  hooks.failNoteUpdates = 0;
  await resetDatabase();
  fake = createFakeDeviceController();
  engine = createCaptureEngine({ controller: fake });
});

afterEach(() => {
  engine.dispose();
});

describe('capture engine', () => {
  it('starts idle and does not touch the pen until start() (StrictMode guard)', async () => {
    expect(engine.getState()).toEqual(IDLE);

    // main.tsx builds the engine in a useState initializer, which StrictMode
    // invokes twice and throws one result away. The discarded twin must not be
    // listening to the pen.
    stroke(fake, [[0.1, 0.1]]);
    await tick();

    expect(engine.getState()).toEqual(IDLE);
    expect(await listNotes()).toEqual([]);

    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.getState()).toEqual(IDLE);
  });

  it('creates a session, note and first page on startNote', async () => {
    await engine.start();
    const seen = vi.fn();
    engine.subscribe(seen);

    const noteId = await engine.startNote({ title: 'Bio' });

    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    const note = notes[0];
    expect(note.id).toBe(noteId);
    expect(note).toMatchObject({
      title: 'Bio',
      status: 'active',
      deviceType: 'huion',
      pageWidth: 1409,
      pageHeight: 1869,
      legacy: false,
    });
    expect(note.sessionId).toBeTruthy();

    const session = await getSession(note.sessionId!);
    expect(session).toMatchObject({ title: 'Bio', status: 'active', endedAt: null });

    const pages = await listPages(noteId);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ pageIndex: 0, source: 'live', finalizedAt: null });

    expect(engine.getState()).toEqual({
      activeSessionId: session!.id,
      activeNoteId: noteId,
      activePageId: pages[0].id,
      pageIndex: 0,
    });
    expect(seen).toHaveBeenCalledWith(engine.getState());
  });

  it('auto-starts a note on pen input and keeps the strokes written meanwhile', async () => {
    await engine.start();

    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
    ]);

    await vi.waitFor(() => expect(engine.getState().activeNoteId).not.toBeNull());
    await engine.flush();

    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    const pages = await listPages(notes[0].id);
    expect(pages).toHaveLength(1);
    expect(pages[0].strokes).toHaveLength(1);
    expect(pages[0].pointCount).toBe(3);

    const only = pages[0].strokes[0];
    expect(only.points).toHaveLength(3);
    expect(only.startedAt).toBeTypeOf('number');
    expect(only.endedAt).toBeTypeOf('number');
    for (const point of only.points) expect(point.t).toBeTypeOf('number');
  });

  it('persists a stroke on pen-up', async () => {
    await engine.startNote();
    const pageId = engine.getState().activePageId!;

    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
    ]);
    await engine.flush();

    const page = await getPage(pageId);
    expect(page!.strokes).toHaveLength(1);
    expect(page!.pointCount).toBe(3);
  });

  it('flushes the open stroke periodically', async () => {
    // Real timers: fake ones would also fake the timers fake-indexeddb runs on.
    engine.dispose();
    // A long gap limit too: with the default 500 ms, a slow test machine could
    // satisfy the assertion through a gap split (which closes the stroke and so
    // flushes on its own) rather than through the interval under test.
    engine = createCaptureEngine({ controller: fake, flushIntervalMs: 20, maxGapMs: 60_000 });
    await engine.start();

    fake.emitPen({ x: 0.1, y: 0.1 });
    await vi.waitFor(() => expect(engine.getState().activePageId).not.toBeNull());
    const pageId = engine.getState().activePageId!;

    // No pen-up: only the interval can get this second point onto disk.
    fake.emitPen({ x: 0.2, y: 0.2 });
    await vi.waitFor(async () => {
      expect((await getPage(pageId))!.pointCount).toBe(2);
    });
  });

  it('timestamps points with the injected clock', async () => {
    engine.dispose();
    engine = createCaptureEngine({ controller: fake, now: () => 5000 });
    await engine.startNote();
    const pageId = engine.getState().activePageId!;

    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();

    const page = await getPage(pageId);
    expect(page!.strokes[0].points.map((p) => p.t)).toEqual([5000, 5000]);
    expect(page!.strokes[0]).toMatchObject({ startedAt: 5000, endedAt: 5000 });
  });

  it('finalizes the old page and opens the next one on newPage', async () => {
    const noteId = await engine.startNote();
    const first = engine.getState().activePageId!;
    const finalized: string[] = [];
    engine.subscribePageFinalized((id) => finalized.push(id));

    const second = await engine.newPage('manual');

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    const pages = await listPages(noteId);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1]);
    expect(pages[0].finalizedAt).toBeTypeOf('number');
    expect(pages[1]).toMatchObject({
      id: second,
      pageIndex: 1,
      devicePageNum: null,
      finalizedAt: null,
    });
    expect(finalized).toEqual([first]);
    expect(engine.getState()).toMatchObject({ activePageId: second, pageIndex: 1 });
  });

  it('ignores a page turn with no active note (A7)', async () => {
    await engine.start();

    expect(await engine.newPage('device-turn')).toBeNull();

    expect(await listNotes()).toEqual([]);
    expect(await listSessions()).toEqual([]);
    expect(engine.getState()).toEqual(IDLE);
  });

  it('splits a stroke in progress across the page turn', async () => {
    const noteId = await engine.startNote();

    fake.emitPen({ x: 0.1, y: 0.1 });
    fake.emitPen({ x: 0.2, y: 0.2 });
    const turning = engine.newPage('device-turn');
    fake.emitPen({ x: 0.3, y: 0.3 });
    fake.emitPen({ x: 0.4, y: 0.4 });
    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });

    const second = await turning;
    await engine.flush();

    const pages = await listPages(noteId);
    expect(pages).toHaveLength(2);
    expect(pages[0].strokes).toHaveLength(1);
    expect(pages[0].strokes[0].points).toHaveLength(2);
    expect(pages[1].id).toBe(second);
    expect(pages[1].strokes).toHaveLength(1);
    expect(pages[1].strokes[0].points).toHaveLength(2);
  });

  it('stamps the device page number when connected', async () => {
    fake.setDeviceState({ isConnected: true, deviceName: 'Fake Huion Note', storedPageCount: 4 });

    const noteId = await engine.startNote();
    expect((await listPages(noteId))[0].devicePageNum).toBe(5);
    const note = await getNote(noteId);
    expect(note).toMatchObject({
      pageBaseline: 4,
      deviceId: 'Fake Huion Note',
      deviceName: 'Fake Huion Note',
    });

    fake.setDeviceState({ storedPageCount: 5 });
    await engine.newPage('device-turn');
    expect((await listPages(noteId))[1].devicePageNum).toBe(6);

    fake.setDeviceState({ isConnected: false });
    await engine.newPage('device-turn');
    expect((await listPages(noteId))[2].devicePageNum).toBeNull();
  });

  it('serializes concurrent page turns and the note end', async () => {
    const noteId = await engine.startNote();
    const finalized: string[] = [];
    engine.subscribePageFinalized((id) => finalized.push(id));

    const [a, b] = await Promise.all([
      engine.newPage('manual'),
      engine.newPage('manual'),
      engine.endNote(),
    ]);

    const pages = await listPages(noteId);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect([pages[1].id, pages[2].id]).toEqual([a, b]);
    for (const page of pages) expect(page.finalizedAt).toBeTypeOf('number');
    expect(finalized).toEqual(pages.map((p) => p.id));

    const note = await getNote(noteId);
    expect(note!.status).toBe('complete');
    expect(note!.endedAt).toBeTypeOf('number');
    const session = await getSession(note!.sessionId!);
    expect(session).toMatchObject({ status: 'ended' });
    expect(session!.endedAt).toBeTypeOf('number');
    expect(engine.getState()).toEqual(IDLE);
  });

  it('is a no-op on endNote when idle and closes the old note on startNote', async () => {
    await engine.start();

    await expect(engine.endNote()).resolves.toBeUndefined();
    expect(await listNotes()).toEqual([]);
    expect(await listSessions()).toEqual([]);

    const first = await engine.startNote({ title: 'One' });
    const firstPage = engine.getState().activePageId!;
    const second = await engine.startNote({ title: 'Two' });

    expect(second).not.toBe(first);
    const firstNote = await getNote(first);
    expect(firstNote!.status).toBe('complete');
    expect((await getPage(firstPage))!.finalizedAt).toBeTypeOf('number');
    expect((await getSession(firstNote!.sessionId!))!.status).toBe('ended');

    expect((await getNote(second))!.status).toBe('active');
    expect(engine.getState()).toMatchObject({ activeNoteId: second, pageIndex: 0 });
  });

  it('recovers notes left active by a crash', async () => {
    const session = await createSession({ title: 'Crashed' });
    const note = await createNote({
      title: 'Crashed',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'active',
      sessionId: session.id,
    });
    const page = await createPage({
      noteId: note.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      capturedAt: 900,
      strokes: [{ points: [{ x: 0.1, y: 0.1, pressure: 0.5, t: 1000 }], startedAt: 900, endedAt: 1000 }],
      finalizedAt: null,
    });

    // A note that ended properly must come through recovery untouched.
    const doneSession = await createSession({ title: 'Done', status: 'ended', endedAt: 2000 });
    const doneNote = await createNote({
      title: 'Done',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'complete',
      endedAt: 2000,
      sessionId: doneSession.id,
    });
    const donePage = await createPage({
      noteId: doneNote.id,
      pageIndex: 0,
      devicePageNum: null,
      source: 'live',
      strokes: [],
      finalizedAt: 1500,
    });

    const finalized: string[] = [];
    engine.subscribePageFinalized((id) => finalized.push(id));
    await engine.start();

    expect(await getNote(note.id)).toMatchObject({ status: 'interrupted', endedAt: 1000 });
    expect(await getSession(session.id)).toMatchObject({ status: 'ended', endedAt: 1000 });
    expect((await getPage(page.id))!.finalizedAt).toBeTypeOf('number');
    expect(finalized).toEqual([page.id]);

    expect(await getNote(doneNote.id)).toMatchObject({ status: 'complete', endedAt: 2000 });
    expect(await getSession(doneSession.id)).toMatchObject({ status: 'ended', endedAt: 2000 });
    expect((await getPage(donePage.id))!.finalizedAt).toBe(1500);
  });

  it('exposes live ink and notifies per point', async () => {
    await engine.startNote();
    const inkChanged = vi.fn();
    engine.subscribeInk(inkChanged);

    fake.emitPen({ x: 0.1, y: 0.1 });
    fake.emitPen({ x: 0.2, y: 0.2 });

    expect(inkChanged).toHaveBeenCalledTimes(2);
    const live = engine.getLiveStrokes();
    expect(live).toHaveLength(1);
    expect(live[0].points).toHaveLength(2);
    // Cached between changes: consumers render off the identity.
    expect(engine.getLiveStrokes()).toBe(live);

    fake.emitPen({ x: 0, y: 0, status: 0, pressure: 0 });
    expect(inkChanged).toHaveBeenCalledTimes(3);
    const closed = engine.getLiveStrokes();
    expect(closed).not.toBe(live);
    expect(closed).toHaveLength(1);
    expect(closed[0].points).toHaveLength(2);
  });

  it('survives a failed auto-start and lets the next call try again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await engine.start();
    hooks.failSessionWrites = 1;

    stroke(fake, [[0.1, 0.1]]);
    await tick();

    // Logged by the op chain, not thrown into the void: an auto-start nobody
    // awaited must not become an unhandled rejection.
    expect(logged).toHaveBeenCalled();
    expect(engine.getState()).toEqual(IDLE);
    expect(await listNotes()).toEqual([]);

    const noteId = await engine.startNote({ title: 'Retry' });
    expect(engine.getState().activeNoteId).toBe(noteId);
    logged.mockRestore();
  });

  it('does not let a failed startNote disown the note that queued behind it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await engine.start();

    hooks.failSessionWrites = 1;
    const doomed = engine.startNote({ title: 'One' });
    // Queued behind the doomed one, and it claims "a note is open" for itself.
    const second = engine.startNote({ title: 'Two' });

    await expect(doomed).rejects.toThrow('session write failed');
    const noteId = await second;
    expect(engine.getState().activeNoteId).toBe(noteId);

    // The failure must not have cleared `noteOpen`: this stroke belongs to the
    // note that succeeded, and must not auto-start a third one.
    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();

    const notes = await listNotes();
    expect(notes.map((n) => n.id)).toEqual([noteId]);
    const pages = await listPages(noteId);
    expect(pages).toHaveLength(1);
    expect(pages[0].strokes).toHaveLength(1);
    expect(pages[0].pointCount).toBe(2);
    logged.mockRestore();
  });

  it('stops listening to the pen on dispose', async () => {
    await engine.start();
    engine.dispose();

    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await tick();

    expect(await listNotes()).toEqual([]);
    expect(engine.getState()).toEqual(IDLE);
  });
  // P3 owns the real session flow (docs/architecture.md §6.7). These pin the
  // interface's contract against the thin delegation shipped with the
  // foundations, so P3 has a failing/passing line to build on.
  it('startSession opens a session with a note in it and reports both ids', async () => {
    await engine.start();

    const { sessionId, noteId } = await engine.startSession({ title: 'Seminar' });

    expect(engine.getState()).toMatchObject({
      activeSessionId: sessionId,
      activeNoteId: noteId,
      pageIndex: 0,
    });
    expect(await getSession(sessionId)).toMatchObject({ status: 'active', title: 'Seminar' });
    expect(await getNote(noteId)).toMatchObject({ status: 'active', sessionId });
    expect(await listPages(noteId)).toHaveLength(1);
  });

  it('endSession finalizes the page, completes the note and ends the session', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();
    const pageId = engine.getState().activePageId;

    await engine.endSession();

    expect(engine.getState()).toEqual(IDLE);
    expect(await getNote(noteId)).toMatchObject({ status: 'complete' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
    const page = await getPage(pageId as string);
    expect(page?.finalizedAt).not.toBeNull();
  });

  it('endSession is a no-op when idle', async () => {
    await engine.start();
    await expect(engine.endSession()).resolves.toBeUndefined();
    expect(engine.getState()).toEqual(IDLE);
    expect(await listSessions()).toEqual([]);
  });

  it('startSession ends an already-open note first', async () => {
    await engine.start();
    const firstNote = await engine.startNote({ title: 'Bare' });

    const { noteId } = await engine.startSession({ title: 'Seminar' });

    expect(noteId).not.toBe(firstNote);
    expect(await getNote(firstNote)).toMatchObject({ status: 'complete' });
  });

  it('startSession records the session on the note and publishes its start time', async () => {
    await engine.start();

    const { sessionId, noteId } = await engine.startSession({ title: 'Seminar' });

    const note = await getNote(noteId);
    expect(note).toMatchObject({ status: 'active', sessionId, title: 'Seminar' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'active', endedAt: null });
    const state = engine.getState();
    expect(state.sessionStartedAt).toBe(note!.startedAt);
    expect(sessionStartedAtOf(state)).toBe(note!.startedAt);
  });

  it('gives each concurrent startSession its own pair of ids', async () => {
    await engine.start();

    // Two clicks in one tick (or a click while the first start is still in
    // flight): reading the session id off published state after the await would
    // hand both callers the newer session.
    const [first, second] = await Promise.all([
      engine.startSession({ title: 'One' }),
      engine.startSession({ title: 'Two' }),
    ]);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.noteId).not.toBe(second.noteId);
    expect((await getNote(first.noteId))?.sessionId).toBe(first.sessionId);
    expect((await getNote(second.noteId))?.sessionId).toBe(second.sessionId);
    expect(await listSessions()).toHaveLength(2);
    expect(await listNotes()).toHaveLength(2);
    expect(await listPages(first.noteId)).toHaveLength(1);
    expect(await listPages(second.noteId)).toHaveLength(1);
  });

  it('endSession clears the published session start time', async () => {
    await engine.start();
    await engine.startSession();

    await engine.endSession();

    expect(engine.getState()).toEqual(IDLE);
    expect(sessionStartedAtOf(engine.getState())).toBeNull();
  });

  it('endNote also clears the published session start time', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();

    // Whatever closes the note ends its session, so the UI can never show a
    // session the engine no longer has.
    await engine.endNote();

    expect(sessionStartedAtOf(engine.getState())).toBeNull();
    expect(await getNote(noteId)).toMatchObject({ status: 'complete' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
  });

  it('publishes no session start time for a bare note', async () => {
    await engine.start();

    const noteId = await engine.startNote({ title: 'Bare' });

    // A bare note still gets its own session record (Phase 1's shape, A10),
    // but it is not a manual session, so the header shows none.
    expect(sessionStartedAtOf(engine.getState())).toBeNull();
    expect((await getNote(noteId))?.sessionId).toBeTruthy();
  });

  it('leaves nothing open when the session write fails', async () => {
    await engine.start();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.failSessionWrites = 1;

    await expect(engine.startSession()).rejects.toThrow('session write failed');
    expect(engine.getState()).toEqual(IDLE);

    // The next pen point must start a fresh note rather than accumulate into a
    // buffer that will never have a page.
    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();
    expect(await listNotes()).toHaveLength(1);
    logged.mockRestore();
  });

  it('ends the session it created when the note write fails', async () => {
    await engine.start();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.failNoteWrites = 1;

    await expect(engine.startSession()).rejects.toThrow('note write failed');

    // The session row landed before the note write failed. Leaving it `active`
    // with no note would misreport a session in progress until the next startup
    // recovery swept it - and P1 reads sessions.
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: 'ended' });
    expect(sessions[0].endedAt).not.toBeNull();
    expect(await listNotes()).toEqual([]);
    expect(engine.getState()).toEqual(IDLE);
    logged.mockRestore();
  });

  it('keeps writing on the session note when the pen comes down', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();

    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();

    // No second note and no second session: the pen's auto-start only fires
    // when nothing is open.
    expect(await listNotes()).toHaveLength(1);
    expect(await listSessions()).toHaveLength(1);
    expect(engine.getState().activeNoteId).toBe(noteId);
    expect(engine.getState().activeSessionId).toBe(sessionId);
    const pages = await listPages(noteId);
    expect(pages).toHaveLength(1);
    expect(pages[0].strokes).toHaveLength(1);
  });

  it('serializes a session start, a page turn and a session end fired together', async () => {
    await engine.start();

    const starting = engine.startSession({ title: 'Seminar' });
    const turning = engine.newPage('device-turn');
    const ending = engine.endSession();
    const [{ sessionId, noteId }] = await Promise.all([starting, turning, ending]);

    // Queued, never interleaved: one note, pages 0 and 1, both finalized.
    expect(await listNotes()).toHaveLength(1);
    const pages = await listPages(noteId);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1]);
    for (const page of pages) expect(page.finalizedAt).not.toBeNull();
    expect(await getNote(noteId)).toMatchObject({ status: 'complete' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
    expect(engine.getState()).toEqual(IDLE);
  });

  it('recovers a session interrupted by a reload', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession();
    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();
    // A reload or crash: nothing ended the session.
    engine.dispose();

    const next = createCaptureEngine({ controller: fake });
    const finalized = vi.fn();
    next.subscribePageFinalized(finalized);
    await next.start();

    expect(await getNote(noteId)).toMatchObject({ status: 'interrupted' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
    const pages = await listPages(noteId);
    expect(pages[0].finalizedAt).not.toBeNull();
    // The recovered page still queues for transcription.
    expect(finalized).toHaveBeenCalledWith(pages[0].id);
    expect(next.getState()).toEqual(IDLE);
    next.dispose();
  });

  it('keeps publishing the session start time across a page turn', async () => {
    await engine.start();
    await engine.startSession({ title: 'Seminar' });
    const startedAt = sessionStartedAtOf(engine.getState());
    expect(startedAt).toBeTypeOf('number');

    await engine.newPage('device-turn');

    // `newPage` republishes with a spread, so the field is one careless edit
    // away from being dropped mid-session.
    expect(engine.getState()).toMatchObject({ pageIndex: 1 });
    expect(sessionStartedAtOf(engine.getState())).toBe(startedAt);
  });

  it('clears the session start time when a bare note replaces the session', async () => {
    await engine.start();
    const { sessionId, noteId } = await engine.startSession({ title: 'Seminar' });

    const bare = await engine.startNote({ title: 'Bare' });

    // The session is gone, so the header must not still show one.
    expect(engine.getState().activeNoteId).toBe(bare);
    expect(sessionStartedAtOf(engine.getState())).toBeNull();
    expect(await getNote(noteId)).toMatchObject({ status: 'complete' });
    expect(await getSession(sessionId)).toMatchObject({ status: 'ended' });
  });

  it('titles an untitled session from the local date and time (A8)', async () => {
    await engine.start();

    const { sessionId, noteId } = await engine.startSession();

    // Not the formatted stamp itself: that is locale- and timezone-dependent.
    expect((await getSession(sessionId))?.title).toMatch(/^Session ./);
    expect((await getNote(noteId))?.title).toBe((await getSession(sessionId))?.title);
  });
});

describe('resumeNote', () => {
  it('reopens the note and its session and appends a page after the last', async () => {
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
    // Reassigning the module-level engine is this file's own pattern for a
    // test needing custom deps (engine.test.ts:184, :200); afterEach
    // disposes whichever engine is current.
    engine = createCaptureEngine({ controller: fake, now: () => clock.t });
    const noteId = await engine.startNote();
    await engine.endNote();
    await engine.flush();

    clock.t = 90_000_000;
    await engine.resumeNote(noteId);
    await engine.flush();

    expect(sessionStartedAtOf(engine.getState())).toBe(90_000_000);
  });

  it('creates and links a session for a note that has none', async () => {
    const orphan = await createNote({ title: 'Imported', deviceId: 'legacy', pageBaseline: 0, status: 'complete', sessionId: null });

    const ids = await engine.resumeNote(orphan.id);
    await engine.flush();

    expect(ids.sessionId).toBeTruthy();
    expect((await getNote(orphan.id))?.sessionId).toBe(ids.sessionId);
    expect((await getSession(ids.sessionId))?.status).toBe('active');
  });

  it('creates a session when the note names one that no longer exists', async () => {
    const dangling = await createNote({ title: 'Dangling', deviceId: 'huion', pageBaseline: 0, status: 'complete', sessionId: 'ses-gone' });

    const ids = await engine.resumeNote(dangling.id);
    await engine.flush();

    expect(ids.sessionId).not.toBe('ses-gone');
    expect((await getSession(ids.sessionId))?.status).toBe('active');
  });

  it('opens page 0 for a note with no pages', async () => {
    const bare = await createNote({ title: 'Bare', deviceId: 'huion', pageBaseline: 0, status: 'complete' });

    await engine.resumeNote(bare.id);
    await engine.flush();

    expect(engine.getState().pageIndex).toBe(0);
    expect((await listPages(bare.id)).map((p) => p.pageIndex)).toEqual([0]);
  });

  it('is a no-op for the note that is already open', async () => {
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
    const note = await createNote({ title: 'Interrupted', deviceId: 'huion', pageBaseline: 0, status: 'interrupted' });
    const open = await createPage({
      noteId: note.id, pageIndex: 0, devicePageNum: null, source: 'live',
      strokes: [{ points: [], endedAt: 7_000 }], capturedAt: 1_000,
    });
    const finalized: string[] = [];
    engine.subscribePageFinalized((id) => finalized.push(id));

    await engine.resumeNote(note.id);
    await engine.flush();

    expect((await getPage(open.id))?.finalizedAt).toBe(7_000);
    // The resumed page is owed its transcription trigger just as much on this
    // success path as on the failure path (round 1's fix): dropping this emit
    // would leave the page correctly finalized in storage but silently never
    // queued for transcription.
    expect(finalized).toContain(open.id);
  });

  it('rejects an unknown note and releases noteOpen for the next pen point', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await engine.start();

    await expect(engine.resumeNote('no-such-note')).rejects.toThrow(/not found/i);
    await engine.flush();
    expect(engine.getState().activeNoteId).toBeNull();

    // Idle `state` alone does not constrain this: the failure path never
    // touches `state`, so that assertion holds even with the `openerSeq`
    // rollback deleted entirely - and `startNote()` would then tolerate a
    // stuck flag anyway, since it force-closes whatever `noteOpen` claims is
    // open before opening its own. The one place a stuck flag actually bites
    // is pen-driven auto-start, which only fires when `noteOpen` is false - a
    // flag stuck true here would silently drop this stroke forever.
    stroke(fake, [
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    await engine.flush();

    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].status).toBe('active');
    const pages = await listPages(notes[0].id);
    expect(pages[0].strokes).toHaveLength(1);

    logged.mockRestore();
  });

  it('gives two concurrent resumes of the same note the same promise', async () => {
    const noteId = await engine.startNote();
    await engine.newPage('manual');
    await engine.endNote();
    await engine.flush();

    // Neither call is awaited before the second fires, so both run while
    // `state` still describes the idle engine - the published-state no-op
    // guard cannot see either of them yet.
    const [first, second] = await Promise.all([
      engine.resumeNote(noteId),
      engine.resumeNote(noteId),
    ]);
    await engine.flush();

    expect(first).toEqual(second);
    const pages = await listPages(noteId);
    // Exactly one page appended, not two, and it is the live page - a second,
    // independent resume would have reopened and then immediately finalized
    // the first one's new page.
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(pages[2].finalizedAt).toBeNull();
    expect(engine.getState().activePageId).toBe(pages[2].id);
  });

  it('restores a reused session and still queues finalized pages when a later write fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = await createSession({ title: 'Reused', status: 'ended', endedAt: 5_000 });
    const note = await createNote({
      title: 'Reused',
      deviceId: 'huion',
      pageBaseline: 0,
      status: 'interrupted',
      sessionId: session.id,
    });
    const open = await createPage({
      noteId: note.id, pageIndex: 0, devicePageNum: null, source: 'live',
      strokes: [{ points: [], endedAt: 7_000 }], capturedAt: 1_000,
    });

    const finalized: string[] = [];
    engine.subscribePageFinalized((id) => finalized.push(id));

    // Fails resumeNote's own `updateNote` call, which runs after the session
    // has already been flipped active and the finalize loop has already
    // committed - both of those writes are real and must not be stranded.
    hooks.failNoteUpdates = 1;
    await expect(engine.resumeNote(note.id)).rejects.toThrow('note update failed');
    await engine.flush();

    // The finalize write landed before the failure, so the page is still owed
    // its transcription trigger even though resume as a whole failed.
    expect(finalized).toEqual([open.id]);
    expect((await getPage(open.id))?.finalizedAt).toBe(7_000);

    // The session was flipped active for this attempt; it must be put back
    // rather than left dangling `active` with a note that never reopened.
    expect(await getSession(session.id)).toMatchObject({ status: 'ended', endedAt: 5_000 });

    logged.mockRestore();
  });
});
