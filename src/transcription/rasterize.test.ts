import { describe, expect, it, vi } from 'vitest';
import {
  defaultCanvasFactory,
  drawStrokes,
  rasterGeometry,
  renderPage,
  strokeWidth,
  type CanvasFactory,
  type InkContext,
  type PageDims,
} from '@/transcription/rasterize';
import type { PageStroke } from '@/storage/types';
import {
  HUION_DEFAULT_PAGE_HEIGHT_A5,
  HUION_DEFAULT_PAGE_WIDTH_A5,
} from '@/utils/huionProtocol';

const A5: PageDims = {
  pageWidth: HUION_DEFAULT_PAGE_WIDTH_A5,
  pageHeight: HUION_DEFAULT_PAGE_HEIGHT_A5,
};

/**
 * A recording mock of InkContext: property sets and method calls are all
 * pushed into `calls` in order, so tests can assert on drawing geometry
 * without a real canvas (happy-dom has none).
 */
function createRecordingCtx(): { ctx: InkContext; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const props: Record<string, unknown> = {};
  const settable = ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin'] as const;
  const methods = ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill'] as const;

  const ctx = {} as Record<string, unknown>;
  for (const prop of settable) {
    Object.defineProperty(ctx, prop, {
      enumerable: true,
      get: () => props[prop],
      set: (value: unknown) => {
        props[prop] = value;
        calls.push(['set', prop, value]);
      },
    });
  }
  for (const method of methods) {
    ctx[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
    };
  }

  return { ctx: ctx as unknown as InkContext, calls };
}

function point(x: number, y: number, pressure: number, t?: number) {
  return t === undefined ? { x, y, pressure } : { x, y, pressure, t };
}

describe('rasterGeometry', () => {
  it('sizes a portrait page (A5) to the requested long edge', () => {
    expect(rasterGeometry(A5, 1024)).toEqual({ width: 772, height: 1024 });
  });

  it('sizes a landscape page to the requested long edge', () => {
    expect(rasterGeometry({ pageWidth: 2000, pageHeight: 1000 }, 1024)).toEqual({
      width: 1024,
      height: 512,
    });
  });

  it('falls back to A5 dimensions when dims are null', () => {
    expect(rasterGeometry({ pageWidth: null, pageHeight: null }, 1024)).toEqual(
      rasterGeometry(A5, 1024),
    );
  });

  it('falls back to A5 dimensions when dims are <= 0', () => {
    expect(rasterGeometry({ pageWidth: 0, pageHeight: -5 }, 1024)).toEqual(
      rasterGeometry(A5, 1024),
    );
  });

  it('honours a smaller long edge', () => {
    expect(rasterGeometry(A5, 768)).toEqual({ width: 579, height: 768 });
  });
});

describe('strokeWidth', () => {
  it('computes the minimum width at pressure 0', () => {
    expect(strokeWidth(0, 1024)).toBeCloseTo(1.2288, 6);
  });

  it('computes the maximum width at pressure 1', () => {
    expect(strokeWidth(1, 1024)).toBeCloseTo(4.096, 6);
  });

  it('is monotonic in pressure', () => {
    expect(strokeWidth(0.25, 1024)).toBeLessThan(strokeWidth(0.75, 1024));
  });

  it('doubles with a doubled long edge', () => {
    expect(strokeWidth(0.5, 2048)).toBeCloseTo(strokeWidth(0.5, 1024) * 2, 6);
  });

  it('clamps pressure above 1', () => {
    expect(strokeWidth(5, 1024)).toBeCloseTo(strokeWidth(1, 1024), 6);
  });

  it('clamps pressure below 0', () => {
    expect(strokeWidth(-5, 1024)).toBeCloseTo(strokeWidth(0, 1024), 6);
  });
});

