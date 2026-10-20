import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSettingValue } from '@/storage/settingKeys'
import { resetDatabase } from '@/test/resetDb'
import { BUILT_IN_THEMES, lightTheme } from './builtins'
import { ThemeProvider, useThemes, type ThemesContextValue } from './ThemeProvider'
import { THEME_MIRROR_KEY } from './themeStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const latest: { ctx: ThemesContextValue | null } = { ctx: null }
const themes = () => latest.ctx!

// Node 25 ships a global `localStorage` stub that shadows happy-dom's and has
// no methods, so install a Map-backed Storage for these tests.
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

function Consumer() {
  const value = useThemes()
  useEffect(() => {
    latest.ctx = value
  })
  return <span data-testid="id">{value.active.id}</span>
}

const rendered = () => container.querySelector('span')!.textContent
const bg = () => document.documentElement.style.getPropertyValue('--background')
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await resetDatabase()
  vi.stubGlobal('localStorage', memoryStorage())
  document.documentElement.removeAttribute('style')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<ThemeProvider><Consumer /></ThemeProvider>)
  })
  await flush()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('ThemeProvider', () => {
  it('renders light when nothing is stored', () => {
    expect(rendered()).toBe('light')
    expect(bg()).not.toBe('')
  })

  it('setActive updates state, setting, mirror and CSS variables', async () => {
    const before = bg()
    await act(async () => themes().setActive('sakura'))
    expect(rendered()).toBe('sakura')
    expect(await getSettingValue('ui.theme')).toBe('sakura')
    expect(JSON.parse(localStorage.getItem(THEME_MIRROR_KEY)!).id).toBe('sakura')
    expect(bg()).not.toBe(before)
  })

  it('deleting the active custom theme falls back to light', async () => {
    await act(async () => themes().saveCustom({ ...lightTheme(), id: 'mine', name: 'Mine', builtIn: false }))
    expect(rendered()).toBe('mine')
    expect(themes().custom).toHaveLength(1)
    await act(async () => themes().deleteCustom('mine'))
    expect(rendered()).toBe('light')
    expect(await getSettingValue('ui.theme')).toBe('light')
    expect(themes().custom).toHaveLength(0)
  })

  it('preview changes the variables but not the active id; null restores', async () => {
    await act(async () => themes().setActive('dark'))
    const before = bg()
    act(() => themes().preview(BUILT_IN_THEMES.find((t) => t.id === 'sakura')!))
    expect(bg()).not.toBe(before)
    expect(rendered()).toBe('dark')
    act(() => themes().preview(null))
    expect(bg()).toBe(before)
  })

  it('useThemes outside a provider returns an inert light default', async () => {
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<Consumer />))
    expect(rendered()).toBe('light')
    await expect(themes().setActive('dark')).resolves.toBeUndefined()
  })
})
