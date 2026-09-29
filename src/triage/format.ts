/**
 * Human-facing date/time formatting for the triage center. All values are
 * epoch ms rendered in local time; see `dates.ts` for the day math these
 * build on.
 */

import { addLocalDays, endOfLocalDay, startOfLocalDay } from '@/triage/dates';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDayLabel(ms: number, now: number): string {
  const day = startOfLocalDay(ms);
  const today = startOfLocalDay(now);
  if (day === today) return 'Today';
  if (day === addLocalDays(today, 1)) return 'Tomorrow';
  if (day === addLocalDays(today, -1)) return 'Yesterday';
  const d = new Date(ms);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/**
 * Due-date label for the triage list: day label, plus a time unless the
 * moment is exactly the end of its local day (all-day items), prefixed
 * `Overdue · ` when it has already passed.
 */
export function formatDue(dueAt: number | null, now: number): string {
  if (dueAt === null) return 'No due date';
  const label = formatDayLabel(dueAt, now);
  const text = dueAt === endOfLocalDay(dueAt) ? label : `${label} ${formatTime(dueAt)}`;
  return dueAt < now ? `Overdue · ${text}` : text;
}

export function formatMonthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month]} ${year}`;
}