describe('drawStrokes', () => {
  const size = { width: 772, height: 1024 };

  it('fills the background white before drawing ink', () => {
    const { ctx, calls } = createRecordingCtx();

    drawStrokes(ctx, [], size);

    expect(calls[0]).toEqual(['set', 'fillStyle', '#ffffff']);
    expect(calls[1]).toEqual(['fillRect', 0, 0, 772, 1024]);
  });

  it('draws no ink for an empty stroke list', () => {
    const { ctx, calls } = createRecordingCtx();

    drawStrokes(ctx, [], size);

    expect(calls.some((c) => c[0] === 'stroke' || c[0] === 'arc' || c[0] === 'fill')).toBe(
      false,
    );
  });

  it('sets black ink style with round caps/joins', () => {
    const { ctx, calls } = createRecordingCtx();

    drawStrokes(ctx, [], size);

    expect(calls).toContainEqual(['set', 'strokeStyle', '#000000']);
    expect(calls).toContainEqual(['set', 'fillStyle', '#000000']);
    expect(calls).toContainEqual(['set', 'lineCap', 'round']);
    expect(calls).toContainEqual(['set', 'lineJoin', 'round']);
  });

  it('draws a multi-point stroke as a sequence of segments', () => {
    const { ctx, calls } = createRecordingCtx();
    const stroke: PageStroke = {
      points: [point(0.5, 0.5, 0.5), point(0.6, 0.5, 0.5), point(0.6, 0.6, 0.5)],
    };

    drawStrokes(ctx, [stroke], size);

    const strokeCalls = calls.filter((c) => c[0] === 'stroke');
    expect(strokeCalls).toHaveLength(2);

    const moveToCalls = calls.filter((c) => c[0] === 'moveTo');
    expect(moveToCalls[0]).toEqual(['moveTo', 386, 512]);

    const lineToCalls = calls.filter((c) => c[0] === 'lineTo');
    expect(lineToCalls[0]).toEqual(['lineTo', 463.2, 512]);
  });

  it('draws a single-point stroke as a filled dot', () => {
    const { ctx, calls } = createRecordingCtx();
    const stroke: PageStroke = { points: [point(0.5, 0.5, 1)] };

    drawStrokes(ctx, [stroke], size);

    const arcCalls = calls.filter((c) => c[0] === 'arc');
    expect(arcCalls).toHaveLength(1);
    const [, cx, cy, radius, start, end] = arcCalls[0];
    expect(cx).toBe(386);
    expect(cy).toBe(512);
    expect(radius).toBeCloseTo(strokeWidth(1, 1024) / 2, 6);
    expect(start).toBe(0);
    expect(end).toBeCloseTo(Math.PI * 2, 6);

    const fillCalls = calls.filter((c) => c[0] === 'fill');
    expect(fillCalls).toHaveLength(1);
  });

  it('draws an empty-points stroke as nothing (no crash, no draw calls beyond style)', () => {
    const { ctx, calls } = createRecordingCtx();
    const stroke: PageStroke = { points: [] };

    drawStrokes(ctx, [stroke], size);

    expect(calls.some((c) => c[0] === 'stroke' || c[0] === 'arc')).toBe(false);
  });

  it('works with legacy points that have no t', () => {
    const { ctx, calls } = createRecordingCtx();
    const stroke: PageStroke = {
      points: [point(0.1, 0.1, 0.2), point(0.2, 0.2, 0.4)],
    };

    expect(() => drawStrokes(ctx, [stroke], size)).not.toThrow();
    expect(calls.some((c) => c[0] === 'stroke')).toBe(true);
  });
});

describe('renderPage', () => {
  it('renders with a fake factory and returns the blob it produced', async () => {
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    const { ctx } = createRecordingCtx();
    const getContext = vi.fn(() => ctx);
    const toBlob = vi.fn(async () => blob);
    const factory: CanvasFactory = vi.fn(() => ({
      getContext,
      toBlob,
    }));

    const result = await renderPage([], A5, 1024, factory);

    expect(factory).toHaveBeenCalledWith(772, 1024);
    expect(getContext).toHaveBeenCalledWith('2d');
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ blob, width: 772, height: 1024 });
  });

  it('rejects when the canvas has no 2d context', async () => {
    const factory: CanvasFactory = () => ({
      getContext: () => null,
      toBlob: async () => new Blob(),
    });

    await expect(renderPage([], A5, 1024, factory)).rejects.toThrow();
  });
});

describe('defaultCanvasFactory', () => {
  it('is a function usable as a CanvasFactory', () => {
    expect(typeof defaultCanvasFactory).toBe('function');
  });
});
