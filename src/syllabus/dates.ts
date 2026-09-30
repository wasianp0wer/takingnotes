/**
 * Turning what a syllabus says into an instant, or into nothing (architecture
 * §6.5, spec-phase2 P2). A date this cannot read resolves to `null` and the
 * review table asks the user (A27) - it is never guessed. A wrong date is
 * worse than no date: it is written to the calendar on confirm, so every
 * ambiguous shape below is resolved in favor of `null` over a guess.
 *
 * Everything is local time, through `Date` setters, so a DST boundary cannot
 * shift a deadline by an hour.
 */

export interface ParsedSyllabusDate {
  /** Epoch ms. Local midnight when the text stated no time. */
  at: number;
  hasTime: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Local midnight of a calendar day, or null when that day does not exist. */
function localDay(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // `Date` silently rolls 30 February over to March; that is a mis-date, not a date.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.getTime();
}

const fullYear = (raw: string): number => {
  const n = Number(raw);
  return raw.length <= 2 ? 2000 + n : n;
};

/**
 * The year for a date that stated none: the earliest year that puts it on or
 * after the term start's local day (P2-A2). A January date on a syllabus whose
 * term starts in September belongs to the next year.
 */
function yearFromTermStart(month: number, day: number, termStart: number): number | null {
  const base = new Date(startOfLocalDay(termStart));
  for (const year of [base.getFullYear(), base.getFullYear() + 1]) {
    const at = localDay(year, month, day);
    if (at !== null && at >= startOfLocalDay(termStart)) return year;
  }
  // A 29 February that exists in neither candidate year.
  return null;
}

interface DayMatch {
  year: number | null;
  month: number;
  day: number;
}

/**
 * The first date shape that matches. Day-first is tried before month-first
 * (fix C1): month-first's day group is unbounded on its right, so against
 * "15 October 2026" it used to eat the leading "20" of "2026" as the day and
 * leave "26" to be misread as a two-digit year, resolving to 20 Oct 2026
 * instead of 15 Oct 2026. Trying day-first first means that shape is read
 * correctly before month-first ever gets a chance to misparse it, and every
 * day/year capture below is additionally followed by `(?!\d)` so it can never
 * match only part of a longer run of digits.
 */
function matchDay(text: string): DayMatch | null {
  // 2026-10-15 / 2026/10/15
  const iso = /(\d{4})[-/](\d{1,2})(?!\d)[-/](\d{1,2})(?!\d)/.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };

  // 15 October 2026 / 15 Oct
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b\\.?(?:\\s*,?\\s*(\\d{4}|\\d{2})(?!\\d)\\b)?`,
  ).exec(text);
  if (dayFirst) {
    return {
      year: dayFirst[3] === undefined ? null : fullYear(dayFirst[3]),
      month: MONTHS[dayFirst[2]],
      day: Number(dayFirst[1]),
    };
  }

  // October 15th, 2026 / Oct. 15 2026 / Oct 15
  const monthFirst = new RegExp(
    `\\b(${MONTH_NAMES})\\b\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}|\\d{2})(?!\\d)\\b)?`,
  ).exec(text);
  if (monthFirst) {
    return {
      year: monthFirst[3] === undefined ? null : fullYear(monthFirst[3]),
      month: MONTHS[monthFirst[1]],
      day: Number(monthFirst[2]),
    };
  }

  // 10/15/2026 / 10/15/26 / 10/15 - month first (P2-A1). Slash only (fix C3):
  // a dot or dash more often marks a section number or page range ("3.4",
  // "10-15") than a date, and the spec's table lists only the slash form.
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/.exec(text);
  if (numeric) {
    return {
      year: numeric[3] === undefined ? null : fullYear(numeric[3]),
      month: Number(numeric[1]),
      day: Number(numeric[2]),
    };
  }

  return null;
}

interface TimeMatch {
  /** Minutes past local midnight. */
  minutes: number;
  /** The matched span, so the caller can cut it out before reading the date. */
  start: number;
  end: number;
}

/**
 * `11:59pm`, `5 PM`, `17:00`. Skips a shape that isn't a real time and keeps
 * scanning, so an impossible time earlier in the string does not hide a real
 * one later (e.g. "at 25:99 or 17:00" still finds 17:00).
 */
function matchTime(text: string): TimeMatch | null {
  const twelve = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g;
  for (let m = twelve.exec(text); m !== null; m = twelve.exec(text)) {
    let hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      if (m[3] === 'am' && hour === 12) hour = 0;
      if (m[3] === 'pm' && hour !== 12) hour += 12;
      return { minutes: hour * 60 + minute, start: m.index, end: m.index + m[0].length };
    }
  }

  const twentyFour = /\b(\d{1,2}):(\d{2})\b/g;
  for (let m = twentyFour.exec(text); m !== null; m = twentyFour.exec(text)) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour <= 23 && minute <= 59) {
      return { minutes: hour * 60 + minute, start: m.index, end: m.index + m[0].length };
    }
  }

  return null;
}

/**
 * Blanks out numeric dates (same length, so offsets still line up) before the
 * time search, so "10/15" is never misread as a time (fix C2/C3).
 */
function maskNumericDates(text: string): string {
  return text
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, (m) => ' '.repeat(m.length))
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, (m) => ' '.repeat(m.length));
}

/**
 * Reads a syllabus date. `termStart` fixes the year for a date that stated none;
 * `now` is used only for the relative words (P2-A3).
 *
 * The time is found first, against a copy with numeric dates blanked out, and
 * its own matched span is then cut out of the text before the date is read
 * (fix C2): matching in the other order let a clock time's digits be misread
 * as the date's day or year ("Oct 15, 11:59pm" used to resolve as 15 Oct
 * *2011*, reading "11" as the year).
 */
export function parseSyllabusDate(
  raw: string,
  termStart: number,
  now: number,
): ParsedSyllabusDate | null {
  const text = raw.toLowerCase().trim();
  if (text === '') return null;

  const time = matchTime(maskNumericDates(text));
  const dateText = time === null ? text : text.slice(0, time.start) + text.slice(time.end);

  let day: number | null = null;
  if (/\btoday\b/.test(text)) day = startOfLocalDay(now);
  else if (/\btomorrow\b/.test(text)) {
    const d = new Date(startOfLocalDay(now));
    d.setDate(d.getDate() + 1);
    day = d.getTime();
  } else {
    const found = matchDay(dateText);
    if (!found) return null;
    const year = found.year ?? yearFromTermStart(found.month, found.day, termStart);
    if (year === null) return null;
    day = localDay(year, found.month, found.day);
    if (day === null) return null;
  }

  if (time === null) return { at: day, hasTime: false };

  const withTime = new Date(day);
  withTime.setHours(Math.floor(time.minutes / 60), time.minutes % 60, 0, 0);
  return { at: withTime.getTime(), hasTime: true };
}

/** Architecture §6.5: the instant, or `null` when the text gave no resolvable date. */
export function resolveDueDate(raw: string, termStart: number, now: number): number | null {
  return parseSyllabusDate(raw, termStart, now)?.at ?? null;
}
