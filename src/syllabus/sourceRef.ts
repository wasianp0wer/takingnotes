import { normalizeTitle, type ExtractedAssignment } from '@/syllabus/assignments';
import { localDayKey } from '@/syllabus/day';

/**
 * The stable identity of an imported assignment (A26): the import it came from,
 * plus its title and resolved day. Re-importing the same syllabus therefore
 * updates the same events instead of duplicating them, and editing a title on
 * the review screen deliberately creates a new event rather than renaming one.
 *
 * The *day* rather than the instant, so correcting only a due time still updates
 * the event it belongs to.
 */
/** `day.ts` holds the day itself, shared with `dedupeAssignments` so the two agree. */
const dayPart = (at: number | null): string => (at === null ? 'none' : localDayKey(at));

/** FNV-1a: small, dependency-free and stable across builds, which is all this needs. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Escapes only the `%`, `#` and `@` characters (`%` first, so the escaping
 * itself can't be mistaken for original content) so a `#` or `@` occurring
 * inside the import key or the title can never be read as a component
 * boundary. Everything else is left as-is, so the ref stays readable for
 * debugging - this is not a general URI-encode, which would also escape
 * characters like `:` that are common and harmless in a file-based import key.
 */
const escapePart = (s: string): string =>
  s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/@/g, '%40');

export function sourceRefFor(
  importKey: string,
  a: Pick<ExtractedAssignment, 'title' | 'dueAt'>,
): string {
  const normalized = normalizeTitle(a.title);
  // A punctuation-only title (e.g. "..." or "---") normalizes to '', which
  // would otherwise collide with every other such title on the same day and
  // import. Fall back to a hash of the raw title so those stay distinct.
  const titleKey = normalized === '' ? `empty-${fnv1a(a.title)}` : normalized;
  return `${escapePart(importKey)}#${escapePart(titleKey)}@${dayPart(a.dueAt)}`;
}

/** FNV-1a over raw bytes, matching `fnv1a`'s behaviour for ASCII input. */
function fnv1aBytes(data: ArrayBuffer): string {
  const view = new Uint8Array(data);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i += 1) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Identified by content as well as name: two courses both handing out a
 * `syllabus.pdf` would otherwise share one import key, so importing the second
 * would silently update the first one's events instead of adding its own.
 *
 * The name is kept after the hash purely so the ref stays readable when
 * debugging. A content change therefore yields a new key, which is why
 * re-importing an edited syllabus adds events rather than updating them
 * (`docs/features/p2-spec.md` L1, accepted).
 */
export function importKeyForFile(name: string, content: ArrayBuffer): string {
  return `file:${fnv1aBytes(content)}:${name}`;
}

/** Pasted text has no file name, so it is identified by its own content (A26). */
export function importKeyForPastedText(text: string): string {
  return `pasted:${fnv1a(text)}`;
}
