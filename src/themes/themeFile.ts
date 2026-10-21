import { lightTheme } from './builtins'
import { parseTheme } from './parseTheme'
import { uniqueThemeId } from './themeStore'
import type { Theme } from './types'

/** Pretty JSON for a theme file; `builtIn` is an app concern, not part of the file. */
export function themeToJson(theme: Theme): string {
  const copy: Partial<Theme> = { ...theme }
  delete copy.builtIn
  return JSON.stringify(copy, null, 2)
}

export function themeFileName(theme: Theme): string {
  return `${theme.id}.theme.json`
}

/**
 * Parses an imported theme file. `takenIds` must hold built-in AND custom ids:
 * a custom theme sharing a built-in id would be shadowed by it.
 */
export function importThemeText(
  text: string,
  takenIds: readonly string[],
): { ok: true; theme: Theme; warnings: string[] } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not a theme file: ${e instanceof Error ? e.message : 'invalid JSON'}` }
  }
  const parsed = parseTheme(raw, lightTheme())
  if (!parsed.ok) return { ok: false, error: `Not a theme file: ${parsed.error}` }
  const id = uniqueThemeId(parsed.theme.id, takenIds)
  return { ok: true, theme: { ...parsed.theme, id, builtIn: false }, warnings: parsed.warnings }
}
