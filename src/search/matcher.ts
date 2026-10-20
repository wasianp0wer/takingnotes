/**
 * Pattern matcher for Find: plain case-insensitive substring, or a
 * case-insensitive regular expression.
 *
 * Regex safety (a hostile or careless pattern must never freeze the tab) is
 * two layers, both applied before any text is tested:
 *   1. A length cap, `MAX_PATTERN_LENGTH`.
 *   2. A nested-repetition rejection. After `new RegExp` accepts the pattern,
 *      `hasNestedRepetition` walks it once, tracking group depth on a stack,
 *      and rejects a *quantified group whose body itself contains a
 *      quantifier or an alternation* - the shape behind catastrophic
 *      backtracking: `(a+)+$`, `(a*)*`, `(\w+\s?)+$`, `(a|aa)+`.
 *      The scanner treats `\x` escapes and `[...]` classes as literals (parens
 *      and quantifiers inside them mean nothing), skips the prefix of
 *      non-capturing, lookaround and named groups, and counts `*`, `+`,
 *      `{n,}` and `{n,m}` as quantifiers. A plain `?` after a group, and a
 *      fixed `{n}`, are fine.
 * This is deliberately conservative: it may refuse a few safe patterns, but
 * it does not run the pattern to find out.
 */

export const MAX_PATTERN_LENGTH = 200;

export interface TextMatcher {
  test(text: string): boolean;
  firstMatch(text: string): { index: number; length: number } | null;
}

export type MatcherResult = { ok: true; matcher: TextMatcher } | { ok: false; error: string };

const BRACE_QUANTIFIER = /^\{\d+,\d*\}/;

/** Length of a repeating quantifier (`*`, `+`, `{n,}`, `{n,m}`) at `at`, else 0. */
function repeatQuantifierLength(pattern: string, at: number): number {
  const ch = pattern[at];
  if (ch === '*' || ch === '+') return 1;
  if (ch === '{') {
    const m = BRACE_QUANTIFIER.exec(pattern.slice(at));
    return m ? m[0].length : 0;
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

function hasNestedRepetition(pattern: string): boolean {
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
      const q = repeatQuantifierLength(pattern, i);
      if (q > 0 && bodyRepeats) return true;
      // The closed group's contents, and its own quantifier, sit inside the parent's body.
      if (stack.length > 0 && (bodyRepeats || q > 0)) stack[stack.length - 1] = true;
      i += q;
    } else {
      const q = repeatQuantifierLength(pattern, i);
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
  if (hasNestedRepetition(query)) {
    return { ok: false, error: 'Pattern is too long to run safely: it repeats a group that itself repeats.' };
  }
  return {
    ok: true,
    matcher: {
      test: (text) => re.test(text),
      firstMatch: (text) => {
        const m = re.exec(text);
        return m ? { index: m.index, length: m[0].length } : null;
      },
    },
  };
}
