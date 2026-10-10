export type TagFilterMode = 'and' | 'or';

/**
 * S5-K37: AND narrows to notes carrying every selected tag, OR widens to any.
 * `tags` and `selected` are assumed already normalized (both ultimately come
 * from `tagsOf` / the vocabulary) - this is a plain membership check, not a
 * second normalization pass.
 */
export function matchesTagFilter(
  tags: readonly string[],
  selected: readonly string[],
  mode: TagFilterMode,
): boolean {
  if (selected.length === 0) return true;
  return mode === 'and'
    ? selected.every((tag) => tags.includes(tag))
    : selected.some((tag) => tags.includes(tag));
}
