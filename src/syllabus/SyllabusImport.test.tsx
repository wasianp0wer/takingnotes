import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import type { SyllabusExtractor } from '@/syllabus/extractor';
import { SyllabusImport, type SyllabusImportDeps } from '@/syllabus/SyllabusImport';
import { importKeyForPastedText, sourceRefFor } from '@/syllabus/sourceRef';
import { click, flush, mount, typeInto, type Mounted } from '@/triage/testing';

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

  const h: Harness = {
    imported,
    get syncs() {
      return syncs;
    },
    settings,
    fromText,
    fromPdf,
    deps: {
      extractorFor: () => extractor,
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

  it('includes that row once it is given a date', async () => {
    const h = harness({ rows: [assignment({ dueAt: null, rawDate: 'TBD' })] });
    const m = mount(<SyllabusImport deps={h.deps} />);
    await extractPasted(m);

    typeInto(byLabel<HTMLInputElement>(m.container, 'Due date for Essay 1'), '2026-12-01');
    await click(byLabel<HTMLInputElement>(m.container, 'Include Essay 1'));
    await click(buttonNamed(m.container, 'Add'));
    await flush();

    expect(h.imported[0].rows).toEqual([
      expect.objectContaining({ title: 'Essay 1', dueAt: local(2026, 12, 1) }),
    ]);
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
    expect(h.imported).toEqual([]);
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
    await click(buttonNamed(m.container, 'Add'));
    await flush();
    expect(h.imported[0].importKey).toBe('file:hist101.pdf');
    m.unmount();
  });
});
