import { act, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import type { SyllabusExtractor } from '@/syllabus/extractor';
import { SyllabusImport, type SyllabusImportDeps } from '@/syllabus/SyllabusImport';
import { importKeyForPastedText, sourceRefFor } from '@/syllabus/sourceRef';
import { click, flush, mount, typeInto, waitFor, type Mounted } from '@/triage/testing';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const NOW = local(2026, 9, 30);

const assignment = (over?: Partial<ExtractedAssignment>): ExtractedAssignment => ({
  title: 'Essay 1',
  dueAt: local(2026, 10, 15),
  rawDate: 'Oct 15',
  estimatedMinutes: 180,
  notes: '',
  ...over,
});

interface Harness {
  deps: SyllabusImportDeps;
  imported: Array<{ rows: unknown[]; importKey: string }>;
  syncs: number;
  settings: Record<string, unknown>;
  fromText: ReturnType<typeof vi.fn>;
  fromPdf: ReturnType<typeof vi.fn>;
  extractorFor: ReturnType<typeof vi.fn>;
}

function harness(opts?: {
  rows?: ExtractedAssignment[];
  fail?: Error;
  events?: CalendarEventRecord[];
}): Harness {
  const imported: Array<{ rows: unknown[]; importKey: string }> = [];
  const settings: Record<string, unknown> = { 'syllabus.termStart': null };
  let syncs = 0;

  const rows = opts?.rows ?? [assignment()];
  const fromText = vi.fn(async () => {
    if (opts?.fail) throw opts.fail;
    return rows;
  });
  const fromPdf = vi.fn(async () => {
    if (opts?.fail) throw opts.fail;
    return rows;
  });
  const extractor: SyllabusExtractor = { fromText, fromPdf } as unknown as SyllabusExtractor;
  // A spy, not a plain stub: findings 2, 5 and 7 all live in exactly which
  // arguments this receives (the term start in particular), so tests assert
  // on them directly rather than only on visible side effects. `vi.fn`
  // records every call's actual arguments regardless of this implementation's
  // own (zero) declared arity.
  const extractorFor = vi.fn(() => extractor);

  const h: Harness = {
    imported,
    get syncs() {
      return syncs;
    },
    settings,
    fromText,
    fromPdf,
    extractorFor,
    deps: {
      extractorFor,
      importAssignments: async (confirmed, importKey) => {
        imported.push({ rows: confirmed, importKey });
        return { created: confirmed.length, updated: 0 };
      },
      syncTasks: async () => {
        syncs += 1;
      },
      listEvents: async () => opts?.events ?? [],
      getSetting: (async (key: string) => settings[key] ?? null) as never,
      setSetting: (async (key: string, value: unknown) => {
        settings[key] = value;
      }) as never,
      now: () => NOW,
    },
  } as Harness;
  return h;
}

const byLabel = <T extends HTMLElement>(container: HTMLElement, label: string): T => {
  const found = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no element labelled ${label}; saw: ${container.innerHTML}`);
  return found;
};

const buttonNamed = (container: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').toLowerCase().includes(text.toLowerCase()),
  );
  if (!found) throw new Error(`no button named ${text}; saw: ${container.textContent}`);
  return found as HTMLButtonElement;
};

/** Pastes text, runs the extraction, and lets the async work settle. */
async function extractPasted(m: Mounted, text = 'Essay 1 due Oct 15') {
  typeInto(byLabel<HTMLTextAreaElement>(m.container, 'Syllabus text'), text);
  await click(buttonNamed(m.container, 'Extract'));
  await flush();
}

describe('SyllabusImport', () => {
  it('renders under the mount label the triage view asserts', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);
    expect(m.container.querySelector('section[aria-label="Syllabus"]')).toBeTruthy();
    m.unmount();
  });

  it('shows the review table and writes nothing until confirmed (A25)', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    expect(m.container.textContent).toContain('Essay 1');
    // The pasted textarea's own value also contains "Essay 1" as a real text
    // node, so the assertion above alone would still pass with the review
    // table entirely absent. Assert on something only the table produces.
    expect(m.container.querySelector('table')).toBeTruthy();
    expect(byLabel<HTMLInputElement>(m.container, 'Include Essay 1')).toBeTruthy();
    expect(h.imported).toEqual([]);
    expect(h.syncs).toBe(0);
    m.unmount();
  });

  it('writes on confirm, reports the counts, and runs the task sync once', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);
    await click(buttonNamed(m.container, 'Add'));
    await flush();

    expect(h.imported).toHaveLength(1);
    expect(h.imported[0].rows).toEqual([
      {
        title: 'Essay 1',
        dueAt: local(2026, 10, 15),
        allDay: true,
        required: true,
        estimatedMinutes: 180,
        notes: '',
      },
    ]);
    expect(h.imported[0].importKey).toMatch(/^pasted:/);
    expect(h.syncs).toBe(1);
    expect(m.container.textContent).toMatch(/created 1/i);
    // A screen-reader user must be told the result too, not just see it.
    expect(m.container.querySelector('[role="status"]')?.textContent).toMatch(/created 1/i);
    m.unmount();
  });

  it('writes once when confirm is clicked twice', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);
    const confirm = buttonNamed(m.container, 'Add');
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(h.imported).toHaveLength(1);
    m.unmount();
  });

  it('shows an undated row empty and unticked, and will not write it (A27)', async () => {
    const h = harness({ rows: [assignment({ dueAt: null, rawDate: 'TBD' })] });
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    const date = byLabel<HTMLInputElement>(m.container, 'Due date for Essay 1');
    const include = byLabel<HTMLInputElement>(m.container, 'Include Essay 1');
    expect(date.value).toBe('');
    expect(include.checked).toBe(false);
    expect(m.container.textContent).toMatch(/no date/i);
    expect(buttonNamed(m.container, 'Add').disabled).toBe(true);
    m.unmount();
  });

  it('includes that row once it is given a date, without a separate tick (finding 4)', async () => {
    const h = harness({ rows: [assignment({ dueAt: null, rawDate: 'TBD' })] });
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    typeInto(byLabel<HTMLInputElement>(m.container, 'Due date for Essay 1'), '2026-12-01');
    // The "enter one to include it" message would be a lie if the row still
    // needed a second, separate tick after that.
    expect(byLabel<HTMLInputElement>(m.container, 'Include Essay 1').checked).toBe(true);

    await click(buttonNamed(m.container, 'Add'));
    await flush();

    expect(h.imported[0].rows).toEqual([
      expect.objectContaining({ title: 'Essay 1', dueAt: local(2026, 12, 1) }),
    ]);
    m.unmount();
  });

  it('does not let a term-start change re-tick a row the user explicitly unticked (finding 2)', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);
    expect(buttonNamed(m.container, 'Add').textContent).toContain('1');

    await click(byLabel<HTMLInputElement>(m.container, 'Include Essay 1'));
    expect(buttonNamed(m.container, 'Add').textContent).toContain('0');

    typeInto(byLabel<HTMLInputElement>(m.container, 'Term start'), '2026-09-01');

    expect(byLabel<HTMLInputElement>(m.container, 'Include Essay 1').checked).toBe(false);
    expect(buttonNamed(m.container, 'Add').textContent).toContain('0');
    m.unmount();
  });

  it('marks a row a previous import already wrote', async () => {
    const text = 'Essay 1 due Oct 15';
    const existing: CalendarEventRecord = {
      id: 'e1',
      title: 'Essay 1',
      kind: 'deadline',
      startsAt: local(2026, 10, 15),
      endsAt: null,
      allDay: true,
      required: true,
      estimatedMinutes: 180,
      notes: '',
      source: 'syllabus',
      // The same import key the component will compute for this pasted text.
      sourceRef: sourceRefFor(importKeyForPastedText(text), {
        title: 'Essay 1',
        dueAt: local(2026, 10, 15),
      }),
      createdAt: 1,
      updatedAt: 1,
    };
    const h = harness({ rows: [assignment()], events: [existing] });

    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m, text);

    expect(m.container.textContent).toMatch(/already imported/i);
    expect(m.container.textContent).toMatch(/updated in place/i);

    // Editing the title changes the row's identity (A26): the marker, and the
    // notice, must be recomputed rather than staying stale from extraction
    // (finding 3) - otherwise the user is told the opposite of what confirm
    // is about to do.
    typeInto(byLabel<HTMLInputElement>(m.container, 'Title for Essay 1'), 'Essay 1 revised');
    expect(m.container.textContent).not.toMatch(/already imported/i);
    expect(m.container.textContent).not.toMatch(/updated in place/i);
    m.unmount();
  });

  it('carries an edited title and estimate into the write', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    typeInto(byLabel<HTMLInputElement>(m.container, 'Title for Essay 1'), 'Essay one');
    typeInto(byLabel<HTMLInputElement>(m.container, 'Estimated minutes for Essay one'), '240');
    await click(buttonNamed(m.container, 'Add'));
    await flush();

    expect(h.imported[0].rows[0]).toMatchObject({ title: 'Essay one', estimatedMinutes: 240 });
    m.unmount();
  });

  it('says so when the syllabus held no assignments, and offers nothing to confirm', async () => {
    const h = harness({ rows: [] });
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    expect(m.container.textContent).toMatch(/no assignments/i);
    expect(buttonNamed(m.container, 'Add').disabled).toBe(true);
    expect(h.imported).toEqual([]);
    m.unmount();
  });

  it('surfaces an extraction failure and writes nothing', async () => {
    const h = harness({ fail: new Error('Could not reach Ollama at http://localhost:11434') });
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    expect(m.container.textContent).toContain('Could not reach Ollama');
    // Announced to a screen-reader user, not just visible (finding 6).
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('Could not reach Ollama');
    expect(h.imported).toEqual([]);
    m.unmount();
  });

  it('reports a write failure without claiming nothing happened, and does not run the task sync (finding 9)', async () => {
    const h = harness();
    h.deps.importAssignments = async () => {
      throw new Error('storage full');
    };
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);
    await click(buttonNamed(m.container, 'Add'));
    await flush();

    const alert = m.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Import failed');
    expect(alert?.textContent).toMatch(/may already have been added/i);
    expect(alert?.textContent).toMatch(/re-importing is safe/i);
    expect(h.syncs).toBe(0);
    m.unmount();
  });

  it('loads and persists the term start', async () => {
    const h = harness();
    h.settings['syllabus.termStart'] = local(2026, 9, 1);
    const m = mount(<SyllabusImport deps={h.deps} />);
    await flush();

    const termStart = byLabel<HTMLInputElement>(m.container, 'Term start');
    expect(termStart.value).toBe('2026-09-01');

    typeInto(termStart, '2027-01-11');
    expect(h.settings['syllabus.termStart']).toBe(local(2027, 1, 11));
    m.unmount();
  });

  it('extracts from a chosen PDF through the PDF path', async () => {
    const h = harness();
    const m = mount(<SyllabusImport deps={h.deps} />);

    const picker = byLabel<HTMLInputElement>(m.container, 'Syllabus PDF');
    const file = new File([new Uint8Array([1, 2, 3])], 'hist101.pdf', { type: 'application/pdf' });
    Object.defineProperty(picker, 'files', { value: [file] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(h.fromPdf).toHaveBeenCalledTimes(1);
    expect(h.fromText).not.toHaveBeenCalled();
    expect(m.container.textContent).toContain('Essay 1');
    // Without resetting the control, re-picking the very same file fires no
    // `change` event and the picker goes dead on a retry.
    expect(picker.value).toBe('');
    await click(buttonNamed(m.container, 'Add'));
    await flush();
    expect(h.imported[0].importKey).toBe('file:hist101.pdf');
    m.unmount();
  });

  it('passes the model, base URL, the displayed term start and the pasted text through to the extractor (finding 7)', async () => {
    const h = harness();
    h.settings['ollama.model'] = 'gemma3:12b';
    h.settings['ollama.baseUrl'] = 'http://example:11434';
    h.settings['syllabus.termStart'] = local(2026, 9, 1);
    const m = mount(<SyllabusImport deps={h.deps} />);
    await flush(); // loads the displayed term start before extraction runs

    await extractPasted(m, 'Essay 1 due Oct 15');

    expect(h.extractorFor).toHaveBeenCalledWith(
      'gemma3:12b',
      'http://example:11434',
      local(2026, 9, 1),
    );
    expect(h.fromText).toHaveBeenCalledWith(
      'Essay 1 due Oct 15',
      expect.objectContaining({ model: 'gemma3:12b' }),
    );
    m.unmount();
  });

  it('extracts against the term start currently displayed, not a fresh read of storage (finding 5)', async () => {
    const h = harness();
    h.settings['syllabus.termStart'] = local(2026, 9, 1);
    const m = mount(<SyllabusImport deps={h.deps} />);
    await flush();

    // The stored setting changes from elsewhere after it was already loaded
    // and shown - the extraction must use what is on screen, not silently
    // re-fetch a different value out from under the user.
    h.settings['syllabus.termStart'] = local(2027, 1, 1);

    await extractPasted(m);

    // `expect.anything()` rejects `null`, and this harness's model/baseUrl
    // settings are unset (null) here - only the term start argument matters
    // to this test, so check it directly.
    expect(h.extractorFor.mock.calls[0]?.[2]).toBe(local(2026, 9, 1));
    m.unmount();
  });

  it('disables the term start control while an extraction is in flight, and announces progress as status (finding 5, 6)', async () => {
    const h = harness();
    // A promise this test controls the resolution of: the harness's other
    // fakes resolve within the same microtask flush `click`'s `act` performs,
    // which would let the whole extraction finish before this test could ever
    // observe the mid-flight state it exists to check.
    let resolveExtraction: (rows: ExtractedAssignment[]) => void = () => {};
    h.deps.extractorFor = () => ({
      fromText: () => new Promise((resolve) => { resolveExtraction = resolve; }),
      fromPdf: async () => [],
    });
    const m = mount(<SyllabusImport deps={h.deps} />);
    typeInto(byLabel<HTMLTextAreaElement>(m.container, 'Syllabus text'), 'Essay 1 due Oct 15');
    await click(buttonNamed(m.container, 'Extract'));

    await waitFor(() => {
      expect(byLabel<HTMLInputElement>(m.container, 'Term start').disabled).toBe(true);
    });
    expect(m.container.querySelector('[role="status"]')?.textContent).toMatch(/starting/i);

    resolveExtraction([]);
    await waitFor(() => {
      expect(byLabel<HTMLInputElement>(m.container, 'Term start').disabled).toBe(false);
    });
    m.unmount();
  });

  it('under StrictMode, the term start loads and an extraction still reaches the review table (finding 1)', async () => {
    const h = harness();
    h.settings['syllabus.termStart'] = local(2026, 9, 1);
    const m = mount(
      <StrictMode>
        <SyllabusImport deps={h.deps} />
      </StrictMode>,
    );
    await flush();

    const termStart = byLabel<HTMLInputElement>(m.container, 'Term start');
    expect(termStart.value).toBe('2026-09-01');

    await extractPasted(m);

    expect(m.container.querySelector('table')).toBeTruthy();
    expect(buttonNamed(m.container, 'Add').disabled).toBe(false);
    m.unmount();
  });
});
