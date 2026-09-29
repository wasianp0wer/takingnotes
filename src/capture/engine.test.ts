import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCaptureEngine, type LiveCaptureEngine } from '@/capture/engine';
import type { CaptureState } from '@/capture/types';
import { createNote, getNote, listNotes } from '@/storage/notes';
import { createPage, getPage, listPages } from '@/storage/pages';
import { createSession, getSession, listSessions } from '@/storage/sessions';
import { createFakeDeviceController, type FakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';

/** Flipped by one test to make the first write of `startNote` fail. */
const hooks = vi.hoisted(() => ({ failSession: false }));

vi.mock('@/storage/sessions', async () => {
  const actual = await vi.importActual<typeof import('@/storage/sessions')>('@/storage/sessions');
  return {
    ...actual,
    createSession: (input: Parameters<typeof actual.createSession>[0]) =>
      hooks.failSession
        ? Promise.reject(new Error('session write failed'))
        : actual.createSession(input),
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
  hooks.failSession = false;
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
    engine = createCaptureEngine({ controller: fake, flushIntervalMs: 20 });
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
    hooks.failSession = true;

    stroke(fake, [[0.1, 0.1]]);
    await tick();

    // Logged by the op chain, not thrown into the void: an auto-start nobody
    // awaited must not become an unhandled rejection.
    expect(logged).toHaveBeenCalled();
    expect(engine.getState()).toEqual(IDLE);
    expect(await listNotes()).toEqual([]);

    hooks.failSession = false;
    const noteId = await engine.startNote({ title: 'Retry' });
    expect(engine.getState().activeNoteId).toBe(noteId);
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
});
