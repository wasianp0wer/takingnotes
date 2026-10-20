import { parseTheme } from './parseTheme'
import type { Theme } from './types'
import light from './builtin/light.json'
import dark from './builtin/dark.json'
import midnightBlue from './builtin/midnight-blue.json'
import rainbow from './builtin/rainbow.json'
import sakura from './builtin/sakura.json'

export const LIGHT_THEME_ID = 'light'

// Bundled themes are validated against themselves so a typo is a build defect.
const BOOTSTRAP = { ...(light as object) } as unknown as Theme

function load(raw: unknown): Theme {
  const r = parseTheme(raw, BOOTSTRAP)
  if (!r.ok) throw new Error(`Built-in theme is invalid: ${r.error}`)
  if (r.warnings.length > 0) throw new Error(`Built-in theme has problems: ${r.warnings.join(' ')}`)
  return { ...r.theme, builtIn: true }
}

export const BUILT_IN_THEMES: readonly Theme[] = [light, dark, midnightBlue, rainbow, sakura].map(load)

export function lightTheme(): Theme {
  return BUILT_IN_THEMES[0]
}
