/**
 * Pattern matcher for Find: plain case-insensitive substring, or a
 * case-insensitive regular expression.
 *
 * Regex safety (a hostile or careless pattern must never freeze the tab).
 * Two checks run here, before any text is tested, for instant feedback:
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
 * There is deliberately no cap on the number of `*`/`+` quantifiers: ordinary
 * patterns such as `\w+\s+\w+` or `.*foo.*bar.*` need several. Every
 * production regex runs in a Worker under a time budget (`regexRunner.ts`),
 * which is the real protection; a slow group-less pattern such as
 * `.*.*.*.*z` is stopped there with "This pattern took too long to run".
 */

export const MAX_PATTERN_LENGTH = 200;

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
function repeatQuantifierAt(pattern: string, at: number): number {
  const ch = pattern[at];
  if (ch === '*' || ch === '+') return 1;
  if (ch === '{') {
    const m = BRACE_QUANTIFIER.exec(pattern.slice(at));
    if (m) {
      const n = Number(m[1]);
      const max = m[2] === undefined ? n : m[3] === '' ? Infinity : Number(m[3]);
      if (max >= 2) return m[0].length;
    }
  }
  return 0;
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

/** True when the pattern repeats a group whose body itself repeats or alternates. */
function isRiskyPattern(pattern: string): boolean {
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
      const q = repeatQuantifierAt(pattern, i);
      if (q > 0 && bodyRepeats) return true;
      // The closed group's contents, and its own quantifier, sit inside the parent's body.
      if (stack.length > 0 && (bodyRepeats || q > 0)) stack[stack.length - 1] = true;
      i += q;
    } else {
      const q = repeatQuantifierAt(pattern, i);
      if ((q > 0 || ch === '|') && stack.length > 0) stack[stack.length - 1] = true;
      i += Math.max(q, 1);
    }
  }
  return false;
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
