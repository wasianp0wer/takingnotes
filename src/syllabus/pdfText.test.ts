import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PAGE_LONG_EDGE,
  extractPdfText,
  PAGE_TEXT_MIN_CHARS,
  renderPdfPages,
} from '@/syllabus/pdfText';
import { resetPdfjsForTests } from '@/syllabus/pdfjs';

interface FakeItem {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * A text item with geometry, the way pdf.js reports one: `transform[4]`/`[5]` are
 * x/y, and `width` is how far the run reaches from `x`.
 */
const at = (str: string, x: number, y: number, width: number, height = 12): FakeItem => ({
  str,
  width,
  height,
  transform: [height, 0, 0, height, x, y],
});

const hooks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(async () => {}),
  cleanup: vi.fn(),
  /** Which pages the fake was actually asked to render, in order. */
  rendered: [] as number[],
}));

/** A canvas stand-in that records the size it is asked for. */
const canvasRecording = (sizes: Array<[number, number]>) => (w: number, h: number) => {
  sizes.push([w, h]);
  return {
    canvas: {},
    context: {},
    toBlob: () => Promise.resolve(new Blob([`${w}x${h}`], { type: 'image/png' })),
  };
};

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
          // The width carries the page number, so rendering the wrong page shows up
          // in the canvas size; 800 is the long edge on every page.
          getViewport: ({ scale }: { scale: number }) => ({
            width: (600 + n) * scale,
            height: 800 * scale,
            scale,
          }),
          render: () => {
            hooks.rendered.push(n);
            return { promise: Promise.resolve() };
          },
          cleanup: hooks.cleanup,
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
  hooks.cleanup.mockClear();
  hooks.rendered.length = 0;
  hooks.getDocument.mockReset();
});

describe('extractPdfText', () => {
  it('returns one string per page, in page order', async () => {
    fakeDoc([[{ str: 'Essay 1 is due on October 15' }], [{ str: 'Midterm exam is on November 2' }]]);
    await expect(extractPdfText(bytes())).resolves.toEqual([
      'Essay 1 is due on October 15',
      'Midterm exam is on November 2',
    ]);
  });

  it('joins a page’s items and turns EOL markers into newlines', async () => {
    fakeDoc([[{ str: 'Essay 1 due Oct 15', hasEOL: true }, { str: 'Essay 2 due Nov 1' }]]);
    const [page] = await extractPdfText(bytes());
    expect(page).toBe('Essay 1 due Oct 15\nEssay 2 due Nov 1');
  });

  it('starts a new line where y changes, even with no EOL markers', async () => {
    // pdf.js does not set hasEOL reliably. Without geometry this table collapses to
    // one line and a later per-line date match reads Oct 15 against Essay 2.
    fakeDoc([
      [
        at('Week 1', 50, 700, 40),
        at('Essay 1', 150, 700, 45),
        at('Oct 15', 300, 700, 40),
        at('Week 2', 50, 680, 40),
        at('Essay 2', 150, 680, 45),
        at('Nov 1', 300, 680, 35),
      ],
    ]);
    const [page] = await extractPdfText(bytes());
    expect(page.split('\n')).toEqual(['Week 1 Essay 1 Oct 15', 'Week 2 Essay 2 Nov 1']);
    // Each row's date stays with its own row.
    expect(page.split('\n')[0]).not.toContain('Nov 1');
    expect(page.split('\n')[1]).not.toContain('Oct 15');
  });

  it('joins runs split mid-word, and only spaces items with a real gap', async () => {
    // pdf.js splits a run on a font change or kerning. A blanket space would make
    // "Sept" + "ember 15" into "Sept ember 15", which matches no date at all.
    fakeDoc([
      [
        at('Essay 1 due', 50, 700, 60),
        at('Sept', 120, 700, 20),
        at('ember 15', 140, 700, 45),
      ],
    ]);
    const [page] = await extractPdfText(bytes());
    expect(page).toBe('Essay 1 due September 15');
    expect(page).not.toContain('Sept ember');
  });

  it('still breaks the line on hasEOL when the items carry geometry', async () => {
    fakeDoc([
      [
        { ...at('Essay 1 due Oct 15', 50, 700, 90), hasEOL: true },
        at('Essay 2 due Nov 1', 50, 700, 90),
      ],
    ]);
    const [page] = await extractPdfText(bytes());
    expect(page).toBe('Essay 1 due Oct 15\nEssay 2 due Nov 1');
  });

  it('releases each page’s parsed content as it goes', async () => {
    fakeDoc([[{ str: 'Essay 1 is due on October 15' }], [{ str: 'Midterm is November 2' }]]);
    await extractPdfText(bytes());
    expect(hooks.cleanup).toHaveBeenCalledTimes(2);
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
  });

  it('treats a scan whose only text layer is a running footer as scanned', async () => {
    // The reason the floor is where it is (P2-A4): counting this as a text layer
    // would keep the page from the vision model and lose its assignments.
    fakeDoc([[{ str: 'Page 3 of 9' }]]);
    await expect(extractPdfText(bytes())).resolves.toEqual(['']);
  });

  it('pins the floor: one character short blanks, the floor itself survives', async () => {
    // P2-A4 fixes the floor at 16; the pages either side of it are built from it.
    expect(PAGE_TEXT_MIN_CHARS).toBe(16);
    const short = 'x'.repeat(PAGE_TEXT_MIN_CHARS - 1);
    const exact = 'y'.repeat(PAGE_TEXT_MIN_CHARS);
    fakeDoc([[{ str: short }], [{ str: exact }]]);
    await expect(extractPdfText(bytes())).resolves.toEqual(['', exact]);
  });

  it('destroys the document even when a page rejects', async () => {
    fakeDoc([[{ str: 'x' }], [{ str: 'y' }]], { failPage: 2 });
    await expect(extractPdfText(bytes())).rejects.toThrow('bad page');
    expect(hooks.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the original cause when releasing the worker also fails', async () => {
    // Why the call failed is what reaches the user; a failing destroy must not
    // replace it with a message about the worker.
    fakeDoc([[{ str: 'x' }], [{ str: 'y' }]], { failPage: 2 });
    hooks.destroy.mockRejectedValueOnce(new Error('worker gone'));
    await expect(extractPdfText(bytes())).rejects.toThrow('bad page');
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
    // Real pdf.js transfers the bytes to its worker, which DETACHES the buffer it
    // was handed. The fake does the same, so this fails unless each open gets its
    // own copy: a second pass would then be slicing a detached buffer. Identities
    // are recorded before the detach, since a detached view cannot be read after.
    const passed: Array<{ data: unknown; buffer: unknown }> = [];
    hooks.getDocument.mockImplementation((params: { data: Uint8Array }) => {
      const handed = params.data.buffer as ArrayBuffer;
      passed.push({ data: params.data, buffer: handed });
      structuredClone(handed, { transfer: [handed] });
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: () =>
            Promise.resolve({
              getTextContent: () =>
                Promise.resolve({ items: [{ str: 'Page one text here' }] }),
            }),
        }),
        destroy: hooks.destroy,
      };
    });

    const buffer = bytes();
    await extractPdfText(buffer);
    // Throws unless the first pass handed pdf.js a copy of the caller's bytes.
    await extractPdfText(buffer);

    expect(passed).toHaveLength(2);
    // Each open got its own bytes, and neither got the caller's own buffer.
    expect(passed[0].data === passed[1].data).toBe(false);
    expect(passed[0].buffer === buffer).toBe(false);
    expect(passed[1].buffer === buffer).toBe(false);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});

