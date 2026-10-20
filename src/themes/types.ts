export const THEME_COLOR_TOKENS = [
  'background', 'foreground', 'surface', 'surface-foreground', 'surface-raised', 'surface-raised-foreground',
  'muted', 'muted-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
  'accent', 'accent-foreground', 'destructive', 'destructive-foreground', 'border', 'input',
  'focus-ring', 'hover-bg', 'hover-outline', 'selected-bg', 'selected-bar', 'overlay',
  'heading', 'session-title', 'tag', 'timestamp', 'date', 'link', 'search-highlight',
  'status-ok', 'status-warn', 'status-error', 'canvas-bg', 'ink',
  'score-red', 'score-orange', 'score-amber', 'score-lime', 'score-green',
] as const

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number]

export interface ThemeShape {
  radius: string
  borderWidth: string
}

export interface ThemeFonts {
  ui: string
  mono: string
  transcript: string
}

export interface Theme {
  id: string
  name: string
  builtIn: boolean
  base: 'light' | 'dark'
  colors: Record<ThemeColorToken, string>
  shape: ThemeShape
  fonts: ThemeFonts
}
