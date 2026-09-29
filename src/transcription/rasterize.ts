import type { PageStroke } from '@/storage/types';
import {
  HUION_DEFAULT_PAGE_HEIGHT_A5,
  HUION_DEFAULT_PAGE_WIDTH_A5,
} from '@/utils/huionProtocol';

/** A page's logical size in device units, as recorded on capture. */
export interface PageDims {
  pageWidth: number | null;
  pageHeight: number | null;
}

/** A raster canvas size in pixels. */
export interface RasterSize {
  width: number;
  height: number;
}

/**
 * The subset of CanvasRenderingContext2D that ink drawing needs. Both
 * CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D satisfy
 * this structurally, and a recording mock can satisfy it in tests without a
 * real canvas.
 */
export type InkContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'arc'
  | 'fill'
>;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Computes the pixel size to render a page at, scaling its aspect ratio to
 * fit the requested long edge. Falls back to the Huion A5 default when dims
 * are missing or non-positive.
 */
export function rasterGeometry(dims: PageDims, longEdge: number): RasterSize {
  const w =
    dims.pageWidth != null && dims.pageWidth > 0
      ? dims.pageWidth
      : HUION_DEFAULT_PAGE_WIDTH_A5;
  const h =
    dims.pageHeight != null && dims.pageHeight > 0
      ? dims.pageHeight
      : HUION_DEFAULT_PAGE_HEIGHT_A5;

  if (h >= w) {
    return { width: Math.round((longEdge * w) / h), height: longEdge };
  }
  return { width: longEdge, height: Math.round((longEdge * h) / w) };
}

/** Ink stroke width in pixels, scaled by long edge and clamped pressure. */
export function strokeWidth(pressure: number, longEdge: number): number {
  return longEdge * (0.0012 + 0.0028 * clamp01(pressure));
}

/** Draws normalized (0-1) strokes as black ink on a white background. */
export function drawStrokes(
  ctx: InkContext,
  strokes: readonly PageStroke[],
  size: RasterSize,
): void {
  const { width, height } = size;
  const longEdge = Math.max(width, height);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    const points = stroke.points;
    if (points.length === 1) {
      const p = points[0];
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, strokeWidth(p.pressure, longEdge) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      ctx.beginPath();
      ctx.lineWidth = strokeWidth((a.pressure + b.pressure) / 2, longEdge);
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }
  }
}

/** A rendered page: a PNG blob plus the pixel dimensions it was drawn at. */
export interface RenderedPage {
  blob: Blob;
  width: number;
  height: number;
}

/** A canvas-like factory the rasterizer can draw into and read a PNG blob from. */
export type CanvasFactory = (
  w: number,
  h: number,
) => {
  getContext(type: '2d'): InkContext | null;
  toBlob(): Promise<Blob>;
};

/**
 * Default canvas factory: prefers OffscreenCanvas (available in workers and
 * modern browsers), falling back to a hidden document canvas.
 */
export const defaultCanvasFactory: CanvasFactory = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return {
      getContext: (type) => canvas.getContext(type) as InkContext | null,
      toBlob: () => canvas.convertToBlob({ type: 'image/png' }),
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return {
    getContext: (type) => canvas.getContext(type) as InkContext | null,
    toBlob: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('canvas.toBlob produced no blob'));
        }, 'image/png');
      }),
  };
};

/** Renders a finished page's strokes to a PNG blob, ready for a vision model. */
export async function renderPage(
  strokes: readonly PageStroke[],
  dims: PageDims,
  longEdge: number,
  factory: CanvasFactory = defaultCanvasFactory,
): Promise<RenderedPage> {
  const size = rasterGeometry(dims, longEdge);
  const canvas = factory(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not obtain a 2d canvas context');
  }
  drawStrokes(ctx, strokes, size);
  const blob = await canvas.toBlob();
  return { blob, width: size.width, height: size.height };
}
