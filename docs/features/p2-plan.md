# P2 Syllabus Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a syllabus (PDF or pasted text) into reviewed, confirmed
`kind: 'deadline'` calendar events that F3's existing task sync picks up.

**Architecture:** Pure helpers first (PDF text, date resolution, chunking, JSON
validation, `sourceRef`), then the extractor that composes them over the shared
Ollama text generator, then the storage write, then the review UI. Every model
call and every PDF open is behind an injected dependency, so no test touches the
network.

**Tech Stack:** TypeScript, React 19 (`createRoot` + `act` in tests, no
@testing-library/react), Vitest with happy-dom and `fake-indexeddb`,
`pdfjs-dist` via the foundations' `src/syllabus/pdfjs.ts`, Ollama through
`src/llm/ollamaText.ts` and `src/llm/ollamaClient.ts`.

**Spec:** `docs/features/p2-spec.md` (and `docs/spec-phase2.md` P2,
`docs/architecture.md` §6.4–§6.7)

## Global Constraints

- Work only in `/Users/maddiepersonal/takingnotes/.claude/worktrees/p2-syllabus`, branch `phase2/p2-syllabus`. Never push.
- Owned paths: `src/syllabus/**` **except** `src/syllabus/pdfjs.ts` (foundations — use it, never edit it).
- Never edit `src/storage/**`, `src/llm/**`, `src/capture/**`, `src/app/**`, `src/main.tsx`, `src/triage/**`, `src/notes/**`, `src/audio/**`, `src/device/**`, `src/utils/**`. Importing from them is fine.
- Never `import 'pdfjs-dist'` statically anywhere. Only `loadPdfjs()` from `@/syllabus/pdfjs`.
- Keep the export name `SyllabusImport` and the `aria-label="Syllabus"` on its root `<section>`: `src/triage/TriageView.test.tsx:57` asserts that label.
- `generateJson` must always be called with a `validate` (architecture §6.4: model JSON is untrusted; drop bad rows).
- Do not reimplement task generation. Call `syncTasksFromCalendar()` from `@/triage/generateTasks`.
- Imports use the `@/` alias and are ordered as elsewhere in the repo (external, then `@/`).
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Verification per task: `npx vitest run src/syllabus` green, and `npx tsc -b` clean.

## Review Focus

- **A file that is not a PDF** (or a corrupt one): pdf.js rejects, and the user must see a readable message instead of an unhandled rejection. Test in Task 1.
- **A syllabus with no assignments at all** (model returns `[]`): the review table must still appear and say so, with Confirm disabled, rather than writing nothing silently or crashing on an empty table. Test in Task 10.
- **One chunk of a long syllabus failing** mid-extraction: the extraction fails with a readable error rather than silently returning the assignments from the chunks that happened to work. Test in Task 6.
- **A garbage estimate typed into the review table** (`abc`, `-5`, `1e9`): must reach storage as the 60-minute default, never `NaN` or a negative. Test in Task 9.
- **Confirm pressed twice** (double click, or an impatient second click while the write is in flight): must write once. Test in Task 10.

---

### Task 1: PDF text and page rendering

**Files:**
- Create: `src/syllabus/pdfText.ts`
- Test: `src/syllabus/pdfText.test.ts`

**Interfaces:**
- Consumes: `loadPdfjs()` from `@/syllabus/pdfjs`.
- Produces:
  ```ts
  export const PAGE_TEXT_MIN_CHARS = 16;
  export const DEFAULT_PAGE_LONG_EDGE = 1400;
  export interface RenderPagesOptions { longEdge?: number; makeCanvas?: MakeCanvas }
  export type MakeCanvas = (w: number, h: number) => { canvas: { toBlob?: unknown }; context: unknown; toBlob: () => Promise<Blob> };
  export function extractPdfText(data: ArrayBuffer): Promise<string[]>;
  export function renderPdfPages(data: ArrayBuffer, pageNumbers: number[], opts?: RenderPagesOptions): Promise<Blob[]>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/pdfText.test.ts`. Stub pdf.js at the module boundary, the
way `src/syllabus/pdfjs.test.ts` already does (that file is the pattern; read it
first).

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { extractPdfText, PAGE_TEXT_MIN_CHARS, renderPdfPages } from '@/syllabus/pdfText';
import { resetPdfjsForTests } from '@/syllabus/pdfjs';

interface FakeItem { str: string; hasEOL?: boolean }

const hooks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(async () => {}),
}));

vi.mock('pdfjs-dist', () => ({
  version: '6.3.289',
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: hooks.getDocument,
}));

/** A fake pdf.js document: one entry per page, each a list of text items. */
function fakeDoc(pages: FakeItem[][], opts?: { failPage?: number }) {
  hooks.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: (n: number) => {
        if (opts?.failPage === n) return Promise.reject(new Error('bad page'));
        return Promise.resolve({
          getTextContent: () => Promise.resolve({ items: pages[n - 1] }),
          getViewport: ({ scale }: { scale: number }) => ({
            width: 600 * scale,
            height: 800 * scale,
            scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
        });
      },
    }),
    destroy: hooks.destroy,
  }));
}

const bytes = () => new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

beforeEach(() => {
  resetPdfjsForTests();
  hooks.destroy.mockClear();
  hooks.getDocument.mockReset();
});

describe('extractPdfText', () => {
  it('returns one string per page, in page order', async () => {
    fakeDoc([[{ str: 'Page one' }], [{ str: 'Page two' }]]);
    await expect(extractPdfText(bytes())).resolves.toEqual(['Page one', 'Page two']);
  });

  it('joins a page’s items and turns EOL markers into newlines', async () => {
    fakeDoc([[{ str: 'Essay 1 due Oct 15', hasEOL: true }, { str: 'Essay 2 due Nov 1' }]]);
    const [page] = await extractPdfText(bytes());
    expect(page).toBe('Essay 1 due Oct 15\nEssay 2 due Nov 1');
  });

  it('gives back an empty string for a page with no text layer', async () => {
    fakeDoc([[{ str: 'Real text on page one, long enough to count' }], []]);
    const pages = await extractPdfText(bytes());
    expect(pages[1]).toBe('');
  });

  it('treats a near-empty page as scanned', async () => {
    fakeDoc([[{ str: '   \n  ' }], [{ str: 'a' }]]);
    const pages = await extractPdfText(bytes());
    expect(pages).toEqual(['', '']);
    expect(PAGE_TEXT_MIN_CHARS).toBeGreaterThan(1);
  });

  it('destroys the document even when a page rejects', async () => {
    fakeDoc([[{ str: 'x' }], [{ str: 'y' }]], { failPage: 2 });
    await expect(extractPdfText(bytes())).rejects.toThrow('bad page');
    expect(hooks.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports a file pdf.js cannot open in a readable way', async () => {
    hooks.getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error('Invalid PDF structure')),
      destroy: hooks.destroy,
    }));
    await expect(extractPdfText(bytes())).rejects.toThrow(
      /could not be read as a PDF: Invalid PDF structure/i,
    );
    expect(hooks.destroy).toHaveBeenCalledTimes(1);
  });

  it('passes pdf.js a copy, so the caller’s buffer survives a second pass', async () => {
    fakeDoc([[{ str: 'Page one text here' }]]);
    const buffer = bytes();
    await extractPdfText(buffer);
    await extractPdfText(buffer);
    const passed = hooks.getDocument.mock.calls.map((c) => (c[0] as { data: Uint8Array }).data);
    expect(passed[0]).not.toBe(passed[1]);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});

