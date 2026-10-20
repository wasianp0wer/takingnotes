import { describe, expect, it } from 'vitest'
import { applyTheme, CSS_VAR_ALIASES } from './applyTheme'
import { BUILT_IN_THEMES, lightTheme } from './builtins'
import { hexToHslTriplet } from './color'

const dark = BUILT_IN_THEMES.find((t) => t.id === 'dark')!

describe('applyTheme', () => {
  it('writes every token as an HSL triplet', () => {
    const el = document.createElement('div')
    applyTheme(dark, el)
    expect(el.style.getPropertyValue('--background')).toBe(hexToHslTriplet(dark.colors.background))
  })

  it('writes shadcn aliases with the same triplet', () => {
    const el = document.createElement('div')
    applyTheme(dark, el)
    expect(el.style.getPropertyValue('--card')).toBe(hexToHslTriplet(dark.colors.surface))
    expect(el.style.getPropertyValue('--popover')).toBe(hexToHslTriplet(dark.colors['surface-raised']))
    expect(el.style.getPropertyValue('--ring')).toBe(hexToHslTriplet(dark.colors['focus-ring']))
    for (const [token, names] of Object.entries(CSS_VAR_ALIASES)) {
      for (const n of names!) {
        expect(el.style.getPropertyValue(`--${n}`)).toBe(el.style.getPropertyValue(`--${token}`))
      }
    }
  })

  it('writes shape and fonts', () => {
    const el = document.createElement('div')
    applyTheme(dark, el)
    expect(el.style.getPropertyValue('--radius')).toBe(dark.shape.radius)
    expect(el.style.getPropertyValue('--border-width')).toBe(dark.shape.borderWidth)
    expect(el.style.getPropertyValue('--font-ui')).toBe(dark.fonts.ui)
    expect(el.style.getPropertyValue('--font-mono')).toBe(dark.fonts.mono)
    expect(el.style.getPropertyValue('--font-transcript')).toBe(dark.fonts.transcript)
  })

  it('sets the base and toggles the dark class', () => {
    const el = document.createElement('div')
    applyTheme(dark, el)
    expect(el.dataset.themeBase).toBe('dark')
    expect(el.classList.contains('dark')).toBe(true)
    applyTheme(lightTheme(), el)
    expect(el.dataset.themeBase).toBe('light')
    expect(el.classList.contains('dark')).toBe(false)
  })

  it('updates the theme-color meta when present', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    applyTheme(dark, document.documentElement)
    expect(meta.getAttribute('content')).toBe(dark.colors.background)
    meta.remove()
  })
})
