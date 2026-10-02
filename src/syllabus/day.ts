/**
 * The one definition of "the same day" this feature uses.
 *
 * Local time, through `Date` getters, so a deadline near a DST boundary cannot
 * drift into the neighbouring day. It is shared rather than duplicated because
 * two modules decide whether two readings are the same assignment -
 * `dedupeAssignments` on the review screen and `sourceRefFor` at the write - and
 * they must never disagree: a second copy of this function would let them drift
 * apart and reopen that bug silently.
 */
const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in local time. */
export function localDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
