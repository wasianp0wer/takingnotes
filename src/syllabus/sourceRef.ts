import { normalizeTitle, type ExtractedAssignment } from '@/syllabus/assignments';

/**
 * The stable identity of an imported assignment (A26): the import it came from,
 * plus its title and resolved day. Re-importing the same syllabus therefore
 * updates the same events instead of duplicating them, and editing a title on
 * the review screen deliberately creates a new event rather than renaming one.
 *
 * The *day* rather than the instant, so correcting only a due time still updates
 * the event it belongs to.
 */
const pad = (n: number): string => String(n).padStart(2, '0');

const localDayKey = (at: number | null): string => {
  if (at === null) return 'none';
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function sourceRefFor(
  importKey: string,
  a: Pick<ExtractedAssignment, 'title' | 'dueAt'>,
): string {
  return `${importKey}#${normalizeTitle(a.title)}@${localDayKey(a.dueAt)}`;
}

export function importKeyForFile(name: string): string {
  return `file:${name}`;
}

/** FNV-1a: small, dependency-free and stable across builds, which is all this needs. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Pasted text has no file name, so it is identified by its own content (A26). */
export function importKeyForPastedText(text: string): string {
  return `pasted:${fnv1a(text)}`;
}
