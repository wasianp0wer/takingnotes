import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useCaptureEngine } from '@/capture/CaptureContext';
import type { PageStroke } from '@/storage/types';
import { useThemes } from '@/themes/ThemeProvider';
import { drawStrokes, rasterGeometry, type PageDims } from '@/transcription/rasterize';

/** Canvas long edge in CSS-independent pixels; the element scales to its column. */
const CANVAS_LONG_EDGE = 1024;

export interface InkCanvasProps {
  /** Stored strokes of a finished page. Ignored when `live`. */
  strokes?: readonly PageStroke[];
  /** Draw the page being written: the engine's live strokes, redrawn as they change. */
  live?: boolean;
  dims: PageDims;
}

/**
 * The page as ink in the active theme's canvas colours. Shares `drawStrokes`
 * geometry with the transcription rasterizer, but the colours differ by
 * design: the OCR raster is always black on white (`RASTER_INK`).
 */
export function InkCanvas({ strokes, live = false, dims }: InkCanvasProps) {
  const engine = useCaptureEngine();
  const { active } = useThemes();
  const background = active.colors['canvas-bg'];
  const ink = active.colors.ink;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { pageWidth, pageHeight } = dims;
  const size = useMemo(
    () => rasterGeometry({ pageWidth, pageHeight }, CANVAS_LONG_EDGE),
    [pageWidth, pageHeight],
  );

  const draw = useCallback(
    (toDraw: readonly PageStroke[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      // happy-dom (and a browser that refuses a context) returns null. Nothing
      // to draw on is not an error - the rest of the view still works.
      if (!ctx) return;
      drawStrokes(ctx, toDraw, size, { background, ink });
    },
    [size, background, ink],
  );

  useEffect(() => {
    if (live) return;
    draw(strokes ?? []);
  }, [live, strokes, draw]);

  useEffect(() => {
    if (!live) return;
    let frame: number | null = null;
    const paint = () => {
      frame = null;
      draw(engine.getLiveStrokes());
    };
    paint();
    // One redraw per animation frame: a pen delivers points far faster than the
    // display can show them, and drawing per point would drop frames.
    const unsubscribe = engine.subscribeInk(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(paint);
    });
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [live, engine, draw]);

  return (
    <canvas
      ref={canvasRef}
      width={size.width}
      height={size.height}
      aria-label="Page ink"
      className="w-full h-auto max-h-[75vh] object-contain bg-canvas"
    />
  );
}
