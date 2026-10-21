import { describe, expect, it } from 'vitest'
import json from './builtin/light.json'
import dark from './builtin/dark.json'
import midnight from './builtin/midnight-blue.json'
import rainbowJson from './builtin/rainbow.json'
import sakura from './builtin/sakura.json'
import { BUILT_IN_THEMES, lightTheme } from './builtins'
import { contrastRatio } from './color'
import { parseTheme } from './parseTheme'

const raw: Record<string, unknown> = {
  light: json, dark, 'midnight-blue': midnight, rainbow: rainbowJson, sakura,
}

describe('built-in themes', () => {
  it('has the five, in order, all flagged built-in', () => {
    expect(BUILT_IN_THEMES.map((t) => t.id)).toEqual(['light', 'dark', 'midnight-blue', 'rainbow', 'sakura'])
    expect(BUILT_IN_THEMES.every((t) => t.builtIn)).toBe(true)
  })

  it.each(BUILT_IN_THEMES.map((t) => [t.id]))('%s round-trips with no warnings', (id) => {
    const r = parseTheme(raw[id], lightTheme())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings).toEqual([])
  })

  it('all use square corners', () => {
    for (const t of BUILT_IN_THEMES) expect(t.shape.radius).toBe('0px')
  })

  it('rainbow has distinct element-kind colours', () => {
    const t = BUILT_IN_THEMES.find((x) => x.id === 'rainbow')!
    const c = t.colors
    expect(new Set([c.heading, c.tag, c.timestamp, c.date, c.link]).size).toBeGreaterThanOrEqual(5)
  })

  it('ink contrasts with the canvas, and text with the background', () => {
    for (const t of BUILT_IN_THEMES) {
      expect(contrastRatio(t.colors.ink, t.colors['canvas-bg']), t.id).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.colors.foreground, t.colors.background), t.id).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('set transcribed text in a different font from the interface', () => {
    for (const t of BUILT_IN_THEMES) expect(t.fonts.transcript, t.id).not.toBe(t.fonts.ui)
  })
})
