import { hexToHslTriplet } from './color'
import { THEME_COLOR_TOKENS, type Theme, type ThemeColorToken } from './types'

/** token -> extra shadcn variable names it also writes */
export const CSS_VAR_ALIASES: Partial<Record<ThemeColorToken, string[]>> = {
  surface: ['card', 'sidebar-background'],
  'surface-foreground': ['card-foreground'],
  'surface-raised': ['popover'],
  'surface-raised-foreground': ['popover-foreground'],
  'focus-ring': ['ring'],
}

/** Writes a theme's tokens as CSS variables (HSL triplets) on `root`. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const style = root.style
  for (const token of THEME_COLOR_TOKENS) {
    const triplet = hexToHslTriplet(theme.colors[token])
    style.setProperty(`--${token}`, triplet)
    for (const alias of CSS_VAR_ALIASES[token] ?? []) style.setProperty(`--${alias}`, triplet)
  }
  style.setProperty('--radius', theme.shape.radius)
  style.setProperty('--border-width', theme.shape.borderWidth)
  style.setProperty('--font-ui', theme.fonts.ui)
  style.setProperty('--font-mono', theme.fonts.mono)
  style.setProperty('--font-transcript', theme.fonts.transcript)
  root.dataset.themeBase = theme.base
  root.classList.toggle('dark', theme.base === 'dark')
  // Native controls (scrollbars, date pickers, checkboxes) follow the base.
  style.colorScheme = theme.base
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme.colors.background)
}