describe('renderPdfPages', () => {
  it('renders only the requested pages, at the requested long edge', async () => {
    fakeDoc([[{ str: 'a' }], [{ str: 'b' }], [{ str: 'c' }]]);
    const sizes: Array<[number, number]> = [];
    const blobs = await renderPdfPages(bytes(), [2, 3], {
      longEdge: 400,
      makeCanvas: canvasRecording(sizes),
    });
    expect(blobs).toHaveLength(2);
    // Page n's viewport is (600 + n) x 800, so a long edge of 400 gives scale 0.5 and
    // a width that names the page: rendering [1, 2] instead of [2, 3] fails here.
    expect(sizes).toEqual([[301, 400], [302, 400]]);
    expect(hooks.rendered).toEqual([2, 3]);
    // One cleanup per rendered page, and none for the page never asked for.
    expect(hooks.cleanup).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default long edge', async () => {
    fakeDoc([[{ str: 'a' }]]);
    const sizes: Array<[number, number]> = [];
    await renderPdfPages(bytes(), [1], { makeCanvas: canvasRecording(sizes) });
    expect(DEFAULT_PAGE_LONG_EDGE).toBe(1400);
    // Page 1's viewport is 601x800; the 800 tall edge becomes the default long edge.
    expect(sizes).toEqual([[1052, 1400]]);
  });

  it('throws on a page the document does not have, rather than skipping it', async () => {
    // A skip would shorten the array and misalign it with `pageNumbers`, pairing
    // one page's image with another page's text.
    fakeDoc([[{ str: 'a' }], [{ str: 'b' }]]);
    await expect(
      renderPdfPages(bytes(), [1, 5], {
        makeCanvas: () => ({
          canvas: {},
          context: {},
          toBlob: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
        }),
      }),
    ).rejects.toThrow(/page 5.*2 pages/i);
    expect(hooks.destroy).toHaveBeenCalledTimes(1);
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
