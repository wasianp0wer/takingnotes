import type { ThemeColorToken } from './types'

/** How the builder lays out the colour tokens; every token appears exactly once. */
export const TOKEN_GROUPS: readonly { label: string; tokens: readonly ThemeColorToken[] }[] = [
  {
    label: 'Surfaces',
    tokens: [
      'background', 'surface', 'surface-foreground', 'surface-raised',
      'surface-raised-foreground', 'muted', 'border', 'input', 'overlay',
    ],
  },
  { label: 'Text', tokens: ['foreground', 'muted-foreground', 'heading', 'link'] },
  {
    label: 'Interaction',
    tokens: [
      'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'accent',
      'accent-foreground', 'destructive', 'destructive-foreground', 'focus-ring', 'hover-bg',
      'hover-outline', 'selected-bg', 'selected-bar',
    ],
  },
  {
    label: 'Element kinds',
    tokens: [
      'session-title', 'tag', 'timestamp', 'date', 'search-highlight', 'status-ok',
      'status-warn', 'status-error',
    ],
  },
  { label: 'Ink', tokens: ['canvas-bg', 'ink'] },
  {
    label: 'Triage scores',
    tokens: ['score-red', 'score-orange', 'score-amber', 'score-lime', 'score-green'],
  },
]
