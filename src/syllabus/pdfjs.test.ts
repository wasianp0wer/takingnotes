import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadPdfjs,
  PDF_WORKER_URL,
  pdfSupportProbe,
  resetPdfjsForTests,
} from '@/syllabus/pdfjs';

/**
 * pdf.js itself is not exercised here: it would pull ~1 MB into every test run
 * and needs a real Worker. What this pins is the wiring - the worker URL is the
 * locally bundled asset, the module is loaded once and on demand, and the probe
 * releases the document. The library really opening a PDF is covered by the
 * build check (`npm run build`, then no CDN host in `dist/`).
 */
const hooks = vi.hoisted(() => ({
  workerSrc: '',
  getDocument: vi.fn(),
  destroy: vi.fn(async () => {}),
  /** How often the module was configured, which is once per real load. */
  configured: 0,
}));

vi.mock('pdfjs-dist', () => {
  return {
    version: '6.3.289',
    GlobalWorkerOptions: {
      get workerSrc() {
        return hooks.workerSrc;
      },
      set workerSrc(value: string) {
        hooks.workerSrc = value;
        hooks.configured += 1;
      },
    },
    getDocument: hooks.getDocument,
  };
});

beforeEach(() => {
  resetPdfjsForTests();
  hooks.workerSrc = '';
  hooks.configured = 0;
  hooks.destroy.mockClear();
  hooks.getDocument.mockReset();
  hooks.getDocument.mockImplementation((params: { data: Uint8Array }) => ({
    promise: Promise.resolve({ numPages: params.data.byteLength > 0 ? 1 : 0 }),
    destroy: hooks.destroy,
  }));
});

describe('pdf.js wiring', () => {
  it('serves the worker from the bundle, never a CDN', () => {
    expect(PDF_WORKER_URL).toBeTruthy();
    expect(PDF_WORKER_URL).not.toMatch(/^https?:\/\//);
    expect(PDF_WORKER_URL).toContain('pdf.worker');
  });

  it('points pdf.js at that worker on load', async () => {
    await loadPdfjs();
    expect(hooks.workerSrc).toBe(PDF_WORKER_URL);
  });

  it('loads the module once, however often it is asked for', async () => {
    const [first, second] = await Promise.all([loadPdfjs(), loadPdfjs()]);
    await loadPdfjs();

    expect(first).toBe(second);
    // The module is imported once and configured once, however many callers ask.
    expect(hooks.configured).toBe(1);
  });

  it('opens an in-memory PDF and reports what pdf.js read', async () => {
    await expect(pdfSupportProbe()).resolves.toEqual({ version: '6.3.289', pages: 1 });

    const params = hooks.getDocument.mock.calls[0][0] as { data: Uint8Array };
    expect(new TextDecoder().decode(params.data)).toMatch(/^%PDF-1\.4/);
  });

  it('releases the document even when opening it fails', async () => {
    hooks.getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error('not a PDF')),
      destroy: hooks.destroy,
    }));

    await expect(pdfSupportProbe()).rejects.toThrow('not a PDF');
    expect(hooks.destroy).toHaveBeenCalledTimes(1);
  });
});
