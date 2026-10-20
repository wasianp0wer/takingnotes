import { getSettingValue, setSettingValue } from '@/storage/settingKeys'
import { applyTheme } from './applyTheme'
import { BUILT_IN_THEMES, lightTheme } from './builtins'
import { parseTheme } from './parseTheme'
import type { Theme } from './types'

export const THEME_MIRROR_KEY = 'takingnotes.activeTheme'

export function resolveTheme(id: string, custom: readonly Theme[]): Theme {
  return (
    BUILT_IN_THEMES.find((t) => t.id === id) ?? custom.find((t) => t.id === id) ?? lightTheme()
  )
}

/** Reads stored custom themes, silently dropping any entry that does not parse. */
export async function loadCustomThemes(): Promise<Theme[]> {
  const stored = await getSettingValue('ui.customThemes')
  if (!Array.isArray(stored)) return []
  const themes: Theme[] = []
  for (const entry of stored) {
    const r = parseTheme(entry, lightTheme())
    if (r.ok) themes.push(r.theme)
  }
  return themes
}

export async function saveCustomTheme(theme: Theme): Promise<Theme[]> {
  const current = await loadCustomThemes()
  const saved = { ...theme, builtIn: false }
  const i = current.findIndex((t) => t.id === saved.id)
  const next = i >= 0 ? current.map((t, j) => (j === i ? saved : t)) : [...current, saved]
  await setSettingValue('ui.customThemes', next)
  return next
}

export async function deleteCustomTheme(id: string): Promise<Theme[]> {
  const next = (await loadCustomThemes()).filter((t) => t.id !== id)
  await setSettingValue('ui.customThemes', next)
  return next
}

/** 'x' -> 'x-2' -> 'x-3' ... first id not in `taken`. */
export function uniqueThemeId(wanted: string, taken: readonly string[]): string {
  if (!taken.includes(wanted)) return wanted
  let n = 2
  while (taken.includes(`${wanted}-${n}`)) n++
  return `${wanted}-${n}`
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * Paints the last-used theme synchronously, before React mounts, so there is
 * no flash of Light. Any problem (no storage, corrupt JSON, invalid theme)
 * leaves the stylesheet defaults in place.
 */
export function applyMirroredThemeEarly(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): void {
  try {
    const raw = storage?.getItem(THEME_MIRROR_KEY)
    if (!raw) return
    const r = parseTheme(JSON.parse(raw), lightTheme())
    if (r.ok) applyTheme(r.theme)
  } catch {
    // Corrupt mirror: fall through to the defaults.
  }
}

export function writeThemeMirror(
  theme: Theme,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(THEME_MIRROR_KEY, JSON.stringify(theme))
  } catch {
    // Quota or blocked storage: the mirror is only an optimisation.
  }
}
