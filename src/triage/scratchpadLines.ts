/** A single line of scratchpad text and its offsets within the full text. */
export interface LineRange {
  text: string;
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's last character (excludes the '\n'). */
  end: number;
}

/**
 * Finds the line containing `cursor`, clamping `cursor` to `[0, text.length]`.
 *
 * `cursor === 0` is special-cased: `text.lastIndexOf('\n', -1)` would inspect
 * index 0 of `text` (negative fromIndex clamps to 0) rather than reporting
 * "no newline found", which would misplace `start` when `text` begins with
 * a newline.
 */
export function lineAtCursor(text: string, cursor: number): LineRange {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const start = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end === -1) end = text.length;
  return { text: text.slice(start, end), start, end };
}

/**
 * Removes the line described by `range` along with one adjacent newline
 * (the one following it, or if there is none, the one preceding it). The
 * returned cursor is where the removed line started, clamped to the new
 * text's length.
 */
export function removeLine(text: string, range: LineRange): { text: string; cursor: number } {
  const hasFollowingNewline = text[range.end] === '\n';
  const removeStart = hasFollowingNewline ? range.start : Math.max(0, range.start - 1);
  const removeEnd = hasFollowingNewline ? range.end + 1 : range.end;
  const next = text.slice(0, removeStart) + text.slice(removeEnd);
  return { text: next, cursor: Math.min(range.start, next.length) };
}

const LINE_PREFIX = /^\s*(?:(?:[-*•+]|\d+[.)])\s+)?(?:\[[ xX]?\]\s+)?/;

/** Strips a leading bullet/checkbox marker and trims, for scratchpad → task titles. */
export function taskTitleFromLine(line: string): string {
  return line.replace(LINE_PREFIX, '').trim();
}
