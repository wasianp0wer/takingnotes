import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES } from './builtins'
import { importThemeText, themeFileName, themeToJson } from './themeFile'

const dark = BUILT_IN_THEMES.find((t) => t.id === 'dark')!

describe('themeFile', () => {
  it('omits builtIn from the exported JSON and names the file after the id', () => {
    expect(JSON.parse(themeToJson(dark))).not.toHaveProperty('builtIn')
    expect(themeFileName(dark)).toBe('dark.theme.json')
  })

  it('renames an imported id that collides with a taken (built-in) id', () => {
    const r = importThemeText(themeToJson(dark), ['dark'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.theme.id).toBe('dark-2')
      expect(r.theme.builtIn).toBe(false)
    }
  })

  it('rejects text that is not JSON', () => {
    const r = importThemeText('{', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^Not a theme file/)
  })

  it('rejects JSON that is not a theme object', () => {
    expect(importThemeText('[]', []).ok).toBe(false)
  })
})
