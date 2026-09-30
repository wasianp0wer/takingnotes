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
