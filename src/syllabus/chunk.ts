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
  // A floor of 1: chunkChars <= 0 would make every raw chunk empty, and the
  // empty-chunk filter below would then silently drop the whole syllabus.
  const chunkChars = Math.max(1, opts?.chunkChars ?? SYLLABUS_CHUNK_CHARS);
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

    // Step back by roughly the overlap, snapped BACKWARDS to a line start, so
    // the next chunk begins on a whole line. Searching backwards matters
    // (fix I4): searching forward from `end - overlap` could land back on the
    // very newline `end` had just snapped to, collapsing the overlap to zero
    // at every boundary whenever lines are longer than the overlap - exactly
    // the case the overlap exists to protect (an item straddling a boundary
    // would then be seen whole by neither chunk). A line start that lies too
    // far back - one very long line - is ignored in favor of a plain
    // character step, both to keep the overlap a real size and so the walk
    // cannot stall advancing by a single character per iteration.
    const target = end - overlap;
    const lineStart = text.lastIndexOf('\n', target);
    let next = lineStart + 1;
    if (lineStart === -1 || next <= start || end - next > overlap * 2) next = target;
    start = Math.max(next, start + 1);
  }
  return chunks.filter((chunk) => chunk.trim() !== '');
}