describe('renderPdfPages', () => {
  it('renders only the requested pages, at the requested long edge', async () => {
    fakeDoc([[{ str: 'a' }], [{ str: 'b' }], [{ str: 'c' }]]);
    const sizes: Array<[number, number]> = [];
    const blobs = await renderPdfPages(bytes(), [2, 3], {
      longEdge: 400,
      makeCanvas: (w, h) => {
        sizes.push([w, h]);
        return {
          canvas: {},
          context: {},
          toBlob: () => Promise.resolve(new Blob([`${w}x${h}`], { type: 'image/png' })),
        };
      },
    });
    expect(blobs).toHaveLength(2);
    // 600x800 at a long edge of 400 → scale 0.5.
    expect(sizes).toEqual([[300, 400], [300, 400]]);
  });

  it('destroys the document when rendering fails', async () => {
    fakeDoc([[{ str: 'a' }]]);
    await expect(
      renderPdfPages(bytes(), [1], {
        makeCanvas: () => {
          throw new Error('no canvas');
        },
      }),
    ).rejects.toThrow('no canvas');
    expect(hooks.destroy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/maddiepersonal/takingnotes/.claude/worktrees/p2-syllabus && npx vitest run src/syllabus/pdfText.test.ts`
Expected: FAIL — cannot resolve `@/syllabus/pdfText`.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/pdfText.ts`:

```ts
import { loadPdfjs } from '@/syllabus/pdfjs';

/**
 * Below this many non-whitespace characters a page has nothing to extract and is
 * treated as scanned (P2-A4): it goes through the vision path instead.
 */
export const PAGE_TEXT_MIN_CHARS = 16;

/** Long edge in px for a scanned page render. Above Phase 1's 768 legibility floor. */
export const DEFAULT_PAGE_LONG_EDGE = 1400;

/** A drawing surface plus a way to get a PNG out of it, so tests need no real canvas. */
export interface PageCanvas {
  canvas: unknown;
  context: unknown;
  toBlob(): Promise<Blob>;
}

export type MakeCanvas = (width: number, height: number) => PageCanvas;

export interface RenderPagesOptions {
  longEdge?: number;
  makeCanvas?: MakeCanvas;
}

/**
 * pdf.js may transfer the bytes to its worker, which detaches the caller's
 * ArrayBuffer (P2-A12). Every open gets its own copy so a PDF can be read for
 * text and then rendered.
 */
const copy = (data: ArrayBuffer): Uint8Array => new Uint8Array(data.slice(0));

const unreadable = (err: unknown): Error =>
  new Error(
    `That file could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`,
  );

async function withDocument<T>(
  data: ArrayBuffer,
  use: (doc: {
    numPages: number;
    getPage(n: number): Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: copy(data) });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      // A wrong or corrupt file is the most likely failure and reaches the user.
      throw unreadable(err);
    }
    return await use(doc as never);
  } finally {
    await task.destroy();
  }
}

/**
 * The text of a PDF, page by page (architecture §6.5). A page whose text layer
 * is empty or near-empty comes back as `''` - a scanned page, not an error.
 */
export function extractPdfText(data: ArrayBuffer): Promise<string[]> {
  return withDocument(data, async (doc) => {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = (await doc.getPage(n)) as {
        getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      };
      const { items } = await page.getTextContent();
      let text = '';
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        text += item.hasEOL === true ? '\n' : ' ';
      }
      const tidy = text
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .trim();
      pages.push(tidy.replace(/\s/g, '').length >= PAGE_TEXT_MIN_CHARS ? tidy : '');
    }
    return pages;
  });
}

const defaultMakeCanvas: MakeCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a 2D canvas context to render the page');
  return {
    canvas,
    context,
    toBlob: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Page render produced no image'))),
          'image/png',
        );
      }),
  };
};

/** Renders 1-based `pageNumbers` to PNGs, for the pages with no usable text layer. */
export function renderPdfPages(
  data: ArrayBuffer,
  pageNumbers: number[],
  opts?: RenderPagesOptions,
): Promise<Blob[]> {
  const longEdge = opts?.longEdge ?? DEFAULT_PAGE_LONG_EDGE;
  const makeCanvas = opts?.makeCanvas ?? defaultMakeCanvas;

  return withDocument(data, async (doc) => {
    const blobs: Blob[] = [];
    for (const n of pageNumbers) {
      if (n < 1 || n > doc.numPages) continue;
      const page = (await doc.getPage(n)) as {
        getViewport(o: { scale: number }): { width: number; height: number };
        render(o: { canvasContext: unknown; viewport: unknown; canvas?: unknown }): {
          promise: Promise<void>;
        };
      };
      const base = page.getViewport({ scale: 1 });
      const scale = longEdge / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const surface = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
      await page.render({
        canvasContext: surface.context,
        canvas: surface.canvas,
        viewport,
      }).promise;
      blobs.push(await surface.toBlob());
    }
    return blobs;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/pdfText.test.ts` → PASS.
Then `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/pdfText.ts src/syllabus/pdfText.test.ts docs/features/p2-spec.md docs/features/p2-plan.md
git commit -m "$(cat <<'EOF'
feat(syllabus): per-page PDF text, with scanned pages coming back empty

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Date resolution

**Files:**
- Create: `src/syllabus/dates.ts`
- Test: `src/syllabus/dates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ParsedSyllabusDate { at: number; hasTime: boolean }
  export function parseSyllabusDate(raw: string, termStart: number, now: number): ParsedSyllabusDate | null;
  export function resolveDueDate(raw: string, termStart: number, now: number): number | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/dates.test.ts`. Use explicit local `Date` construction for
expectations, never UTC strings.

```ts
import { describe, expect, it } from 'vitest';

import { parseSyllabusDate, resolveDueDate } from '@/syllabus/dates';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();

/** A term that starts 1 September 2026, and a "now" inside it. */
const TERM = local(2026, 9, 1);
const NOW = local(2026, 9, 30);

describe('resolveDueDate', () => {
  it('reads an ISO date with a year', () => {
    expect(resolveDueDate('2026-10-15', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('due 2026/10/15', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('reads a month name with a day and a year', () => {
    expect(resolveDueDate('October 15th, 2026', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('Oct. 15 2026', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('reads a day-first month name with no year against the term start', () => {
    expect(resolveDueDate('15 Oct', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('rolls a no-year date earlier than the term start into the next year', () => {
    // Term starts in September 2026, so "January 20" is the following January.
    expect(resolveDueDate('January 20', TERM, NOW)).toBe(local(2027, 1, 20));
  });

  it('keeps a no-year date that falls exactly on the term start day in that year', () => {
    expect(resolveDueDate('September 1', TERM, NOW)).toBe(local(2026, 9, 1));
  });

  it('reads a numeric date month-first, and a two-digit year as 2000+', () => {
    expect(resolveDueDate('10/15', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('10/15/26', TERM, NOW)).toBe(local(2026, 10, 15));
    expect(resolveDueDate('10/15/2026', TERM, NOW)).toBe(local(2026, 10, 15));
  });

  it('resolves today and tomorrow against now', () => {
    expect(resolveDueDate('today', TERM, NOW)).toBe(local(2026, 9, 30));
    expect(resolveDueDate('tomorrow', TERM, NOW)).toBe(local(2026, 10, 1));
  });

  it('returns null rather than guessing', () => {
    for (const raw of ['', '   ', 'TBD', 'see Canvas', 'Week 5', 'Finals week', 'n/a']) {
      expect(resolveDueDate(raw, TERM, NOW)).toBeNull();
    }
  });

  it('returns null for a date that is not a real day', () => {
    expect(resolveDueDate('Feb 30', TERM, NOW)).toBeNull();
    expect(resolveDueDate('13/40', TERM, NOW)).toBeNull();
    expect(resolveDueDate('2026-02-30', TERM, NOW)).toBeNull();
  });
});

describe('parseSyllabusDate', () => {
  it('reports no time as local midnight', () => {
    expect(parseSyllabusDate('Oct 15', TERM, NOW)).toEqual({
      at: local(2026, 10, 15),
      hasTime: false,
    });
  });

  it('reads a 12-hour time', () => {
    expect(parseSyllabusDate('Oct 15 at 11:59pm', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 23, 59),
      hasTime: true,
    });
    expect(parseSyllabusDate('10/15 5:00 PM', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 17, 0),
      hasTime: true,
    });
    expect(parseSyllabusDate('Oct 15 by 9am', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 9, 0),
      hasTime: true,
    });
  });

  it('reads a 24-hour time', () => {
    expect(parseSyllabusDate('2026-10-15 17:00', TERM, NOW)).toEqual({
      at: local(2026, 10, 15, 17, 0),
      hasTime: true,
    });
  });

  it('ignores a time that is not a real time', () => {
    expect(parseSyllabusDate('Oct 15 at 25:99', TERM, NOW)).toEqual({
      at: local(2026, 10, 15),
      hasTime: false,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/dates.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/dates.ts`:

```ts
/**
 * Turning what a syllabus says into an instant, or into nothing (architecture
 * §6.5, spec-phase2 P2). A date this cannot read resolves to `null` and the
 * review table asks the user (A27) - it is never guessed.
 *
 * Everything is local time, through `Date` setters, so a DST boundary cannot
 * shift a deadline by an hour.
 */

export interface ParsedSyllabusDate {
  /** Epoch ms. Local midnight when the text stated no time. */
  at: number;
  hasTime: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Local midnight of a calendar day, or null when that day does not exist. */
function localDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // `Date` silently rolls 30 February over to March; that is a mis-date, not a date.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.getTime();
}

const fullYear = (raw: string): number => {
  const n = Number(raw);
  return raw.length <= 2 ? 2000 + n : n;
};

/**
 * The year for a date that stated none: the earliest year that puts it on or
 * after the term start's local day (P2-A2). A January date on a syllabus whose
 * term starts in September belongs to the next year.
 */
function yearFromTermStart(month: number, day: number, termStart: number): number | null {
  const base = new Date(startOfLocalDay(termStart));
  for (const year of [base.getFullYear(), base.getFullYear() + 1]) {
    const at = localDay(year, month, day);
    if (at !== null && at >= startOfLocalDay(termStart)) return at === null ? null : year;
  }
  // A 29 February that exists in neither candidate year.
  return null;
}

interface DayMatch {
  year: number | null;
  month: number;
  day: number;
}

/** The first date shape that matches, tried longest-first so a year is not missed. */
function matchDay(text: string): DayMatch | null {
  // 2026-10-15 / 2026/10/15
  const iso = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };

  // October 15th, 2026 / Oct. 15 2026 / Oct 15
  const monthFirst = new RegExp(
    `\\b(${MONTH_NAMES})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}|\\d{2})\\b)?`,
  ).exec(text);
  if (monthFirst) {
    return {
      year: monthFirst[3] === undefined ? null : fullYear(monthFirst[3]),
      month: MONTHS[monthFirst[1]],
      day: Number(monthFirst[2]),
    };
  }

  // 15 October 2026 / 15 Oct
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b\\.?(?:\\s*,?\\s*(\\d{4}|\\d{2})\\b)?`,
  ).exec(text);
  if (dayFirst) {
    return {
      year: dayFirst[3] === undefined ? null : fullYear(dayFirst[3]),
      month: MONTHS[dayFirst[2]],
      day: Number(dayFirst[1]),
    };
  }

  // 10/15/2026 / 10/15/26 / 10/15 - month first (P2-A1).
  const numeric = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?\b/.exec(text);
  if (numeric) {
    return {
      year: numeric[3] === undefined ? null : fullYear(numeric[3]),
      month: Number(numeric[1]),
      day: Number(numeric[2]),
    };
  }

  return null;
}

/** `11:59pm`, `5 PM`, `17:00`. Returns minutes past local midnight, or null. */
function matchTime(text: string): number | null {
  const twelve = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (twelve[3] === 'am' && hour === 12) hour = 0;
    if (twelve[3] === 'pm' && hour !== 12) hour += 12;
    return hour * 60 + minute;
  }
  const twentyFour = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }
  return null;
}

/**
 * Reads a syllabus date. `termStart` fixes the year for a date that stated none;
 * `now` is used only for the relative words (P2-A3).
 */
export function parseSyllabusDate(
  raw: string,
  termStart: number,
  now: number,
): ParsedSyllabusDate | null {
  const text = raw.toLowerCase().trim();
  if (text === '') return null;

  let day: number | null = null;
  if (/\btoday\b/.test(text)) day = startOfLocalDay(now);
  else if (/\btomorrow\b/.test(text)) {
    const d = new Date(startOfLocalDay(now));
    d.setDate(d.getDate() + 1);
    day = d.getTime();
  } else {
    const found = matchDay(text);
    if (!found) return null;
    const year = found.year ?? yearFromTermStart(found.month, found.day, termStart);
    if (year === null) return null;
    day = localDay(year, found.month, found.day);
    if (day === null) return null;
  }

  // The date's own digits must not be read back as a time: strip what matched.
  const timeText = text.replace(/\b\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b/g, ' ');
  const minutes = matchTime(timeText);
  if (minutes === null) return { at: day, hasTime: false };

  const withTime = new Date(day);
  withTime.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return { at: withTime.getTime(), hasTime: true };
}

/** Architecture §6.5: the instant, or `null` when the text gave no resolvable date. */
export function resolveDueDate(raw: string, termStart: number, now: number): number | null {
  return parseSyllabusDate(raw, termStart, now)?.at ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/dates.test.ts` → PASS. Fix the regexes against
the failures rather than changing the expectations: the test list is the spec.
Then `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/dates.ts src/syllabus/dates.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): resolve a syllabus date against a term start, or nothing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Chunking

**Files:**
- Create: `src/syllabus/chunk.ts`
- Test: `src/syllabus/chunk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const SYLLABUS_DIRECT_CHAR_BUDGET = 6000;
  export const SYLLABUS_CHUNK_CHARS = 3000;
  export const SYLLABUS_CHUNK_OVERLAP = 300;
  export function chunkSyllabusText(text: string, opts?: { budget?: number; chunkChars?: number; overlap?: number }): string[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/chunk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  chunkSyllabusText,
  SYLLABUS_CHUNK_CHARS,
  SYLLABUS_CHUNK_OVERLAP,
  SYLLABUS_DIRECT_CHAR_BUDGET,
} from '@/syllabus/chunk';

const lines = (n: number, width = 60): string =>
  Array.from({ length: n }, (_, i) => `Assignment ${i} due Oct ${(i % 28) + 1}`.padEnd(width, '.'))
    .join('\n');

describe('chunkSyllabusText', () => {
  it('keeps text inside the direct budget as one chunk, unchanged', () => {
    const text = lines(10);
    expect(text.length).toBeLessThan(SYLLABUS_DIRECT_CHAR_BUDGET);
    expect(chunkSyllabusText(text)).toEqual([text]);
  });

  it('splits longer text into chunks within the chunk budget', () => {
    const text = lines(400);
    const chunks = chunkSyllabusText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYLLABUS_CHUNK_CHARS + SYLLABUS_CHUNK_OVERLAP);
      expect(chunk.trim()).not.toBe('');
    }
  });

  it('loses no content: the chunks walk the text forward and reach its end', () => {
    const text = lines(400);
    const chunks = chunkSyllabusText(text);

    // Every chunk is a real slice of the text, each starts no later than the
    // previous one ended (so nothing between them is skipped), and the last
    // chunk reaches the end.
    let covered = 0;
    for (const chunk of chunks) {
      const at = text.indexOf(chunk);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, at + chunk.length);
    }
    expect(covered).toBe(text.length);
  });

  it('overlaps consecutive chunks so an item on a boundary is seen whole', () => {
    const text = lines(400);
    const [first, second] = chunkSyllabusText(text);
    const tail = first.slice(-40);
    expect(second.startsWith(tail) || second.includes(tail)).toBe(true);
  });

  it('prefers a newline boundary, so a deadline row is not cut in half', () => {
    const chunks = chunkSyllabusText(lines(400));
    // Every chunk after the first starts at the beginning of a line.
    for (const chunk of chunks.slice(1)) expect(chunk.startsWith('Assignment')).toBe(true);
  });

  it('handles one line longer than the budget without producing empty chunks', () => {
    const chunks = chunkSyllabusText('x'.repeat(10_000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
    expect(chunks.join('').length).toBeGreaterThanOrEqual(10_000);
  });

  it('returns nothing for text with no content', () => {
    expect(chunkSyllabusText('')).toEqual([]);
    expect(chunkSyllabusText('   \n\n  ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/chunk.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/chunk.ts`:

```ts
/**
 * Splitting a syllabus for extraction, by the same character-budget approach as
 * P1's gap analysis (architecture §6.5): text that fits goes in one call, and
 * anything longer is cut into overlapping chunks so an assignment that straddles
 * a boundary is still seen whole by one of them. The extractor dedupes what the
 * overlap reports twice.
 */

export const SYLLABUS_DIRECT_CHAR_BUDGET = 6000;
export const SYLLABUS_CHUNK_CHARS = 3000;
export const SYLLABUS_CHUNK_OVERLAP = 300;

export interface ChunkOptions {
  budget?: number;
  chunkChars?: number;
  overlap?: number;
}

export function chunkSyllabusText(text: string, opts?: ChunkOptions): string[] {
  const budget = opts?.budget ?? SYLLABUS_DIRECT_CHAR_BUDGET;
  const chunkChars = opts?.chunkChars ?? SYLLABUS_CHUNK_CHARS;
  const overlap = Math.min(opts?.overlap ?? SYLLABUS_CHUNK_OVERLAP, Math.floor(chunkChars / 2));

  if (text.trim() === '') return [];
  if (text.length <= budget) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      // Cut on a line boundary when there is one in the last quarter of the
      // chunk; a deadline table's row split in half loses its date.
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + Math.floor(chunkChars * 0.75)) end = newline + 1;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;

    // Step back by the overlap, then forward to the next line start so the next
    // chunk begins on a whole line.
    let next = Math.max(start + 1, end - overlap);
    const lineStart = text.indexOf('\n', next);
    if (lineStart !== -1 && lineStart < end) next = lineStart + 1;
    start = next;
  }
  return chunks.filter((chunk) => chunk.trim() !== '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/chunk.test.ts` → PASS. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/chunk.ts src/syllabus/chunk.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): chunk a long syllabus on P1's character budget

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Prompt registry and the mandatory JSON validator

**Files:**
- Create: `src/syllabus/prompts.ts`, `src/syllabus/assignments.ts`
- Test: `src/syllabus/prompts.test.ts`, `src/syllabus/assignments.test.ts`

**Interfaces:**
- Consumes: `resolveDueDate` from Task 2.
- Produces:
  ```ts
  // prompts.ts
  export interface SyllabusPromptSpec { family: string; promptVersion: string; prompt: string }
  export function getSyllabusPromptFor(model: string): SyllabusPromptSpec;        // syllabus-<family>-v1
  export function getSyllabusVisionPromptFor(model: string): SyllabusPromptSpec;  // syllabus-vision-<family>-v1
  // assignments.ts
  export interface ExtractedAssignment { title: string; dueAt: number | null; rawDate: string; estimatedMinutes: number | null; notes: string }
  export function parseAssignments(value: unknown, ctx: { termStart: number; now: number }): ExtractedAssignment[];
  export function dedupeAssignments(rows: ExtractedAssignment[]): ExtractedAssignment[];
  export function normalizeTitle(title: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getSyllabusPromptFor, getSyllabusVisionPromptFor } from '@/syllabus/prompts';

describe('syllabus prompt registry', () => {
  it('versions a prompt per model family, stably', () => {
    const a = getSyllabusPromptFor('gemma4:12b');
    const b = getSyllabusPromptFor('library/gemma4:27b');
    expect(a.family).toBe('gemma');
    expect(a.promptVersion).toBe('syllabus-gemma-v1');
    // The same family always yields the same version: it is recorded per import.
    expect(b.promptVersion).toBe(a.promptVersion);
    expect(getSyllabusPromptFor('mystery-model').promptVersion).toBe('syllabus-generic-v1');
  });

  it('asks for the JSON array the extractor validates, and nothing else', () => {
    const { prompt } = getSyllabusPromptFor('gemma4:12b');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('title');
    expect(prompt).toContain('dueDate');
    expect(prompt).toContain('estimatedMinutes');
    // J7: deadlines only, no class meetings; and never invent a date.
    expect(prompt.toLowerCase()).toContain('do not invent');
    expect(prompt.toLowerCase()).toMatch(/class meeting|lecture/);
  });

  it('versions the vision prompt separately and asks for text, not JSON', () => {
    const vision = getSyllabusVisionPromptFor('gemma4:12b');
    expect(vision.promptVersion).toBe('syllabus-vision-gemma-v1');
    expect(vision.prompt.toLowerCase()).toContain('text');
    expect(vision.prompt).not.toContain('JSON array');
  });
});
```

Create `src/syllabus/assignments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { dedupeAssignments, parseAssignments } from '@/syllabus/assignments';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const ctx = { termStart: local(2026, 9, 1), now: local(2026, 9, 30) };

describe('parseAssignments', () => {
  it('maps a well-formed array, resolving each date', () => {
    const rows = parseAssignments(
      [
        { title: 'Essay 1', dueDate: 'Oct 15', kind: 'deadline', estimatedMinutes: 180, notes: '5pp' },
        { title: 'Midterm', dueDate: '2026-11-02' },
      ],
      ctx,
    );
    expect(rows).toEqual([
      {
        title: 'Essay 1',
        dueAt: local(2026, 10, 15),
        rawDate: 'Oct 15',
        estimatedMinutes: 180,
        notes: '5pp',
      },
      {
        title: 'Midterm',
        dueAt: local(2026, 11, 2),
        rawDate: '2026-11-02',
        estimatedMinutes: null,
        notes: '',
      },
    ]);
  });

  it('throws when the model did not return an array at all', () => {
    expect(() => parseAssignments({ assignments: [] }, ctx)).toThrow(/array/i);
    expect(() => parseAssignments('Essay 1 due Oct 15', ctx)).toThrow(/array/i);
  });

  it('drops rows with no usable title', () => {
    const rows = parseAssignments(
      [{ dueDate: 'Oct 15' }, { title: '   ', dueDate: 'Oct 15' }, { title: 7 }, null, 'Essay'],
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it('keeps a row whose date is missing or unreadable, with no date', () => {
    const rows = parseAssignments(
      [{ title: 'Final paper', dueDate: 'TBD' }, { title: 'Reading', dueDate: 42 }],
      ctx,
    );
    expect(rows.map((r) => [r.title, r.rawDate, r.dueAt])).toEqual([
      ['Final paper', 'TBD', null],
      ['Reading', '', null],
    ]);
  });

  it('drops a row that is not a deadline (J7)', () => {
    const rows = parseAssignments(
      [
        { title: 'Lecture 3', dueDate: 'Oct 15', kind: 'event' },
        { title: 'Essay 1', dueDate: 'Oct 15', kind: 'deadline' },
      ],
      ctx,
    );
    expect(rows.map((r) => r.title)).toEqual(['Essay 1']);
  });

  it('refuses an estimate that is not a positive finite number', () => {
    const rows = parseAssignments(
      [
        { title: 'A', dueDate: 'Oct 15', estimatedMinutes: 0 },
        { title: 'B', dueDate: 'Oct 15', estimatedMinutes: -30 },
        { title: 'C', dueDate: 'Oct 15', estimatedMinutes: '90' },
        { title: 'D', dueDate: 'Oct 15', estimatedMinutes: Number.NaN },
      ],
      ctx,
    );
    expect(rows.map((r) => r.estimatedMinutes)).toEqual([null, null, null, null]);
  });

  it('ignores unknown fields and trims what it keeps', () => {
    const rows = parseAssignments(
      [{ title: '  Essay 1  ', dueDate: ' Oct 15 ', weight: '20%', notes: 7 }],
      ctx,
    );
    expect(rows[0]).toMatchObject({ title: 'Essay 1', rawDate: 'Oct 15', notes: '' });
  });
});

describe('dedupeAssignments', () => {
  it('collapses the same title and raw date, keeping the first', () => {
    const rows = dedupeAssignments([
      { title: 'Essay 1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: 180, notes: 'full' },
      { title: 'essay  1', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'Essay 2', dueAt: 2, rawDate: 'Oct 22', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Essay 2']);
    expect(rows[0].estimatedMinutes).toBe(180);
  });

  it('keeps two same-titled items with different dates', () => {
    const rows = dedupeAssignments([
      { title: 'Response paper', dueAt: 1, rawDate: 'Oct 15', estimatedMinutes: null, notes: '' },
      { title: 'Response paper', dueAt: 2, rawDate: 'Nov 15', estimatedMinutes: null, notes: '' },
    ]);
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/prompts.test.ts src/syllabus/assignments.test.ts` → FAIL.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/prompts.ts`. Follow `src/transcription/prompts.ts` exactly
in shape (read it first): plain string constants, a family map, a pure getter.

```ts
/**
 * Syllabus prompt registry, keyed by model family - the Phase 1 pattern (D8a).
 * Pure, and versioned, because the version is recorded with what an import
 * produced: the same model must always yield the same version.
 */

export interface SyllabusPromptSpec {
  family: string;
  promptVersion: string;
  prompt: string;
}

const TEXT_RULES = `You are reading a course syllabus. List every assignment the student must hand in or sit.

Return a JSON array. Each element is an object:
- "title": the assignment as the syllabus names it, e.g. "Essay 1", "Midterm exam", "Response paper 3".
- "dueDate": the due date exactly as the syllabus writes it ("Oct 15", "10/15", "Week 5", "TBD"). Copy it verbatim; do not reformat it and do not work out a year.
- "kind": always the string "deadline".
- "estimatedMinutes": a whole number of minutes of work, only if the syllabus states one. Omit it otherwise.
- "notes": a short detail the syllabus gives (length, weighting, format). Omit it if there is none.

Rules:
- Assignments and exams only. Skip class meetings, lectures, readings with no submission, office hours and policies.
- Do not invent anything. If an item has no date in the text, use an empty string for "dueDate". Never guess a date, a year or an estimate.
- One element per assignment. If the same assignment appears twice, list it once.
- If there are no assignments, return [].
- Output JSON only: no commentary, no explanation, no code fences.`;

const GEMMA_TEXT = `${TEXT_RULES}

Syllabus text follows.`;

const GENERIC_TEXT = GEMMA_TEXT;

const VISION_RULES = `Read this image of a page from a course syllabus and write out its text exactly as it appears.

Rules:
- Plain text only, preserving line breaks, so a schedule table stays one item per line.
- Keep dates and assignment names exactly as printed.
- Write [illegible] for anything you cannot read. Never guess at a word.
- Do not summarise, translate, reorder or explain. No commentary, no code fences.

Return the page's text and nothing else.`;

const TEXT_PROMPTS: Record<string, string> = { gemma: GEMMA_TEXT, generic: GENERIC_TEXT };
const VISION_PROMPTS: Record<string, string> = { gemma: VISION_RULES, generic: VISION_RULES };

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/^gemma/, 'gemma'],
  [/^qwen/, 'qwen'],
  [/^(llava|bakllava)/, 'llava'],
  [/^llama/, 'llama'],
];

/** The model family, namespace and tag stripped: `library/gemma4:12b` → `gemma`. */
export function syllabusModelFamily(model: string): string {
  const name = model.toLowerCase().trim().split('/').pop() ?? '';
  const base = name.split(':')[0];
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(base)) return family;
  }
  return 'generic';
}

export function getSyllabusPromptFor(model: string): SyllabusPromptSpec {
  const family = syllabusModelFamily(model);
  return {
    family,
    promptVersion: `syllabus-${family}-v1`,
    prompt: TEXT_PROMPTS[family] ?? GENERIC_TEXT,
  };
}

export function getSyllabusVisionPromptFor(model: string): SyllabusPromptSpec {
  const family = syllabusModelFamily(model);
  return {
    family,
    promptVersion: `syllabus-vision-${family}-v1`,
    prompt: VISION_PROMPTS[family] ?? VISION_RULES,
  };
}
```

Note the `family` for an unknown model is `generic`, and `TEXT_PROMPTS` has no
`qwen`/`llava`/`llama` entry yet, so those fall back to `GENERIC_TEXT` via `??`.
That is intended: one prompt, several recorded versions.

Create `src/syllabus/assignments.ts`:

```ts
import { resolveDueDate } from '@/syllabus/dates';

/** One assignment as extraction understood it (architecture §6.5). */
export interface ExtractedAssignment {
  title: string;
  /** Epoch ms, or null when the text gave no resolvable date. */
  dueAt: number | null;
  /** What the model read, kept for the review table when `dueAt` is null. */
  rawDate: string;
  estimatedMinutes: number | null;
  notes: string;
}

export interface ResolveContext {
  termStart: number;
  now: number;
}

/** Case- and whitespace-insensitive identity of a title, for dedupe and `sourceRef`. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/, '').trim();
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The mandatory `validate` for the extraction call (architecture §6.4: a model's
 * JSON is untrusted input). A non-array is a failure - the model did not answer
 * the question - but a bad row inside a good array is simply dropped, so one
 * malformed entry does not lose a whole syllabus.
 */
export function parseAssignments(value: unknown, ctx: ResolveContext): ExtractedAssignment[] {
  if (!Array.isArray(value)) {
    throw new Error('The model did not return a JSON array of assignments');
  }

  const rows: ExtractedAssignment[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;

    const title = str(row.title);
    if (title === '') continue;

    // J7: this import creates assignment deadlines only. A row the model labelled
    // as something else is not ours to write.
    if (row.kind !== undefined && row.kind !== 'deadline') continue;

    const rawDate = str(row.dueDate);
    const minutes = row.estimatedMinutes;
    rows.push({
      title,
      dueAt: rawDate === '' ? null : resolveDueDate(rawDate, ctx.termStart, ctx.now),
      rawDate,
      estimatedMinutes:
        typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
          ? Math.round(minutes)
          : null,
      notes: str(row.notes),
    });
  }
  return rows;
}

/** Chunks overlap, so the same assignment can be reported twice. First wins. */
export function dedupeAssignments(rows: ExtractedAssignment[]): ExtractedAssignment[] {
  const seen = new Set<string>();
  const out: ExtractedAssignment[] = [];
  for (const row of rows) {
    const key = `${normalizeTitle(row.title)}|${row.rawDate.toLowerCase().trim()}|${row.dueAt ?? 'none'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/prompts.test.ts src/syllabus/assignments.test.ts` → PASS.
`npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/prompts.ts src/syllabus/prompts.test.ts src/syllabus/assignments.ts src/syllabus/assignments.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): prompt registry and the untrusted-JSON validator

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The vision path for scanned pages

**Files:**
- Create: `src/syllabus/vision.ts`
- Test: `src/syllabus/vision.test.ts`

**Interfaces:**
- Consumes: `createOllamaClient`, `isDegenerateOutput`, `stripCodeFence`, `DegenerateOutputError`, `FetchLike` from `@/llm/ollamaClient`; `getSyllabusVisionPromptFor` from Task 4.
- Produces:
  ```ts
  export interface SyllabusPageReader {
    readPage(image: Blob, opts: { model: string; signal?: AbortSignal }): Promise<{ text: string; promptVersion: string }>;
  }
  export function createOllamaPageReader(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; numPredict?: number }): SyllabusPageReader;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/syllabus/vision.test.ts`. Model the fake fetch on
`src/transcription/ollama.test.ts` (read it first for the shape it asserts).

```ts
import { describe, expect, it, vi } from 'vitest';

import { createOllamaPageReader } from '@/syllabus/vision';

interface Body {
  model: string;
  prompt: string;
  images?: string[];
  think?: boolean;
  stream?: boolean;
  options?: { num_predict?: number; temperature?: number };
}

function fetchReturning(response: string) {
  const calls: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ response }), { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const image = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });

describe('createOllamaPageReader', () => {
  it('sends the page image with the versioned vision prompt and the shared guards', async () => {
    const { calls, fetchImpl } = fetchReturning('Essay 1 — due Oct 15\nMidterm — Nov 2');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });

    const result = await reader.readPage(image(), { model: 'gemma4:12b' });

    expect(result.text).toBe('Essay 1 — due Oct 15\nMidterm — Nov 2');
    expect(result.promptVersion).toBe('syllabus-vision-gemma-v1');
    expect(calls[0].images).toHaveLength(1);
    expect(calls[0].images?.[0]).toBe('AQIDBA==');
    expect(calls[0].think).toBe(false);
    expect(calls[0].stream).toBe(false);
    expect(calls[0].options?.temperature).toBe(0);
  });

  it('unwraps a fenced answer', async () => {
    const { fetchImpl } = fetchReturning('```\nEssay 1 due Oct 15\n```');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    await expect(reader.readPage(image(), { model: 'gemma4:12b' })).resolves.toMatchObject({
      text: 'Essay 1 due Oct 15',
    });
  });

  it('refuses degenerate output instead of returning it', async () => {
    const { fetchImpl } = fetchReturning(Array.from({ length: 40 }, () => 'due').join('\n'));
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    await expect(reader.readPage(image(), { model: 'gemma4:12b' })).rejects.toThrow(/degenerate/i);
  });

  it('does not spend a base64 pass on an already-aborted read', async () => {
    const { calls, fetchImpl } = fetchReturning('text');
    const reader = createOllamaPageReader({ baseUrl: 'http://localhost:11434', fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.readPage(image(), { model: 'gemma4:12b', signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/syllabus/vision.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/vision.ts`:

```ts
import {
  createOllamaClient,
  DegenerateOutputError,
  isDegenerateOutput,
  stripCodeFence,
  type FetchLike,
} from '@/llm/ollamaClient';
import { getSyllabusVisionPromptFor } from '@/syllabus/prompts';

/**
 * A scanned syllabus page has no text layer, so it goes through the vision model
 * as OCR (P2-A5): the page's text comes back, and the ordinary JSON extraction
 * path then reads it. One extraction prompt to maintain, and the review table
 * remains the safety net either way.
 *
 * Every guard is the shared one from `src/llm/ollamaClient.ts` - the same ones
 * handwriting transcription uses.
 */
export interface SyllabusPageReader {
  readPage(
    image: Blob,
    opts: { model: string; signal?: AbortSignal },
  ): Promise<{ text: string; promptVersion: string }>;
}

export interface OllamaPageReaderOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  numPredict?: number;
}

/** A syllabus page is denser than a handwritten one, so it gets a larger cap. */
export const DEFAULT_PAGE_NUM_PREDICT = 3000;

const B64_CHUNK = 32 * 1024;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + B64_CHUNK));
  }
  return btoa(binary);
}

export function createOllamaPageReader(opts: OllamaPageReaderOptions): SyllabusPageReader {
  const numPredict = opts.numPredict ?? DEFAULT_PAGE_NUM_PREDICT;
  const client = createOllamaClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    // Names this operation in the timeout and abort messages the user reads.
    label: 'Syllabus page',
  });

  return {
    async readPage(image, { model, signal }) {
      // Checked before encoding: a cancelled import must not spend a base64 pass.
      client.throwIfAborted(signal);
      const { prompt, promptVersion } = getSyllabusVisionPromptFor(model);
      const images = [await blobToBase64(image)];

      const data = await client.generate(
        { model, prompt, images, options: { num_predict: numPredict, temperature: 0 } },
        signal,
      );

      const text = stripCodeFence(data.response ?? '');
      if (isDegenerateOutput(text, data.done_reason)) {
        throw new DegenerateOutputError('Degenerate output: the model repeated itself');
      }
      return { text, promptVersion };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/syllabus/vision.test.ts` → PASS. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/vision.ts src/syllabus/vision.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): read a scanned page through the vision path

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The extractor

**Files:**
- Create: `src/syllabus/extractor.ts`
- Test: `src/syllabus/extractor.test.ts`

**Interfaces:**
- Consumes: `chunkSyllabusText` (Task 3), `parseAssignments`/`dedupeAssignments`/`ExtractedAssignment` (Task 4), `getSyllabusPromptFor` (Task 4), `extractPdfText`/`renderPdfPages` (Task 1), `SyllabusPageReader` (Task 5), `TextGenerator` from `@/llm/ollamaText`.
- Produces:
  ```ts
  export type ExtractProgress =
    | { phase: 'reading-pdf'; page: number; pages: number }
    | { phase: 'reading-page-image'; page: number; pages: number }
    | { phase: 'extracting'; chunk: number; chunks: number };
  export interface ExtractOptions { model: string; signal?: AbortSignal; onProgress?: (p: ExtractProgress) => void }
  export interface SyllabusExtractor {
    fromText(text: string, opts: ExtractOptions): Promise<ExtractedAssignment[]>;
    fromPdf(data: ArrayBuffer, opts: ExtractOptions): Promise<ExtractedAssignment[]>;
  }
  export function createSyllabusExtractor(opts: {
    generator: TextGenerator;
    pageReader?: SyllabusPageReader;
    termStart?: number | null;
    now?: () => number;
    extractText?: typeof extractPdfText;
    renderPages?: typeof renderPdfPages;
    numPredict?: number;
  }): SyllabusExtractor;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/extractor.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { TextGenerator } from '@/llm/ollamaText';
import { SYLLABUS_DIRECT_CHAR_BUDGET } from '@/syllabus/chunk';
import { createSyllabusExtractor, type ExtractProgress } from '@/syllabus/extractor';
import type { SyllabusPageReader } from '@/syllabus/vision';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const TERM = local(2026, 9, 1);
const NOW = local(2026, 9, 30);

/**
 * A fake TextGenerator. `generateJson` runs the caller's own `validate` over
 * canned JSON, which is what makes "bad rows are dropped" a real assertion.
 */
function fakeGenerator(replies: unknown[]) {
  const prompts: string[] = [];
  const generator: TextGenerator = {
    generate: vi.fn(async () => ''),
    generateJson: vi.fn(async (prompt: string, o: { validate: (v: unknown) => unknown }) => {
      prompts.push(prompt);
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return o.validate(reply);
    }),
  } as unknown as TextGenerator;
  return { generator, prompts };
}

const row = (title: string, dueDate: string) => ({ title, dueDate, kind: 'deadline' });

describe('fromText', () => {
  it('makes one call for a short syllabus and drops the rows validate refuses', async () => {
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15'), { dueDate: 'Oct 20' }, row('Lecture', 'Oct 16')],
    ]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    const rows = await extractor.fromText('Essay 1 due Oct 15', { model: 'gemma4:12b' });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Essay 1 due Oct 15');
    // The titleless row is dropped; "Lecture" is kind deadline here so it stays.
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Lecture']);
    expect(rows[0].dueAt).toBe(local(2026, 10, 15));
  });

  it('chunks a long syllabus and dedupes what the overlap reports twice', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    expect(long.length).toBeGreaterThan(SYLLABUS_DIRECT_CHAR_BUDGET);
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15')],
      [row('Essay 1', 'Oct 15'), row('Essay 2', 'Oct 22')],
    ]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    const rows = await extractor.fromText(long, { model: 'gemma4:12b' });

    expect(prompts.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.title)).toEqual(['Essay 1', 'Essay 2']);
  });

  it('fails the whole extraction when one chunk fails, rather than returning part of it', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    const { generator } = fakeGenerator([
      [row('Essay 1', 'Oct 15')],
      new Error('Ollama 500: out of memory'),
    ]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });

    await expect(extractor.fromText(long, { model: 'gemma4:12b' })).rejects.toThrow(
      /out of memory/,
    );
  });

  it('stops before the next chunk when the signal is aborted', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Item ${i} due Oct 15`).join('\n');
    const controller = new AbortController();
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const gen = generator.generateJson as unknown as ReturnType<typeof vi.fn>;
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });
    // Abort as soon as the first call has been made.
    gen.mockImplementationOnce(async (prompt: string, o: { validate: (v: unknown) => unknown }) => {
      prompts.push(prompt);
      controller.abort();
      return o.validate([row('Essay 1', 'Oct 15')]);
    });

    await expect(
      extractor.fromText(long, { model: 'gemma4:12b', signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(prompts).toHaveLength(1);
  });

  it('returns nothing for text with no content, without calling the model', async () => {
    const { generator, prompts } = fakeGenerator([[]]);
    const extractor = createSyllabusExtractor({ generator, termStart: TERM, now: () => NOW });
    await expect(extractor.fromText('   ', { model: 'gemma4:12b' })).resolves.toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  it('resolves no-year dates against now when no term start is set', async () => {
    const { generator } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({ generator, termStart: null, now: () => NOW });
    const [only] = await extractor.fromText('Essay 1', { model: 'gemma4:12b' });
    expect(only.dueAt).toBe(local(2026, 10, 15));
  });
});

describe('fromPdf', () => {
  const pdf = () => new TextEncoder().encode('%PDF').buffer as ArrayBuffer;

  it('sends the PDF’s page text down the same path', async () => {
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Course info', 'Essay 1 due Oct 15'],
    });

    const rows = await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(prompts[0]).toContain('Essay 1 due Oct 15');
    expect(rows.map((r) => r.title)).toEqual(['Essay 1']);
  });

  it('renders a page with no text layer and reads it through the vision path', async () => {
    const readPage = vi.fn(async () => ({ text: 'Essay 2 due Nov 1', promptVersion: 'v' }));
    const pageReader: SyllabusPageReader = { readPage };
    const renderPages = vi.fn(async (_d: ArrayBuffer, pages: number[]) =>
      pages.map(() => new Blob(['png'])),
    );
    const { generator, prompts } = fakeGenerator([
      [row('Essay 1', 'Oct 15'), row('Essay 2', 'Nov 1')],
    ]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Essay 1 due Oct 15', ''],
      renderPages,
    });

    const rows = await extractor.fromPdf(pdf(), { model: 'gemma4:12b' });

    expect(renderPages.mock.calls[0][1]).toEqual([2]);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('Essay 1 due Oct 15');
    expect(prompts[0]).toContain('Essay 2 due Nov 1');
    expect(rows).toHaveLength(2);
  });

  it('skips a scanned page when there is no vision reader, rather than failing', async () => {
    const { generator, prompts } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Essay 1 due Oct 15', ''],
    });

    await expect(extractor.fromPdf(pdf(), { model: 'gemma4:12b' })).resolves.toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it('reports progress for reading, vision and extraction, in order', async () => {
    const seen: ExtractProgress[] = [];
    const { generator } = fakeGenerator([[row('Essay 1', 'Oct 15')]]);
    const extractor = createSyllabusExtractor({
      generator,
      pageReader: { readPage: async () => ({ text: 'Essay 1 due Oct 15', promptVersion: 'v' }) },
      termStart: TERM,
      now: () => NOW,
      extractText: async () => ['Course info here, long enough', ''],
      renderPages: async (_d, pages) => pages.map(() => new Blob(['png'])),
    });

    await extractor.fromPdf(pdf(), {
      model: 'gemma4:12b',
      onProgress: (p) => seen.push(p),
    });

    expect(seen.map((p) => p.phase)).toEqual([
      'reading-pdf',
      'reading-page-image',
      'extracting',
    ]);
    expect(seen[1]).toMatchObject({ page: 2, pages: 2 });
    expect(seen[2]).toMatchObject({ chunk: 1, chunks: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/extractor.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/extractor.ts`:

```ts
import type { TextGenerator } from '@/llm/ollamaText';
import {
  dedupeAssignments,
  parseAssignments,
  type ExtractedAssignment,
} from '@/syllabus/assignments';
import { chunkSyllabusText } from '@/syllabus/chunk';
import { extractPdfText, renderPdfPages } from '@/syllabus/pdfText';
import { getSyllabusPromptFor } from '@/syllabus/prompts';
import type { SyllabusPageReader } from '@/syllabus/vision';

/** What the UI shows while an import is working. */
export type ExtractProgress =
  | { phase: 'reading-pdf'; page: number; pages: number }
  | { phase: 'reading-page-image'; page: number; pages: number }
  | { phase: 'extracting'; chunk: number; chunks: number };

export interface ExtractOptions {
  model: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExtractProgress) => void;
}

/** Architecture §6.5. A PDF and a paste behave identically past the first step. */
export interface SyllabusExtractor {
  fromText(text: string, opts: ExtractOptions): Promise<ExtractedAssignment[]>;
  fromPdf(data: ArrayBuffer, opts: ExtractOptions): Promise<ExtractedAssignment[]>;
}

export interface SyllabusExtractorOptions {
  generator: TextGenerator;
  /** Absent means a scanned page is skipped rather than failing the import. */
  pageReader?: SyllabusPageReader;
  /** Resolves a date with no year. Null means "against today" (P2-A10). */
  termStart?: number | null;
  now?: () => number;
  extractText?: typeof extractPdfText;
  renderPages?: typeof renderPdfPages;
  numPredict?: number;
}

const abortError = (): Error => {
  const err = new Error('Extraction aborted');
  err.name = 'AbortError';
  return err;
};

export function createSyllabusExtractor(opts: SyllabusExtractorOptions): SyllabusExtractor {
  const now = opts.now ?? (() => Date.now());
  const extractText = opts.extractText ?? extractPdfText;
  const renderPages = opts.renderPages ?? renderPdfPages;

  const context = () => {
    const at = now();
    return { termStart: opts.termStart ?? at, now: at };
  };

  async function fromText(text: string, o: ExtractOptions): Promise<ExtractedAssignment[]> {
    const chunks = chunkSyllabusText(text);
    if (chunks.length === 0) return [];

    const ctx = context();
    const { prompt } = getSyllabusPromptFor(o.model);
    const rows: ExtractedAssignment[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      if (o.signal?.aborted) throw abortError();
      o.onProgress?.({ phase: 'extracting', chunk: i + 1, chunks: chunks.length });
      // One chunk's failure fails the import: a partial list presented as the
      // syllabus would silently lose deadlines.
      const parsed = await opts.generator.generateJson(`${prompt}\n\n${chunks[i]}`, {
        model: o.model,
        signal: o.signal,
        numPredict: opts.numPredict,
        // Mandatory (architecture §6.4): the model's JSON is untrusted, and this
        // is what drops the bad rows.
        validate: (value) => parseAssignments(value, ctx),
      });
      rows.push(...parsed);
    }
    return dedupeAssignments(rows);
  }

  async function fromPdf(data: ArrayBuffer, o: ExtractOptions): Promise<ExtractedAssignment[]> {
    const pages = await extractText(data);
    o.onProgress?.({ phase: 'reading-pdf', page: pages.length, pages: pages.length });

    // Pages with no usable text layer are scanned: render and OCR them (P2-A5).
    const scanned = pages.map((text, i) => (text === '' ? i + 1 : 0)).filter((n) => n > 0);
    if (scanned.length > 0 && opts.pageReader) {
      const images = await renderPages(data, scanned);
      for (let i = 0; i < scanned.length; i += 1) {
        if (o.signal?.aborted) throw abortError();
        o.onProgress?.({
          phase: 'reading-page-image',
          page: scanned[i],
          pages: pages.length,
        });
        const { text } = await opts.pageReader.readPage(images[i], {
          model: o.model,
          signal: o.signal,
        });
        pages[scanned[i] - 1] = text;
      }
    }

    return fromText(pages.filter((text) => text.trim() !== '').join('\n\n'), o);
  }

  return { fromText, fromPdf };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/extractor.test.ts` → PASS. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/extractor.ts src/syllabus/extractor.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): extractor over the shared text generator, with a vision fallback

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `sourceRef` and import keys

**Files:**
- Create: `src/syllabus/sourceRef.ts`
- Test: `src/syllabus/sourceRef.test.ts`

**Interfaces:**
- Consumes: `normalizeTitle` from Task 4.
- Produces:
  ```ts
  export function sourceRefFor(importKey: string, a: Pick<ExtractedAssignment, 'title' | 'dueAt'>): string;
  export function importKeyForFile(name: string): string;
  export function importKeyForPastedText(text: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/sourceRef.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { importKeyForFile, importKeyForPastedText, sourceRefFor } from '@/syllabus/sourceRef';

const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
const KEY = 'file:hist101.pdf';

describe('sourceRefFor', () => {
  it('is stable for the same import key and assignment', () => {
    const a = { title: 'Essay 1', dueAt: local(2026, 10, 15) };
    expect(sourceRefFor(KEY, a)).toBe(sourceRefFor(KEY, { ...a }));
    expect(sourceRefFor(KEY, a)).toContain(KEY);
  });

  it('ignores case and whitespace in the title', () => {
    const ref = sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15) });
    expect(sourceRefFor(KEY, { title: '  essay   1 ', dueAt: local(2026, 10, 15) })).toBe(ref);
  });

  it('changes when the title changes (A26)', () => {
    const at = local(2026, 10, 15);
    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: at })).not.toBe(
      sourceRefFor(KEY, { title: 'Essay one', dueAt: at }),
    );
  });

  it('changes when the resolved day changes', () => {
    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15) })).not.toBe(
      sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 16) }),
    );
  });

  it('does not change when only the time of day changes', () => {
    expect(sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15, 9) })).toBe(
      sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15, 23) }),
    );
  });

  it('gives an undated assignment a stable ref of its own', () => {
    const ref = sourceRefFor(KEY, { title: 'Final paper', dueAt: null });
    expect(ref).toBe(sourceRefFor(KEY, { title: 'final paper', dueAt: null }));
    expect(ref).toContain('none');
  });

  it('separates two syllabuses that name an assignment the same', () => {
    const a = { title: 'Essay 1', dueAt: local(2026, 10, 15) };
    expect(sourceRefFor('file:hist101.pdf', a)).not.toBe(sourceRefFor('file:engl210.pdf', a));
  });
});

describe('import keys', () => {
  it('names a file', () => {
    expect(importKeyForFile('HIST 101 syllabus.pdf')).toBe('file:HIST 101 syllabus.pdf');
  });

  it('hashes pasted text, deterministically', () => {
    const text = 'Essay 1 due Oct 15\nMidterm Nov 2';
    expect(importKeyForPastedText(text)).toBe(importKeyForPastedText(text));
    expect(importKeyForPastedText(text)).toMatch(/^pasted:[0-9a-f]+$/);
    expect(importKeyForPastedText(text)).not.toBe(importKeyForPastedText(`${text} `));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/sourceRef.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/sourceRef.ts`:

```ts
import { normalizeTitle, type ExtractedAssignment } from '@/syllabus/assignments';

/**
 * The stable identity of an imported assignment (A26): the import it came from,
 * plus its title and resolved day. Re-importing the same syllabus therefore
 * updates the same events instead of duplicating them, and editing a title on
 * the review screen deliberately creates a new event rather than renaming one.
 *
 * The *day* rather than the instant, so correcting only a due time still updates
 * the event it belongs to.
 */
const pad = (n: number): string => String(n).padStart(2, '0');

const localDayKey = (at: number | null): string => {
  if (at === null) return 'none';
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function sourceRefFor(
  importKey: string,
  a: Pick<ExtractedAssignment, 'title' | 'dueAt'>,
): string {
  return `${importKey}#${normalizeTitle(a.title)}@${localDayKey(a.dueAt)}`;
}

export function importKeyForFile(name: string): string {
  return `file:${name}`;
}

/** FNV-1a: small, dependency-free and stable across builds, which is all this needs. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Pasted text has no file name, so it is identified by its own content (A26). */
export function importKeyForPastedText(text: string): string {
  return `pasted:${fnv1a(text)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/sourceRef.test.ts` → PASS. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/sourceRef.ts src/syllabus/sourceRef.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): stable sourceRef so a re-import updates instead of duplicating

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Writing the confirmed rows

**Files:**
- Create: `src/syllabus/importAssignments.ts`
- Test: `src/syllabus/importAssignments.test.ts`

**Interfaces:**
- Consumes: `createEvent`, `listEvents`, `updateEvent` from `@/storage/events`; `sourceRefFor` (Task 7).
- Produces:
  ```ts
  export interface ConfirmedAssignment { title: string; dueAt: number; allDay: boolean; required: boolean; estimatedMinutes: number; notes: string }
  export interface ImportResult { created: number; updated: number }
  export function importAssignments(rows: ConfirmedAssignment[], importKey: string): Promise<ImportResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/importAssignments.test.ts`. Use `resetDatabase()` from
`@/test/resetDb` in `beforeEach`, the way the other storage-backed tests do
(`src/triage/generateTasks.sync.test.ts` is a good model — read it first).

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { createEvent, listEvents } from '@/storage/events';
import { importAssignments, type ConfirmedAssignment } from '@/syllabus/importAssignments';
import { sourceRefFor } from '@/syllabus/sourceRef';
import { resetDatabase } from '@/test/resetDb';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();

const KEY = 'file:hist101.pdf';

const row = (over?: Partial<ConfirmedAssignment>): ConfirmedAssignment => ({
  title: 'Essay 1',
  dueAt: local(2026, 10, 15),
  allDay: true,
  required: true,
  estimatedMinutes: 180,
  notes: '5 pages',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
});

describe('importAssignments', () => {
  it('writes a deadline that carries the import’s identity', async () => {
    await expect(importAssignments([row()], KEY)).resolves.toEqual({ created: 1, updated: 0 });

    const [event] = await listEvents();
    expect(event).toMatchObject({
      title: 'Essay 1',
      kind: 'deadline',
      source: 'syllabus',
      sourceRef: sourceRefFor(KEY, { title: 'Essay 1', dueAt: local(2026, 10, 15) }),
      startsAt: local(2026, 10, 15),
      allDay: true,
      required: true,
      estimatedMinutes: 180,
      notes: '5 pages',
    });
  });

  it('stores a timed row as not all-day, at its instant', async () => {
    await importAssignments([row({ dueAt: local(2026, 10, 15, 23, 59), allDay: false })], KEY);
    const [event] = await listEvents();
    expect(event.allDay).toBe(false);
    expect(event.startsAt).toBe(local(2026, 10, 15, 23, 59));
  });

  it('updates in place on a re-import instead of duplicating', async () => {
    await importAssignments([row(), row({ title: 'Midterm', dueAt: local(2026, 11, 2) })], KEY);
    const first = await listEvents();

    await expect(
      importAssignments([row({ estimatedMinutes: 240 }), row({ title: 'Midterm', dueAt: local(2026, 11, 2) })], KEY),
    ).resolves.toEqual({ created: 0, updated: 2 });

    const second = await listEvents();
    expect(second).toHaveLength(first.length);
    expect(second.map((e) => e.id).sort()).toEqual(first.map((e) => e.id).sort());
    expect(second.find((e) => e.title === 'Essay 1')?.estimatedMinutes).toBe(240);
  });

  it('creates a new event when the title was edited (A26)', async () => {
    await importAssignments([row()], KEY);
    await expect(importAssignments([row({ title: 'Essay one' })], KEY)).resolves.toEqual({
      created: 1,
      updated: 0,
    });
    expect(await listEvents()).toHaveLength(2);
  });

  it('collapses two rows that share one sourceRef within a single batch', async () => {
    await expect(
      importAssignments([row(), row({ estimatedMinutes: 240 })], KEY),
    ).resolves.toEqual({ created: 1, updated: 1 });

    const events = await listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].estimatedMinutes).toBe(240);
  });

  it('never adopts or modifies a manual event, whatever its title', async () => {
    const manual = await createEvent({
      title: 'Essay 1',
      kind: 'deadline',
      startsAt: local(2026, 10, 15),
      allDay: true,
    });

    await expect(importAssignments([row()], KEY)).resolves.toEqual({ created: 1, updated: 0 });

    const events = await listEvents();
    expect(events).toHaveLength(2);
    const untouched = events.find((e) => e.id === manual.id);
    expect(untouched).toMatchObject({ source: 'manual', sourceRef: null, estimatedMinutes: 60 });
  });

  it('writes nothing for an empty confirmation', async () => {
    await expect(importAssignments([], KEY)).resolves.toEqual({ created: 0, updated: 0 });
    expect(await listEvents()).toEqual([]);
  });

  it('separates two syllabuses that name an assignment the same', async () => {
    await importAssignments([row()], 'file:a.pdf');
    await expect(importAssignments([row()], 'file:b.pdf')).resolves.toEqual({
      created: 1,
      updated: 0,
    });
    expect(await listEvents()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/importAssignments.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/importAssignments.ts`:

```ts
import { createEvent, listEvents, updateEvent } from '@/storage/events';
import { sourceRefFor } from '@/syllabus/sourceRef';

/** One review-table row the user ticked and confirmed. Its date is resolved by definition. */
export interface ConfirmedAssignment {
  title: string;
  dueAt: number;
  allDay: boolean;
  required: boolean;
  estimatedMinutes: number;
  notes: string;
}

export interface ImportResult {
  created: number;
  updated: number;
}

/**
 * Writes the confirmed rows as `kind: 'deadline'`, `source: 'syllabus'` events
 * (J7, architecture §6.5). A row whose `sourceRef` already exists updates that
 * event rather than adding a second one, so re-importing a syllabus is
 * idempotent.
 *
 * It does not generate tasks: `kind: 'deadline'` is all F3's
 * `syncTasksFromCalendar` needs, and the caller runs it afterwards.
 */
export async function importAssignments(
  rows: ConfirmedAssignment[],
  importKey: string,
): Promise<ImportResult> {
  if (rows.length === 0) return { created: 0, updated: 0 };

  const existing = new Map<string, string>();
  for (const event of await listEvents()) {
    // Only this import's own events: a manual event is never adopted (P2-A11).
    if (event.source === 'syllabus' && event.sourceRef !== null) {
      existing.set(event.sourceRef, event.id);
    }
  }

  const result: ImportResult = { created: 0, updated: 0 };
  for (const row of rows) {
    const sourceRef = sourceRefFor(importKey, row);
    const fields = {
      title: row.title,
      kind: 'deadline' as const,
      startsAt: row.dueAt,
      allDay: row.allDay,
      required: row.required,
      estimatedMinutes: row.estimatedMinutes,
      notes: row.notes,
    };

    const found = existing.get(sourceRef);
    if (found !== undefined) {
      await updateEvent(found, fields);
      result.updated += 1;
      continue;
    }
    const created = await createEvent({ ...fields, source: 'syllabus', sourceRef });
    // Two rows in one batch can collapse to one ref; the second must update the
    // first, never create a duplicate.
    existing.set(sourceRef, created.id);
    result.created += 1;
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/importAssignments.test.ts` → PASS. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/importAssignments.ts src/syllabus/importAssignments.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): write confirmed deadlines, updating on a matching sourceRef

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Review-table state

**Files:**
- Create: `src/syllabus/reviewRows.ts`
- Test: `src/syllabus/reviewRows.test.ts`

**Interfaces:**
- Consumes: `parseSyllabusDate` (Task 2), `ExtractedAssignment` (Task 4), `sourceRefFor` (Task 7), `ConfirmedAssignment` (Task 8), `localDateTimeFromInputs`/`toDateInputValue`/`toTimeInputValue` from `@/triage/dates` (read-only; F3 owns that file).
- Produces:
  ```ts
  export interface ReviewRow {
    id: string; title: string; dueDate: string; dueTime: string;
    required: boolean; estimatedMinutes: string; include: boolean;
    rawDate: string; notes: string; existing: boolean; edited: boolean;
  }
  export const DEFAULT_ESTIMATED_MINUTES = 60;
  export function rowsFromExtracted(rows: ExtractedAssignment[], termStart: number, now: number): ReviewRow[];
  export function reresolveRows(rows: ReviewRow[], termStart: number, now: number): ReviewRow[];
  export function markExisting(rows: ReviewRow[], events: readonly CalendarEventRecord[], importKey: string): ReviewRow[];
  export function toConfirmed(rows: readonly ReviewRow[]): ConfirmedAssignment[];
  export function rowDueAt(row: ReviewRow): number | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/reviewRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import {
  markExisting,
  reresolveRows,
  rowsFromExtracted,
  toConfirmed,
  type ReviewRow,
} from '@/syllabus/reviewRows';
import { sourceRefFor } from '@/syllabus/sourceRef';

const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();
const TERM = local(2026, 9, 1);
const NOW = local(2026, 9, 30);

const extracted = (over?: Partial<ExtractedAssignment>): ExtractedAssignment => ({
  title: 'Essay 1',
  dueAt: local(2026, 10, 15),
  rawDate: 'Oct 15',
  estimatedMinutes: 180,
  notes: '',
  ...over,
});

const event = (over: Partial<CalendarEventRecord>): CalendarEventRecord => ({
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
  sourceRef: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('rowsFromExtracted', () => {
  it('includes a dated row, prefilled for editing', () => {
    const [row] = rowsFromExtracted([extracted()], TERM, NOW);
    expect(row).toMatchObject({
      title: 'Essay 1',
      dueDate: '2026-10-15',
      dueTime: '',
      include: true,
      required: true,
      estimatedMinutes: '180',
      existing: false,
    });
  });

  it('carries a stated time into the time field', () => {
    const [row] = rowsFromExtracted(
      [extracted({ rawDate: 'Oct 15 at 11:59pm', dueAt: local(2026, 10, 15, 23, 59) })],
      TERM,
      NOW,
    );
    expect(row).toMatchObject({ dueDate: '2026-10-15', dueTime: '23:59' });
  });

  it('shows an unresolvable date as empty and excludes the row (A27)', () => {
    const [row] = rowsFromExtracted([extracted({ dueAt: null, rawDate: 'TBD' })], TERM, NOW);
    expect(row).toMatchObject({ dueDate: '', dueTime: '', include: false, rawDate: 'TBD' });
  });

  it('leaves an unstated estimate empty rather than inventing one', () => {
    const [row] = rowsFromExtracted([extracted({ estimatedMinutes: null })], TERM, NOW);
    expect(row.estimatedMinutes).toBe('');
  });

  it('gives every row its own id', () => {
    const rows = rowsFromExtracted([extracted(), extracted({ title: 'Essay 2' })], TERM, NOW);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe('reresolveRows', () => {
  it('fixes a no-year row when the term start moves', () => {
    const rows = rowsFromExtracted([extracted({ rawDate: 'January 20', dueAt: null })], TERM, NOW);
    // Against a September term start, "January 20" is next January; it resolved
    // already, so move the term start to prove the rule rather than the parse.
    const moved = reresolveRows(rows, local(2027, 1, 1), NOW);
    expect(moved[0].dueDate).toBe('2027-01-20');
  });

  it('never overwrites a date the user typed', () => {
    const rows = rowsFromExtracted([extracted({ rawDate: 'TBD', dueAt: null })], TERM, NOW);
    const edited: ReviewRow[] = [{ ...rows[0], dueDate: '2026-12-01', edited: true, include: true }];
    expect(reresolveRows(edited, local(2027, 1, 1), NOW)[0].dueDate).toBe('2026-12-01');
  });

  it('leaves a row it still cannot resolve empty and excluded', () => {
    const rows = rowsFromExtracted([extracted({ rawDate: 'Week 5', dueAt: null })], TERM, NOW);
    const after = reresolveRows(rows, local(2027, 1, 1), NOW);
    expect(after[0]).toMatchObject({ dueDate: '', include: false });
  });
});

describe('markExisting', () => {
  it('marks rows that a previous import already wrote', () => {
    const rows = rowsFromExtracted([extracted(), extracted({ title: 'Midterm' })], TERM, NOW);
    const key = 'file:hist101.pdf';
    const events = [
      event({ sourceRef: sourceRefFor(key, { title: 'Essay 1', dueAt: local(2026, 10, 15) }) }),
    ];
    const marked = markExisting(rows, events, key);
    expect(marked.map((r) => r.existing)).toEqual([true, false]);
  });

  it('ignores manual events, and events from another import', () => {
    const rows = rowsFromExtracted([extracted()], TERM, NOW);
    const key = 'file:hist101.pdf';
    const ref = sourceRefFor(key, { title: 'Essay 1', dueAt: local(2026, 10, 15) });
    expect(markExisting(rows, [event({ source: 'manual', sourceRef: ref })], key)[0].existing).toBe(
      false,
    );
    expect(
      markExisting(rows, [event({ sourceRef: sourceRefFor('file:other.pdf', { title: 'Essay 1', dueAt: local(2026, 10, 15) }) })], key)[0]
        .existing,
    ).toBe(false);
  });
});

describe('toConfirmed', () => {
  const base = () => rowsFromExtracted([extracted()], TERM, NOW)[0];

  it('converts an all-day row to local midnight', () => {
    expect(toConfirmed([base()])).toEqual([
      {
        title: 'Essay 1',
        dueAt: local(2026, 10, 15),
        allDay: true,
        required: true,
        estimatedMinutes: 180,
        notes: '',
      },
    ]);
  });

  it('converts a timed row to that instant, not all-day', () => {
    const [row] = toConfirmed([{ ...base(), dueTime: '23:59' }]);
    expect(row).toMatchObject({ dueAt: local(2026, 10, 15, 23, 59), allDay: false });
  });

  it('drops rows that are not ticked', () => {
    expect(toConfirmed([{ ...base(), include: false }])).toEqual([]);
  });

  it('drops a row with no date, so an unresolved row can never be written (A27)', () => {
    expect(toConfirmed([{ ...base(), dueDate: '', include: true }])).toEqual([]);
  });

  it('drops a row whose typed date is not a real day', () => {
    expect(toConfirmed([{ ...base(), dueDate: '2026-02-30' }])).toEqual([]);
    expect(toConfirmed([{ ...base(), dueDate: 'soon' }])).toEqual([]);
  });

  it('drops a row whose title is only whitespace', () => {
    expect(toConfirmed([{ ...base(), title: '   ' }])).toEqual([]);
  });

  it('turns a blank or nonsense estimate into the default, never NaN', () => {
    for (const typed of ['', '   ', 'abc', '-5', '0', '1e999']) {
      const [row] = toConfirmed([{ ...base(), estimatedMinutes: typed }]);
      expect(row.estimatedMinutes).toBe(60);
    }
  });

  it('rounds a fractional estimate and caps an absurd one', () => {
    expect(toConfirmed([{ ...base(), estimatedMinutes: '90.6' }])[0].estimatedMinutes).toBe(91);
    expect(
      toConfirmed([{ ...base(), estimatedMinutes: '99999999' }])[0].estimatedMinutes,
    ).toBeLessThanOrEqual(100_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/reviewRows.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/syllabus/reviewRows.ts`:

```ts
import type { CalendarEventRecord } from '@/storage/types';
import {
  localDateTimeFromInputs,
  toDateInputValue,
  toTimeInputValue,
} from '@/triage/dates';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import { parseSyllabusDate } from '@/syllabus/dates';
import type { ConfirmedAssignment } from '@/syllabus/importAssignments';
import { sourceRefFor } from '@/syllabus/sourceRef';

/**
 * One row of the mandatory review table (A25). Dates and minutes are held as
 * `<input>` strings, because the user is editing them and a half-typed date is
 * not a number; `toConfirmed` is the single place they become a write.
 */
export interface ReviewRow {
  id: string;
  title: string;
  /** `YYYY-MM-DD`, or `''` when nothing could be resolved (A27). */
  dueDate: string;
  /** `HH:MM`, or `''` for an all-day deadline. */
  dueTime: string;
  required: boolean;
  estimatedMinutes: string;
  include: boolean;
  /** What the model read, so a term-start change can re-resolve it. */
  rawDate: string;
  notes: string;
  /** A previous import already wrote this row. */
  existing: boolean;
  /** The user has edited the date, so re-resolution must leave it alone. */
  edited: boolean;
}

/** A14: an unset estimate is 60 minutes. */
export const DEFAULT_ESTIMATED_MINUTES = 60;

/** A guard against a typo of many digits becoming a priority-warping estimate. */
export const MAX_ESTIMATED_MINUTES = 100_000;

function fields(raw: string, termStart: number, now: number): { dueDate: string; dueTime: string } {
  const parsed = raw.trim() === '' ? null : parseSyllabusDate(raw, termStart, now);
  if (parsed === null) return { dueDate: '', dueTime: '' };
  return {
    dueDate: toDateInputValue(parsed.at),
    dueTime: parsed.hasTime ? toTimeInputValue(parsed.at) : '',
  };
}

export function rowsFromExtracted(
  rows: ExtractedAssignment[],
  termStart: number,
  now: number,
): ReviewRow[] {
  return rows.map((row, index) => {
    // Prefer what the row already resolved to, and fall back to reading rawDate
    // so a stated time survives (P2-A6).
    const fromRaw = fields(row.rawDate, termStart, now);
    const dueDate = row.dueAt !== null ? toDateInputValue(row.dueAt) : fromRaw.dueDate;
    const dueTime = row.dueAt !== null ? fromRaw.dueTime : '';
    return {
      id: `row-${index}-${row.title.slice(0, 24)}`,
      title: row.title,
      dueDate,
      dueTime,
      required: true,
      estimatedMinutes: row.estimatedMinutes === null ? '' : String(row.estimatedMinutes),
      // A27: a row with no resolvable date is excluded until it has one.
      include: dueDate !== '',
      rawDate: row.rawDate,
      notes: row.notes,
      existing: false,
      edited: false,
    };
  });
}

/**
 * A new term start re-reads the rows the user has not touched. A row that gains
 * a date becomes includable; one that still has none stays excluded (A27).
 */
export function reresolveRows(rows: ReviewRow[], termStart: number, now: number): ReviewRow[] {
  return rows.map((row) => {
    if (row.edited) return row;
    const next = fields(row.rawDate, termStart, now);
    return { ...row, ...next, include: next.dueDate !== '' };
  });
}

export function markExisting(
  rows: ReviewRow[],
  events: readonly CalendarEventRecord[],
  importKey: string,
): ReviewRow[] {
  const refs = new Set(
    events
      .filter((event) => event.source === 'syllabus' && event.sourceRef !== null)
      .map((event) => event.sourceRef as string),
  );
  return rows.map((row) => ({
    ...row,
    existing: refs.has(sourceRefFor(importKey, { title: row.title, dueAt: rowDueAt(row) })),
  }));
}

/** The instant a row currently means, or null while its date is empty or invalid. */
export function rowDueAt(row: ReviewRow): number | null {
  if (row.dueDate === '') return null;
  return localDateTimeFromInputs(row.dueDate, row.dueTime);
}

function minutes(typed: string): number {
  const value = Number(typed.trim());
  if (typed.trim() === '' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ESTIMATED_MINUTES;
  }
  return Math.min(Math.round(value), MAX_ESTIMATED_MINUTES);
}

/**
 * The rows that may be written. A row that is unticked, untitled, or has no
 * valid date is dropped here - which is what makes "excluded until it has a
 * date" (A27) true of the write and not only of the checkbox.
 */
export function toConfirmed(rows: readonly ReviewRow[]): ConfirmedAssignment[] {
  const out: ConfirmedAssignment[] = [];
  for (const row of rows) {
    if (!row.include) continue;
    const title = row.title.trim();
    if (title === '') continue;
    const dueAt = rowDueAt(row);
    if (dueAt === null) continue;
    out.push({
      title,
      dueAt,
      allDay: row.dueTime === '',
      required: row.required,
      estimatedMinutes: minutes(row.estimatedMinutes),
      notes: row.notes,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/reviewRows.test.ts` → PASS. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/syllabus/reviewRows.ts src/syllabus/reviewRows.test.ts
git commit -m "$(cat <<'EOF'
feat(syllabus): review-row state, with undated rows excluded from the write

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The import UI

**Files:**
- Create: `src/syllabus/ReviewTable.tsx`
- Modify: `src/syllabus/SyllabusImport.tsx` (replace the placeholder body; keep the export name and `aria-label="Syllabus"`)
- Test: `src/syllabus/SyllabusImport.test.tsx`

**Interfaces:**
- Consumes: everything above, plus `getSettingValue`/`setSettingValue` from `@/storage/settingKeys`, `listEvents` from `@/storage/events`, `syncTasksFromCalendar` from `@/triage/generateTasks`, `createOllamaTextGenerator` from `@/llm/ollamaText`, `createOllamaPageReader` from `@/syllabus/vision`, and `Button`/`Input`/`Label` from `@/components/ui/*`.
- Produces:
  ```ts
  export interface SyllabusImportDeps {
    extractorFor(model: string, baseUrl: string, termStart: number | null): SyllabusExtractor;
    importAssignments: typeof importAssignments;
    syncTasks: () => Promise<unknown>;
    listEvents: typeof listEvents;
    getSetting: typeof getSettingValue;
    setSetting: typeof setSettingValue;
    now: () => number;
  }
  export function SyllabusImport(props?: { deps?: Partial<SyllabusImportDeps> }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/syllabus/SyllabusImport.test.tsx`. Follow
`src/app/DeviceStatus.test.tsx` exactly for the harness: `createRoot` + `act`,
`IS_REACT_ACT_ENVIRONMENT`, no @testing-library/react.

```tsx
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalendarEventRecord } from '@/storage/types';
import type { ExtractedAssignment } from '@/syllabus/assignments';
import type { SyllabusExtractor } from '@/syllabus/extractor';
import { SyllabusImport, type SyllabusImportDeps } from '@/syllabus/SyllabusImport';
import { importKeyForPastedText, sourceRefFor } from '@/syllabus/sourceRef';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const NOW = local(2026, 9, 30);

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

async function render(deps: SyllabusImportDeps) {
  await act(async () => {
    root.render(<SyllabusImport deps={deps} />);
  });
}

const byLabel = <T extends HTMLElement>(label: string): T => {
  const found = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no element labelled ${label}; saw: ${container.innerHTML}`);
  return found;
};

const buttonNamed = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').toLowerCase().includes(text.toLowerCase()),
  );
  if (!found) throw new Error(`no button named ${text}; saw: ${container.textContent}`);
  return found as HTMLButtonElement;
};

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const check = async (el: HTMLInputElement, checked: boolean) => {
  await act(async () => {
    el.checked = checked;
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

/** Pastes text and runs the extraction. */
async function extractPasted(h: Harness, text = 'Essay 1 due Oct 15') {
  await type(byLabel<HTMLTextAreaElement>('Syllabus text'), text);
  await click(buttonNamed('Extract'));
}

describe('SyllabusImport', () => {
  it('renders under the mount label the triage view asserts', async () => {
    const h = harness();
    await render(h.deps);
    expect(container.querySelector('section[aria-label="Syllabus"]')).toBeTruthy();
  });

  it('shows the review table and writes nothing until confirmed (A25)', async () => {
    const h = harness();
    await render(h.deps);
    await extractPasted(h);

    expect(container.textContent).toContain('Essay 1');
    expect(h.imported).toEqual([]);
    expect(h.syncs).toBe(0);
  });

  it('writes on confirm, reports the counts, and runs the task sync once', async () => {
    const h = harness();
    await render(h.deps);
    await extractPasted(h);
    await click(buttonNamed('Add'));

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
    expect(container.textContent).toMatch(/created 1/i);
  });

  it('writes once when confirm is clicked twice', async () => {
    const h = harness();
    await render(h.deps);
    await extractPasted(h);
    const confirm = buttonNamed('Add');
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(h.imported).toHaveLength(1);
  });

  it('shows an undated row empty and unticked, and will not write it (A27)', async () => {
    const h = harness({ rows: [assignment({ dueAt: null, rawDate: 'TBD' })] });
    await render(h.deps);
    await extractPasted(h);

    const date = byLabel<HTMLInputElement>('Due date for Essay 1');
    const include = byLabel<HTMLInputElement>('Include Essay 1');
    expect(date.value).toBe('');
    expect(include.checked).toBe(false);
    expect(container.textContent).toMatch(/no date/i);
    expect(buttonNamed('Add').disabled).toBe(true);
  });

  it('includes that row once it is given a date', async () => {
    const h = harness({ rows: [assignment({ dueAt: null, rawDate: 'TBD' })] });
    await render(h.deps);
    await extractPasted(h);

    await type(byLabel<HTMLInputElement>('Due date for Essay 1'), '2026-12-01');
    await check(byLabel<HTMLInputElement>('Include Essay 1'), true);
    await click(buttonNamed('Add'));

    expect(h.imported[0].rows).toEqual([
      expect.objectContaining({ title: 'Essay 1', dueAt: local(2026, 12, 1) }),
    ]);
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

    await render(h.deps);
    await extractPasted(h, text);

    expect(container.textContent).toMatch(/already imported/i);
  });

  it('carries an edited title and estimate into the write', async () => {
    const h = harness();
    await render(h.deps);
    await extractPasted(h);

    await type(byLabel<HTMLInputElement>('Title for Essay 1'), 'Essay one');
    await type(byLabel<HTMLInputElement>('Estimated minutes for Essay one'), '240');
    await click(buttonNamed('Add'));

    expect(h.imported[0].rows[0]).toMatchObject({ title: 'Essay one', estimatedMinutes: 240 });
  });

  it('says so when the syllabus held no assignments, and offers nothing to confirm', async () => {
    const h = harness({ rows: [] });
    await render(h.deps);
    await extractPasted(h);

    expect(container.textContent).toMatch(/no assignments/i);
    expect(buttonNamed('Add').disabled).toBe(true);
    expect(h.imported).toEqual([]);
  });

  it('surfaces an extraction failure and writes nothing', async () => {
    const h = harness({ fail: new Error('Could not reach Ollama at http://localhost:11434') });
    await render(h.deps);
    await extractPasted(h);

    expect(container.textContent).toContain('Could not reach Ollama');
    expect(h.imported).toEqual([]);
  });

  it('loads and persists the term start', async () => {
    const h = harness();
    h.settings['syllabus.termStart'] = local(2026, 9, 1);
    await render(h.deps);

    const termStart = byLabel<HTMLInputElement>('Term start');
    expect(termStart.value).toBe('2026-09-01');

    await type(termStart, '2027-01-11');
    expect(h.settings['syllabus.termStart']).toBe(local(2027, 1, 11));
  });

  it('extracts from a chosen PDF through the PDF path', async () => {
    const h = harness();
    await render(h.deps);

    const picker = byLabel<HTMLInputElement>('Syllabus PDF');
    const file = new File([new Uint8Array([1, 2, 3])], 'hist101.pdf', { type: 'application/pdf' });
    Object.defineProperty(picker, 'files', { value: [file] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(h.fromPdf).toHaveBeenCalledTimes(1);
    expect(h.fromText).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Essay 1');
    await click(buttonNamed('Add'));
    expect(h.imported[0].importKey).toBe('file:hist101.pdf');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/syllabus/SyllabusImport.test.tsx` → FAIL (the
placeholder renders none of these controls).

- [ ] **Step 3: Write `ReviewTable.tsx`**

Create `src/syllabus/ReviewTable.tsx`. Every control carries an `aria-label`
naming its row, which is how the test finds it and how the table is usable at
all without sighted column-scanning.

```tsx
import { Input } from '@/components/ui/input';
import type { ReviewRow } from '@/syllabus/reviewRows';

export interface ReviewTableProps {
  rows: ReviewRow[];
  onChange(id: string, patch: Partial<ReviewRow>): void;
}

/**
 * The mandatory review table (A25): nothing reaches the calendar until the user
 * has seen this and confirmed, even when every row parsed cleanly. A row with no
 * resolvable date shows an empty date and cannot be included until one is typed
 * (A27).
 */
export function ReviewTable({ rows, onChange }: ReviewTableProps) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="p-1">Add</th>
          <th scope="col" className="p-1">Assignment</th>
          <th scope="col" className="p-1">Due</th>
          <th scope="col" className="p-1">Time</th>
          <th scope="col" className="p-1">Required</th>
          <th scope="col" className="p-1">Minutes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-border align-top">
            <td className="p-1">
              <input
                type="checkbox"
                aria-label={`Include ${row.title}`}
                checked={row.include}
                disabled={row.dueDate === ''}
                onChange={(e) => onChange(row.id, { include: e.target.checked })}
              />
            </td>
            <td className="p-1">
              <Input
                aria-label={`Title for ${row.title}`}
                value={row.title}
                onChange={(e) => onChange(row.id, { title: e.target.value })}
              />
              {row.existing && (
                <span className="text-xs text-muted-foreground">Already imported — will update</span>
              )}
              {row.dueDate === '' && (
                <span className="block text-xs text-amber-600">
                  No date{row.rawDate === '' ? '' : ` in "${row.rawDate}"`} — enter one to include it
                </span>
              )}
            </td>
            <td className="p-1">
              <Input
                type="date"
                aria-label={`Due date for ${row.title}`}
                value={row.dueDate}
                onChange={(e) =>
                  onChange(row.id, {
                    dueDate: e.target.value,
                    edited: true,
                    include: e.target.value !== '' && row.include,
                  })
                }
              />
            </td>
            <td className="p-1">
              <Input
                type="time"
                aria-label={`Due time for ${row.title}`}
                value={row.dueTime}
                onChange={(e) => onChange(row.id, { dueTime: e.target.value, edited: true })}
              />
            </td>
            <td className="p-1">
              <input
                type="checkbox"
                aria-label={`Required for ${row.title}`}
                checked={row.required}
                onChange={(e) => onChange(row.id, { required: e.target.checked })}
              />
            </td>
            <td className="p-1">
              <Input
                aria-label={`Estimated minutes for ${row.title}`}
                inputMode="numeric"
                value={row.estimatedMinutes}
                onChange={(e) => onChange(row.id, { estimatedMinutes: e.target.value })}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Rewrite `SyllabusImport.tsx`**

Replace the body of `src/syllabus/SyllabusImport.tsx`. Keep the export name and
the `aria-label="Syllabus"` section. Note the labels the test looks for:
`Syllabus PDF`, `Syllabus text`, `Term start`, and a button whose text contains
"Extract" and one containing "Add".

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createOllamaTextGenerator } from '@/llm/ollamaText';
import { listEvents as listEventsReal } from '@/storage/events';
import { getSettingValue, setSettingValue } from '@/storage/settingKeys';
import type { CalendarEventRecord } from '@/storage/types';
import { toDateInputValue } from '@/triage/dates';
import { syncTasksFromCalendar } from '@/triage/generateTasks';
import { createSyllabusExtractor, type ExtractProgress, type SyllabusExtractor } from '@/syllabus/extractor';
import { importAssignments as importAssignmentsReal } from '@/syllabus/importAssignments';
import { ReviewTable } from '@/syllabus/ReviewTable';
import {
  markExisting,
  reresolveRows,
  rowsFromExtracted,
  toConfirmed,
  type ReviewRow,
} from '@/syllabus/reviewRows';
import { importKeyForFile, importKeyForPastedText } from '@/syllabus/sourceRef';
import { createOllamaPageReader } from '@/syllabus/vision';

/**
 * Everything this component reaches outside itself, in one place, so a test can
 * inject fakes and never touch a model, a PDF or the network (P2-A8).
 */
export interface SyllabusImportDeps {
  extractorFor(model: string, baseUrl: string, termStart: number | null): SyllabusExtractor;
  importAssignments: typeof importAssignmentsReal;
  syncTasks: () => Promise<unknown>;
  listEvents: () => Promise<CalendarEventRecord[]>;
  getSetting: typeof getSettingValue;
  setSetting: typeof setSettingValue;
  now: () => number;
}

const defaultDeps: SyllabusImportDeps = {
  extractorFor: (model, baseUrl, termStart) =>
    createSyllabusExtractor({
      generator: createOllamaTextGenerator({ baseUrl }),
      // Scanned pages go through the same host's vision path (A30: one model).
      pageReader: createOllamaPageReader({ baseUrl }),
      termStart,
    }),
  importAssignments: importAssignmentsReal,
  syncTasks: syncTasksFromCalendar,
  listEvents: listEventsReal,
  getSetting: getSettingValue,
  setSetting: setSettingValue,
  now: () => Date.now(),
};

const progressText = (p: ExtractProgress): string => {
  if (p.phase === 'reading-pdf') return `Read ${p.pages} page${p.pages === 1 ? '' : 's'} of PDF…`;
  if (p.phase === 'reading-page-image') {
    return `Page ${p.page} of ${p.pages} is scanned — reading it with the vision model…`;
  }
  return `Extracting assignments (${p.chunk} of ${p.chunks})…`;
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * P2: a syllabus (PDF or pasted text) becomes assignment deadlines on the
 * calendar, by way of a review table nobody can skip (A25). It lives in the
 * triage view because it feeds the calendar, whose deadlines F3's task sync
 * already turns into tasks - which is why confirming ends with
 * `syncTasksFromCalendar()` rather than any task code of its own.
 */
export function SyllabusImport({ deps }: { deps?: Partial<SyllabusImportDeps> } = {}) {
  const d = useMemo<SyllabusImportDeps>(() => ({ ...defaultDeps, ...deps }), [deps]);

  const [pasted, setPasted] = useState('');
  const [termStart, setTermStart] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [importKey, setImportKey] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setTermStart(await d.getSetting('syllabus.termStart'));
    })();
  }, [d]);

  const confirmable = useMemo(() => (rows === null ? [] : toConfirmed(rows)), [rows]);

  const runExtraction = useCallback(
    async (key: string, run: (extractor: SyllabusExtractor, opts: {
      model: string;
      onProgress: (p: ExtractProgress) => void;
    }) => Promise<Awaited<ReturnType<SyllabusExtractor['fromText']>>>) => {
      setBusy(true);
      setError(null);
      setResult(null);
      setRows(null);
      setProgress('Starting…');
      try {
        const [model, baseUrl, storedTermStart] = await Promise.all([
          d.getSetting('ollama.model'),
          d.getSetting('ollama.baseUrl'),
          d.getSetting('syllabus.termStart'),
        ]);
        const extractor = d.extractorFor(model, baseUrl, storedTermStart);
        const extracted = await run(extractor, {
          model,
          onProgress: (p) => setProgress(progressText(p)),
        });

        const at = d.now();
        const built = rowsFromExtracted(extracted, storedTermStart ?? at, at);
        setRows(markExisting(built, await d.listEvents(), key));
        setImportKey(key);
        setProgress(null);
      } catch (err) {
        setError(errorText(err));
        setProgress(null);
      } finally {
        setBusy(false);
      }
    },
    [d],
  );

  const extractPasted = useCallback(() => {
    const text = pasted;
    if (text.trim() === '') {
      setError('Paste the syllabus text first.');
      return;
    }
    void runExtraction(importKeyForPastedText(text), (extractor, opts) =>
      extractor.fromText(text, opts),
    );
  }, [pasted, runExtraction]);

  const pickPdf = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      void runExtraction(importKeyForFile(file.name), async (extractor, opts) =>
        extractor.fromPdf(await file.arrayBuffer(), opts),
      );
    },
    [runExtraction],
  );

  const changeTermStart = useCallback(
    (value: string) => {
      // An empty control means "resolve against today" (architecture §6.6).
      const at = value === '' ? null : new Date(`${value}T00:00`).getTime();
      const next = at !== null && Number.isNaN(at) ? null : at;
      setTermStart(next);
      void d.setSetting('syllabus.termStart', next);
      const nowMs = d.now();
      setRows((current) =>
        current === null ? current : reresolveRows(current, next ?? nowMs, nowMs),
      );
    },
    [d],
  );

  const patchRow = useCallback(
    (id: string, patch: Partial<ReviewRow>) => {
      setRows((current) => {
        if (current === null) return current;
        const next = current.map((row) => (row.id === id ? { ...row, ...patch } : row));
        // Editing a title or a date changes a row's identity, so what "already
        // imported" means changes with it.
        return next;
      });
    },
    [],
  );

  const confirm = useCallback(() => {
    if (rows === null || importKey === null || writing) return;
    const confirmed = toConfirmed(rows);
    if (confirmed.length === 0) return;
    setWriting(true);
    void (async () => {
      try {
        const { created, updated } = await d.importAssignments(confirmed, importKey);
        // F3 already turns deadlines into tasks; P2 only asks it to run.
        await d.syncTasks();
        setResult(`Created ${created}, updated ${updated}.`);
        setRows(null);
        setError(null);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setWriting(false);
      }
    })();
  }, [d, importKey, rows, writing]);

  return (
    <section aria-label="Syllabus" className="rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">Syllabus</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Import a syllabus as assignment deadlines. Nothing is added to the calendar until you
        confirm it below.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="block text-muted-foreground">Term start</span>
          <Input
            type="date"
            aria-label="Term start"
            value={termStart === null ? '' : toDateInputValue(termStart)}
            onChange={(e) => changeTermStart(e.target.value)}
          />
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground">PDF</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            aria-label="Syllabus PDF"
            disabled={busy}
            onChange={(e) => pickPdf(e.target.files?.[0])}
            className="text-sm"
          />
        </label>
      </div>

      <div className="mt-3">
        <label className="text-xs text-muted-foreground" htmlFor="syllabus-paste">
          …or paste the syllabus text
        </label>
        <textarea
          id="syllabus-paste"
          aria-label="Syllabus text"
          rows={4}
          value={pasted}
          disabled={busy}
          onChange={(e) => setPasted(e.target.value)}
          className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
        />
        <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={extractPasted}>
          Extract assignments
        </Button>
      </div>

      {progress !== null && <p className="mt-2 text-xs text-muted-foreground">{progress}</p>}
      {error !== null && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {result !== null && <p className="mt-2 text-xs text-muted-foreground">{result}</p>}

      {rows !== null && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Review before adding</h3>
          {rows.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No assignments were found in that syllabus.
            </p>
          ) : (
            <ReviewTable rows={rows} onChange={patchRow} />
          )}
          <Button
            className="mt-3"
            size="sm"
            disabled={confirmable.length === 0 || writing}
            onClick={confirm}
          >
            Add {confirmable.length} to calendar
          </Button>
        </div>
      )}
    </section>
  );
}
```

Two details the tests will catch, so handle them while writing:

- The "no assignments" case must still render an **Add** button (disabled), and
  the undated-row case must render one too — the tests read `.disabled`.
- Double-click protection must not rely on `writing` state having re-rendered:
  guard with a ref (`writingRef.current`) as well as the state, because two
  clicks dispatched inside one `act` both see the pre-render state. Add:

```ts
  const writingRef = useRef(false);
  // …in confirm(), before anything else:
  if (writingRef.current) return;
  writingRef.current = true;
  // …in the finally:
  writingRef.current = false;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/syllabus/SyllabusImport.test.tsx` → PASS.
Then the whole suite: `npx vitest run` → 769 + all new tests pass, including
`src/triage/TriageView.test.tsx` (the `aria-label="Syllabus"` mount assertion).
Then `npx tsc -b` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/syllabus/SyllabusImport.tsx src/syllabus/ReviewTable.tsx src/syllabus/SyllabusImport.test.tsx
git commit -m "$(cat <<'EOF'
feat(syllabus): import UI with the mandatory review table

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Whole-feature verification

**Files:**
- Modify: `docs/architecture.md` only if §6.5 disagrees with what shipped (the code wins; the doc gets updated to match). Keep the edit to §6.5's P2 block.

- [ ] **Step 1: Build**

Run: `npm run build`. Expected: succeeds.

- [ ] **Step 2: Confirm the pdf worker is still bundled locally, with no CDN reference**

```bash
ls dist/assets | grep -i pdf.worker
grep -rEl 'cdnjs|unpkg|jsdelivr|cdn\.' dist/ || echo 'no CDN references'
```
Expected: a `pdf.worker*.mjs` asset exists, and no CDN host appears.

- [ ] **Step 3: Full test run and typecheck**

```bash
npx vitest run
npx tsc -b
```
Expected: every test passes (769 existing plus this feature's); tsc silent.

- [ ] **Step 4: Lint the touched files**

```bash
npx eslint src/syllabus
```
Expected: no new errors.

- [ ] **Step 5: Commit any doc correction**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: record what P2 shipped against §6.5

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
