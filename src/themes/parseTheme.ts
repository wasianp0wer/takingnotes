import { isHexColor } from './color'
import { THEME_COLOR_TOKENS, type Theme, type ThemeFonts, type ThemeShape } from './types'

export type ParseThemeResult =
  | { ok: true; theme: Theme; warnings: string[] }
  | { ok: false; error: string }

const ID = /^[a-z0-9-]{1,40}$/
const LENGTH = /^\d+(\.\d+)?(px|rem)$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isSafeFont(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 200 &&
    !/[;{}]/.test(v) &&
    !/url\(/i.test(v)
  )
}

/**
 * Validates untrusted theme JSON. Copies only known keys; any missing or
 * invalid value is taken from `fallback` with a warning. Only a bad id/name
 * or a non-object rejects the whole theme.
 */
export function parseTheme(input: unknown, fallback: Theme): ParseThemeResult {
  if (!isRecord(input)) return { ok: false, error: 'A theme must be a JSON object.' }
  if (typeof input.id !== 'string' || !ID.test(input.id)) {
    return { ok: false, error: 'Theme id must be 1-40 characters of a-z, 0-9 or "-".' }
  }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length < 1 || name.length > 60) {
    return { ok: false, error: 'Theme name must be 1-60 characters.' }
  }

  const warnings: string[] = []
  const inColors = isRecord(input.colors) ? input.colors : {}
  const colors = {} as Theme['colors']
  for (const token of THEME_COLOR_TOKENS) {
    const v = inColors[token]
    if (isHexColor(v)) colors[token] = v
    else {
      colors[token] = fallback.colors[token]
      warnings.push(`Colour "${token}" is missing or not #rrggbb; using the fallback.`)
    }
  }

  const inShape = isRecord(input.shape) ? input.shape : {}
  const shape = {} as ThemeShape
  for (const key of ['radius', 'borderWidth'] as const) {
    const v = inShape[key]
    if (typeof v === 'string' && LENGTH.test(v)) shape[key] = v
    else {
      shape[key] = fallback.shape[key]
      warnings.push(`Shape "${key}" must look like "4px" or "0.5rem"; using the fallback.`)
    }
  }

  const inFonts = isRecord(input.fonts) ? input.fonts : {}
  const fonts = {} as ThemeFonts
  for (const key of ['ui', 'mono', 'transcript'] as const) {
    const v = inFonts[key]
    if (isSafeFont(v)) fonts[key] = v
    else {
      fonts[key] = fallback.fonts[key]
      warnings.push(`Font "${key}" is missing or unsafe; using the fallback.`)
    }
  }

  const base = input.base === 'dark' ? 'dark' : 'light'
  return { ok: true, theme: { id: input.id, name, builtIn: false, base, colors, shape, fonts }, warnings }
}
