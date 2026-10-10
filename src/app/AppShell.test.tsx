import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell, createNavigationTargetFactory } from '@/app/AppShell';
import { CaptureProvider } from '@/capture/CaptureContext';
import { createCaptureEngine } from '@/capture/engine';
import { TabletProvider } from '@/device/TabletProvider';
import { createNote } from '@/storage/notes';
import { createPage, setPageTranscript } from '@/storage/pages';
import { createRecording, finalizeRecording, setRecordingTranscript } from '@/storage/recordings';
import { createFakeDeviceController } from '@/test/fakeDeviceController';
import { resetDatabase } from '@/test/resetDb';

const migrate = vi.hoisted(() => vi.fn(async () => ({
  imported: 0,
  pages: 0,
  failed: 0,
  skipped: true,
})));

vi.mock('@/storage/migrate', () => ({ migrateLegacyNotebooks: migrate }));

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

function renderShell() {
  const engine = createCaptureEngine({ controller: createFakeDeviceController() });
  act(() => {
    root.render(
      <TabletProvider>
        <CaptureProvider engine={engine}>
          <AppShell />
        </CaptureProvider>
      </TabletProvider>,
    );
  });
}

function tab(label: string): HTMLElement {
  const found = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`no tab labelled ${label}`);
  return found as HTMLElement;
}

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function clickTab(label: string): Promise<void> {
  await act(async () => {
    tab(label).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button with text ${JSON.stringify(text)}`);
  return found;
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

async function typeQuery(value: string): Promise<void> {
  const input = container.querySelector('input')!;
  await act(async () => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** The sidebar's own `aria-current` on the selected note's row (`NoteList.tsx`). */
function selectedSidebarTitle(): string | null {
  return container.querySelector('button[aria-current="true"]')?.textContent?.trim() ?? null;
}

/** The Recordings sidebar's own `aria-current` on the selected recording's row. */
function selectedRecordingTitle(): string | null {
  const found = [...container.querySelectorAll('[data-recording-id]')].find(
    (b) => b.getAttribute('aria-current') === 'true',
  );
  return found?.textContent ?? null;
}

describe('AppShell', () => {
  it('shows the four tabs, the device status and the header controls', () => {
    renderShell();

    expect(tab('Notes')).toBeTruthy();
    expect(tab('Recordings')).toBeTruthy();
    expect(tab('Triage')).toBeTruthy();
    expect(tab('Search')).toBeTruthy();
    expect(container.textContent).toContain('Not connected');
    expect(container.textContent).toContain('Record');
    expect(container.querySelector('[aria-label="Settings"]')).toBeTruthy();
    // P3's mount point (docs/architecture.md §6.7): the header is the only
    // place session controls appear, so nothing else may claim it.
    expect(container.querySelector('[aria-label="Session"]')).toBeTruthy();
  });

  it("switches to Search and renders its landmark (S6, K39)", async () => {
    renderShell();

    await act(async () => {
      tab('Search').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      tab('Search').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // SearchView loads its corpus asynchronously (over IndexedDB) before it
    // renders anything but `null` - give it a few ticks to resolve.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(tab('Search').getAttribute('data-state')).toBe('active');
    expect(container.querySelector('[aria-label="Search"]')).not.toBeNull();
  });

  it('opens on Notes, which mounts F4\'s page-turn controls', () => {
    renderShell();

    expect(tab('Notes').getAttribute('data-state')).toBe('active');
    // NotesView must keep rendering PageTurnControls: it is F4's only mount point.
    expect(container.textContent).toContain('New page');
  });

  it('switches tabs', async () => {
    renderShell();

    await act(async () => {
      tab('Triage').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      tab('Triage').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(tab('Triage').getAttribute('data-state')).toBe('active');
    // One assertion per landmark, so a failure names the missing one.
    expect(container.querySelector('section[aria-label="Tasks"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="Calendar"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="Scratchpad"]')).not.toBeNull();
  });

  it("a Search hit's Open button for a note navigates to the exact note and page it names (Fix round 1, Finding 1)", async () => {
    await createNote({ title: 'Other Note', deviceId: 'd', pageBaseline: 0 });
    const target = await createNote({ title: 'Target Note', deviceId: 'd', pageBaseline: 0 });
    await createPage({ noteId: target.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    const page1 = await createPage({
      noteId: target.id,
      pageIndex: 1,
      devicePageNum: 2,
      source: 'live',
      strokes: [],
    });
    await setPageTranscript(page1.id, {
      markdown: 'a very distinctive search phrase',
      model: 'gemma4',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    renderShell();
    await clickTab('Search');
    await typeQuery('distinctive search phrase');
    await click(buttonByText('Open'));

    expect(tab('Notes').getAttribute('data-state')).toBe('active');
    expect(selectedSidebarTitle()).toBe('Target Note');
    expect(container.textContent).toContain('Page 2 of 2');
  });

  it('clicking the same Search hit a second time, after navigating away and back, still lands on the right note and page', async () => {
    await createNote({ title: 'Other Note', deviceId: 'd', pageBaseline: 0 });
    const target = await createNote({ title: 'Target Note', deviceId: 'd', pageBaseline: 0 });
    await createPage({ noteId: target.id, pageIndex: 0, devicePageNum: 1, source: 'live', strokes: [] });
    const page1 = await createPage({
      noteId: target.id,
      pageIndex: 1,
      devicePageNum: 2,
      source: 'live',
      strokes: [],
    });
    await setPageTranscript(page1.id, {
      markdown: 'a very distinctive search phrase',
      model: 'gemma4',
      promptVersion: 'gemma-v1',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    renderShell();

    await clickTab('Search');
    await typeQuery('distinctive search phrase');
    await click(buttonByText('Open'));
    expect(selectedSidebarTitle()).toBe('Target Note');

    // Navigate away from Notes entirely (not just back to Search), then
    // back to Search, and click the identical hit a second time.
    await clickTab('Triage');
    await clickTab('Search');
    await typeQuery('distinctive search phrase');
    await click(buttonByText('Open'));

    expect(tab('Notes').getAttribute('data-state')).toBe('active');
    expect(selectedSidebarTitle()).toBe('Target Note');
    expect(container.textContent).toContain('Page 2 of 2');
  });

  it("a Search hit's Open button for a recording switches to Recordings with that recording selected (Fix round 1, Finding 1)", async () => {
    await createRecording({ title: 'Other Recording', durationMs: 1000 }, new Blob(['a']));
    const target = await createRecording(
      { title: 'Target Recording', durationMs: 1000 },
      new Blob(['b']),
    );
    await finalizeRecording(target.id, new Blob(['b']), { endedAt: 2, durationMs: 1000 });
    await setRecordingTranscript(target.id, {
      text: 'mentions a very distinctive audio phrase',
      segments: [{ startMs: 5000, endMs: 6000, text: 'mentions a very distinctive audio phrase' }],
      model: 'whisper',
      language: 'en',
      status: 'done',
      error: null,
      updatedAt: 1,
    });
    // `other` is deliberately never finalized, so it is excluded from the
    // corpus (K5) and cannot be confused with the target either way.

    renderShell();
    await clickTab('Search');
    await typeQuery('distinctive audio phrase');
    await click(buttonByText('Open'));

    expect(tab('Recordings').getAttribute('data-state')).toBe('active');
    expect(selectedRecordingTitle()).toContain('Target Recording');
    expect(container.textContent).toContain('look for the segment at 0:05');
  });

  it('runs the legacy notebook migration once for the whole app', () => {
    renderShell();
    act(() => root.unmount());
    root = createRoot(container);
    renderShell();

    // Once across two mounts (and across StrictMode's double mount in dev):
    // two overlapping runs would both find the "migrated" setting unset and
    // import the library twice.
    expect(migrate).toHaveBeenCalledTimes(1);
  });
});

describe('createNavigationTargetFactory (Fix round 2)', () => {
  // Why this, rather than a click-through `AppShell` test: both `NotesView`
  // and `RecordingsView` are remounted fresh by Radix every time `AppShell`
  // switches back to their tab (see `createNavigationTargetFactory`'s own
  // comment in AppShell.tsx), so a round-trip test cannot tell a frozen
  // token from a working one - confirmed empirically while building this
  // fix: freezing the bump left a full "navigate away, come back, click the
  // same hit again" AppShell test green. This factory is the literal body
  // `openNote`/`openRecording` call, so testing it directly tests whether
  // AppShell would ever hand out a repeated token.
  it('bumps the token on every call on the note path, never repeating it - even for the identical note+page', () => {
    const factory = createNavigationTargetFactory();
    const first = factory.note('note-1', 0);
    const second = factory.note('note-1', 0);
    expect(second.token).not.toBe(first.token);
  });

  it('bumps the token on every call on the recording path, never repeating it - even for the identical recording', () => {
    const factory = createNavigationTargetFactory();
    const first = factory.recording('rec-1');
    const second = factory.recording('rec-1');
    expect(second.token).not.toBe(first.token);
  });

  it('shares one monotonic counter across both paths, so no two targets of either kind ever collide', () => {
    const factory = createNavigationTargetFactory();
    const tokens = [
      factory.note('a', 0).token,
      factory.recording('b').token,
      factory.note('a', 0).token,
      factory.recording('b').token,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
