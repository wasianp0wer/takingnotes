/**
 * Pattern matcher for Find: plain case-insensitive substring, or a
 * case-insensitive regular expression.
 *
 * Regex safety (a hostile or careless pattern must never freeze the tab) is
 * two layers, both applied before any text is tested:
 *   1. A length cap, `MAX_PATTERN_LENGTH`.
 *   2. A nested-repetition rejection. After `new RegExp` accepts the pattern,
 *      `isRiskyPattern` walks it once, tracking group depth on a stack,
 *      and rejects a *quantified group whose body itself contains a
 *      quantifier or an alternation* - the shape behind catastrophic
 *      backtracking: `(a+)+$`, `(a*)*`, `(\w+\s?)+$`, `(a|aa)+`.
 *      The scanner treats `\x` escapes and `[...]` classes as literals (parens
 *      and quantifiers inside them mean nothing), skips the prefix of
 *      non-capturing, lookaround and named groups, and counts `*`, `+`,
 *      `{n,}`, `{n,m}` (m >= 2) and `{n}` (n >= 2) as repeats. A plain `?`
 *      after a group is fine.
 *   3. A cap of `MAX_UNBOUNDED_QUANTIFIERS` unbounded quantifiers (`*`, `+`,
 *      `{n,}`) in the whole pattern, which stops group-less blow-ups such as
 *      `.*.*.*.*z`.
 * A pattern that passes can still be slow on a huge text; `regexRunner.ts`
 * runs patterns in a Worker under a time budget as the last line of defence.
 * This is deliberately conservative: it may refuse a few safe patterns, but
 * it does not run the pattern to find out.
 */

export const MAX_PATTERN_LENGTH = 200;
const MAX_UNBOUNDED_QUANTIFIERS = 2;

export interface TextMatcher {
  test(text: string): boolean;
  firstMatch(text: string): { index: number; length: number } | null;
}

export type MatcherResult = { ok: true; matcher: TextMatcher } | { ok: false; error: string };

const BRACE_QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

/**
 * A repeating quantifier at `at`: `*`, `+`, `{n,}`, `{n,m}` with m >= 2, or
 * `{n}` with n >= 2. `length` is 0 when there is none.
 */
function repeatQuantifierAt(pattern: string, at: number): { length: number; unbounded: boolean } {
  const ch = pattern[at];
  if (ch === '*' || ch === '+') return { length: 1, unbounded: true };
  if (ch === '{') {
    const m = BRACE_QUANTIFIER.exec(pattern.slice(at));
    if (m) {
      const n = Number(m[1]);
      const unbounded = m[2] !== undefined && m[3] === '';
      const max = m[2] === undefined ? n : unbounded ? Infinity : Number(m[3]);
      if (max >= 2) return { length: m[0].length, unbounded };
    }
  }
  return { length: 0, unbounded: false };
}

/** Index just past the `(?...` prefix of a non-capturing, lookaround or named group. */
function skipGroupPrefix(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern[i] !== '?') return i;
  i += 1;
  const c = pattern[i];
  if (c === ':' || c === '=' || c === '!') return i + 1;
  if (c === '<') {
    i += 1;
    if (pattern[i] === '=' || pattern[i] === '!') return i + 1;
    const close = pattern.indexOf('>', i);
    return close === -1 ? i : close + 1;
  }
  return i;
}

/** True when the pattern repeats a repeating group, or has too many unbounded quantifiers. */
function isRiskyPattern(pattern: string): boolean {
  let unbounded = 0;
  // One entry per open group: does its body contain a quantifier or `|`?
  const stack: boolean[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '(') {
      stack.push(false);
      i = skipGroupPrefix(pattern, i);
    } else if (ch === ')') {
      const bodyRepeats = stack.pop() ?? false;
      i += 1;
      const { length: q, unbounded: u } = repeatQuantifierAt(pattern, i);
      if (q > 0 && bodyRepeats) return true;
      if (u) unbounded += 1;
      // The closed group's contents, and its own quantifier, sit inside the parent's body.
      if (stack.length > 0 && (bodyRepeats || q > 0)) stack[stack.length - 1] = true;
      i += q;
    } else {
      const { length: q, unbounded: u } = repeatQuantifierAt(pattern, i);
      if (u) unbounded += 1;
      if ((q > 0 || ch === '|') && stack.length > 0) stack[stack.length - 1] = true;
      i += Math.max(q, 1);
    }
  }
  return unbounded > MAX_UNBOUNDED_QUANTIFIERS;
}

export function compileMatcher(query: string, options: { regex: boolean }): MatcherResult {
  if (!options.regex) {
    const needle = query.toLowerCase();
    return {
      ok: true,
      matcher: {
        test: (text) => text.toLowerCase().includes(needle),
        firstMatch: (text) => {
          const index = text.toLowerCase().indexOf(needle);
          return index === -1 ? null : { index, length: needle.length };
        },
      },
    };
  }

  if (query.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `Pattern is longer than the ${MAX_PATTERN_LENGTH}-character limit.` };
  }
  let re: RegExp;
  try {
    re = new RegExp(query, 'i');
  } catch (e) {
    return { ok: false, error: `Invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (isRiskyPattern(query)) {
    return { ok: false, error: 'This pattern would take too long to run.' };
  }
  return {
    ok: true,
    matcher: {
      test: (text) => firstRegexMatch(re, text) !== null,
      firstMatch: (text) => firstRegexMatch(re, text),
    },
  };
}

/** A zero-length match (`x*`, `^`) counts as no match, so it cannot match everything. */
function firstRegexMatch(re: RegExp, text: string): { index: number; length: number } | null {
  const m = re.exec(text);
  return m && m[0].length > 0 ? { index: m.index, length: m[0].length } : null;
}

/**
 * First match of `pattern` in each text, or an error. Shared by the Worker and
 * the in-thread fallback of `regexRunner.ts`; does not itself bound run time.
 */
export function firstMatches(
  pattern: string,
  texts: readonly string[],
): { ok: true; matches: ({ index: number; length: number } | null)[] } | { ok: false; error: string } {
  const compiled = compileMatcher(pattern, { regex: true });
  if (!compiled.ok) return compiled;
  return { ok: true, matches: texts.map((t) => compiled.matcher.firstMatch(t)) };
}
