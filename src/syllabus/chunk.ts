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
