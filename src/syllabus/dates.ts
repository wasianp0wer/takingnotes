/**
 * Turning what a syllabus says into an instant, or into nothing (architecture
 * §6.5, spec-phase2 P2). A date this cannot read resolves to `null` and the
 * review table asks the user (A27) - it is never guessed.
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
    if (at !== null && at >= startOfLocalDay(termStart)) return at === null ? null : year;
  }
  // A 29 February that exists in neither candidate year.
  return null;
}

interface DayMatch {
  year: number | null;
  month: number;
  day: number;
}

/** The first date shape that matches, tried longest-first so a year is not missed. */
function matchDay(text: string): DayMatch | null {
  // 2026-10-15 / 2026/10/15
  const iso = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };

  // October 15th, 2026 / Oct. 15 2026 / Oct 15
  const monthFirst = new RegExp(
    `\\b(${MONTH_NAMES})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}|\\d{2})\\b)?`,
  ).exec(text);
  if (monthFirst) {
    return {
      year: monthFirst[3] === undefined ? null : fullYear(monthFirst[3]),
      month: MONTHS[monthFirst[1]],
      day: Number(monthFirst[2]),
    };
  }

  // 15 October 2026 / 15 Oct
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b\\.?(?:\\s*,?\\s*(\\d{4}|\\d{2})\\b)?`,
  ).exec(text);
  if (dayFirst) {
    return {
      year: dayFirst[3] === undefined ? null : fullYear(dayFirst[3]),
      month: MONTHS[dayFirst[2]],
      day: Number(dayFirst[1]),
    };
  }

  // 10/15/2026 / 10/15/26 / 10/15 - month first (P2-A1).
  const numeric = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?\b/.exec(text);
  if (numeric) {
    return {
      year: numeric[3] === undefined ? null : fullYear(numeric[3]),
      month: Number(numeric[1]),
      day: Number(numeric[2]),
    };
  }

  return null;
}

/** `11:59pm`, `5 PM`, `17:00`. Returns minutes past local midnight, or null. */
function matchTime(text: string): number | null {
  const twelve = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (twelve[3] === 'am' && hour === 12) hour = 0;
    if (twelve[3] === 'pm' && hour !== 12) hour += 12;
    return hour * 60 + minute;
  }
  const twentyFour = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }
  return null;
}

/**
 * Reads a syllabus date. `termStart` fixes the year for a date that stated none;
 * `now` is used only for the relative words (P2-A3).
 */
export function parseSyllabusDate(
  raw: string,
  termStart: number,
  now: number,
): ParsedSyllabusDate | null {
  const text = raw.toLowerCase().trim();
  if (text === '') return null;

  let day: number | null = null;
  if (/\btoday\b/.test(text)) day = startOfLocalDay(now);
  else if (/\btomorrow\b/.test(text)) {
    const d = new Date(startOfLocalDay(now));
    d.setDate(d.getDate() + 1);
    day = d.getTime();
  } else {
    const found = matchDay(text);
    if (!found) return null;
    const year = found.year ?? yearFromTermStart(found.month, found.day, termStart);
    if (year === null) return null;
    day = localDay(year, found.month, found.day);
    if (day === null) return null;
  }

  // The date's own digits must not be read back as a time: strip what matched.
  const timeText = text.replace(/\b\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{2,4})?\b/g, ' ');
  const minutes = matchTime(timeText);
  if (minutes === null) return { at: day, hasTime: false };

  const withTime = new Date(day);
  withTime.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return { at: withTime.getTime(), hasTime: true };
}

/** Architecture §6.5: the instant, or `null` when the text gave no resolvable date. */
export function resolveDueDate(raw: string, termStart: number, now: number): number | null {
  return parseSyllabusDate(raw, termStart, now)?.at ?? null;
}
