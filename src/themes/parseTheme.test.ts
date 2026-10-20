import { describe, expect, it } from 'vitest'
import { lightTheme } from './builtins'
import { parseTheme } from './parseTheme'

const fallback = lightTheme()
const base = { id: 'mine', name: 'Mine' }

function ok(input: unknown) {
  const r = parseTheme(input, fallback)
  if (!r.ok) throw new Error(r.error)
  return r
}

describe('parseTheme', () => {
  it('rejects a non-object', () => {
    for (const v of ['x', null, []]) expect(parseTheme(v, fallback).ok).toBe(false)
  })

  it('requires an id slug and a name', () => {
    const bad = parseTheme({ id: 'Bad Id!', name: 'x' }, fallback)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/id/)
    expect(parseTheme({ id: 'fine' }, fallback).ok).toBe(false)
  })

  it('fills a missing or invalid colour from the fallback, with a warning', () => {
    const r = ok({ ...base, colors: { background: '#123456', tag: 'pink' } })
    expect(r.theme.colors.background).toBe('#123456')
    expect(r.theme.colors.tag).toBe(fallback.colors.tag)
    expect(r.theme.colors.ink).toBe(fallback.colors.ink)
    expect(r.warnings.some((w) => w.includes('tag'))).toBe(true)
  })

  it('ignores unknown colour tokens', () => {
    const r = ok({ ...base, colors: { nope: '#000000' } })
    expect('nope' in r.theme.colors).toBe(false)
  })

  it('forces builtIn to false', () => {
    expect(ok({ ...base, builtIn: true }).theme.builtIn).toBe(false)
  })

  it('validates shape', () => {
    const r = ok({ ...base, shape: { radius: '4px', borderWidth: '0.5rem' } })
    expect(r.theme.shape.radius).toBe('4px')
    expect(r.theme.shape.borderWidth).toBe('0.5rem')
    const bad = ok({ ...base, shape: { radius: '1em' } })
    expect(bad.theme.shape.radius).toBe(fallback.shape.radius)
    expect(bad.warnings.some((w) => w.includes('radius'))).toBe(true)
  })

  it('rejects font values that could inject CSS', () => {
    for (const v of ['x; color: red', 'url(http://a)', 'a'.repeat(201)]) {
      const r = ok({ ...base, fonts: { ui: v } })
      expect(r.theme.fonts.ui).toBe(fallback.fonts.ui)
      expect(r.warnings.some((w) => w.includes('ui'))).toBe(true)
    }
  })

  it('base defaults to light', () => {
    expect(ok(base).theme.base).toBe('light')
    expect(ok({ ...base, base: 'neon' }).theme.base).toBe('light')
    expect(ok({ ...base, base: 'dark' }).theme.base).toBe('dark')
  })
})
