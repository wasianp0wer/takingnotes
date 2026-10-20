import { beforeEach, describe, expect, it } from 'vitest'
import { setSettingValue } from '@/storage/settingKeys'
import { resetDatabase } from '@/test/resetDb'
import { BUILT_IN_THEMES, lightTheme } from './builtins'
import { hexToHslTriplet } from './color'
import {
  applyMirroredThemeEarly,
  deleteCustomTheme,
  loadCustomThemes,
  resolveTheme,
  saveCustomTheme,
  THEME_MIRROR_KEY,
  uniqueThemeId,
  writeThemeMirror,
} from './themeStore'

const custom = { ...lightTheme(), id: 'mine', name: 'Mine', builtIn: false }

beforeEach(async () => {
  await resetDatabase()
  document.documentElement.removeAttribute('style')
})

describe('themeStore', () => {
  it('resolveTheme falls back to light for an unknown id', () => {
    expect(resolveTheme('nope', [custom]).id).toBe('light')
    expect(resolveTheme('mine', [custom]).id).toBe('mine')
    expect(resolveTheme('sakura', []).id).toBe('sakura')
  })

  it('loadCustomThemes drops a malformed stored entry and keeps valid ones', async () => {
    await setSettingValue('ui.customThemes', [{ bad: true }, custom])
    const themes = await loadCustomThemes()
    expect(themes).toHaveLength(1)
    expect(themes[0].id).toBe('mine')
  })

  it('loadCustomThemes tolerates a non-array value', async () => {
    await setSettingValue('ui.customThemes', { a: 1 } as unknown as unknown[])
    expect(await loadCustomThemes()).toEqual([])
  })

  it('saveCustomTheme upserts by id', async () => {
    await saveCustomTheme(custom)
    const after = await saveCustomTheme({ ...custom, name: 'Renamed' })
    expect(after).toHaveLength(1)
    expect(after[0].name).toBe('Renamed')
    expect(await deleteCustomTheme('mine')).toEqual([])
  })

  it('uniqueThemeId appends the first free suffix', () => {
    expect(uniqueThemeId('x', [])).toBe('x')
    expect(uniqueThemeId('light', ['light'])).toBe('light-2')
    expect(uniqueThemeId('light', ['light', 'light-2'])).toBe('light-3')
  })

  it('applyMirroredThemeEarly ignores corrupt JSON', () => {
    expect(() => applyMirroredThemeEarly({ getItem: () => '{not json' })).not.toThrow()
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('')
  })

  it('applyMirroredThemeEarly ignores a mirror that is not a theme', () => {
    applyMirroredThemeEarly({ getItem: () => '{"id":"BAD ID"}' })
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('')
  })

  it('applyMirroredThemeEarly validates a partial mirror against light', () => {
    applyMirroredThemeEarly({ getItem: () => '{"id":"x","name":"X","colors":{"background":"red"}}' })
    expect(document.documentElement.style.getPropertyValue('--background')).toBe(
      hexToHslTriplet(lightTheme().colors.background),
    )
  })

  it('applyMirroredThemeEarly applies a valid mirror', () => {
    const dark = BUILT_IN_THEMES.find((t) => t.id === 'dark')!
    const store = new Map<string, string>()
    writeThemeMirror(dark, { setItem: (k, v) => void store.set(k, v) })
    applyMirroredThemeEarly({ getItem: (k) => store.get(k) ?? null })
    expect(store.has(THEME_MIRROR_KEY)).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--background')).not.toBe('')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('mirror helpers never throw', () => {
    const boom = () => {
      throw new Error('blocked')
    }
    expect(() => writeThemeMirror(lightTheme(), { setItem: boom })).not.toThrow()
    expect(() => applyMirroredThemeEarly({ getItem: boom })).not.toThrow()
    expect(() => applyMirroredThemeEarly(null)).not.toThrow()
  })
})
