import type { HuionPenPoint } from '@/utils/huionBLE';
import type { PageStroke } from '@/storage/types';

export interface SegmentResult {
  closed: PageStroke | null;
  changed: boolean;
}

export interface StrokeSegmenter {
  push(point: HuionPenPoint, t: number): SegmentResult;
  /** Open stroke (live reference is fine; callers copy). */
  current(): PageStroke | null;
  /** Force-close; null when idle. */
  end(): PageStroke | null;
}

export const DEFAULT_MAX_GAP_MS = 500;

function isDown(point: HuionPenPoint): boolean {
  return point.status > 0 && point.pressure > 0;
}

export function createStrokeSegmenter(opts?: { maxGapMs?: number }): StrokeSegmenter {
  const maxGapMs = opts?.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  let open: PageStroke | null = null;

  function closeOpen(): PageStroke {
    const stroke = open as PageStroke;
    open = null;
    return stroke;
  }

  return {
    push(point, t) {
      const down = isDown(point);

      if (!down) {
        if (!open) return { closed: null, changed: false };
        return { closed: closeOpen(), changed: true };
      }

      const stored = { x: point.x, y: point.y, pressure: point.pressure, t };

      if (!open) {
        open = { points: [stored], startedAt: t, endedAt: t };
        return { closed: null, changed: true };
      }

      const lastPoint = open.points[open.points.length - 1];
      if (t - lastPoint.t > maxGapMs) {
        const closed = closeOpen();
        open = { points: [stored], startedAt: t, endedAt: t };
        return { closed, changed: true };
      }

      open.points.push(stored);
      open.endedAt = t;
      return { closed: null, changed: true };
    },

    current() {
      return open;
    },

    end() {
      if (!open) return null;
      return closeOpen();
    },
  };
}
