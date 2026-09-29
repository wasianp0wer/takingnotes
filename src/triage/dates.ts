/**
 * Local-time day math for the triage center. Everything goes through `Date`
 * setters so a DST day (23 h or 25 h) is still exactly one day; adding
 * 86 400 000 ms would drift by an hour twice a year.
 */

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** All-day items are due at the end of their local day (architecture §2.2). */
export function endOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Same wall-clock time `days` calendar days later (or earlier). */
export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

/**
 * Weeks (Sunday first) covering `month` (0-11) of `year`. Each cell is local
 * midnight. Only weeks that contain a day of the month are included (4-6 rows).
 */
export function monthGrid(year: number, month: number): number[][] {
  const offset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const weeks: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const week: number[] = [];
    for (let c = 0; c < 7; c += 1) {
      week.push(new Date(year, month, 1 - offset + r * 7 + c).getTime());
    }
    weeks.push(week);
  }
  return weeks;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeInputValue(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Parses `<input type="date">` / `<input type="time">` values as local time.
 * An empty time means local midnight. Returns null for anything invalid,
 * including dates that `Date` would silently roll over (2026-02-30).
 */
export function localDateTimeFromInputs(date: string, time: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])];
  let h = 0;
  let mi = 0;
  if (time !== '') {
    const tm = /^(\d{2}):(\d{2})$/.exec(time);
    if (!tm) return null;
    h = Number(tm[1]);
    mi = Number(tm[2]);
    if (h > 23 || mi > 59) return null;
  }
  const result = new Date(y, mo, d, h, mi);
  if (result.getFullYear() !== y || result.getMonth() !== mo || result.getDate() !== d) return null;
  return result.getTime();
}
