import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '@/test/resetDb'
import { lightTheme } from './builtins'
import { hexToHslTriplet } from './color'
import { ThemeBuilderDialog } from './ThemeBuilderDialog'
import { ThemeProvider, useThemes, type ThemesContextValue } from './ThemeProvider'
import { ThemeSettings } from './ThemeSettings'
import { loadCustomThemes } from './themeStore'
import { TOKEN_GROUPS } from './tokenGroups'
import { THEME_COLOR_TOKENS, type Theme } from './types'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const latest: { ctx: ThemesContextValue | null } = { ctx: null }

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

function Spy() {
  const value = useThemes()
  useEffect(() => {
    latest.ctx = value
  })
  return null
}

const bg = () => document.documentElement.style.getPropertyValue('--background')
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })
const field = (label: string) =>
  document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const footerButton = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')].find(
    (b) => b.textContent === text,
  )!

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const onClose = vi.fn()
const base: Theme = { ...lightTheme(), id: 'mine', name: 'Mine', builtIn: false }

function Harness({ initial = base, mode = 'edit' }: { initial?: Theme; mode?: 'new' | 'edit' }) {
  const [open, setOpen] = useState(true)
  return (
    <ThemeProvider>
      <Spy />
      <ThemeBuilderDialog
        open={open}
        initial={initial}
        mode={mode}
        onClose={() => {
          onClose()
          setOpen(false)
        }}
      />
    </ThemeProvider>
  )
}

async function mount(node: React.ReactNode = <Harness />) {
  await act(async () => root.render(node))
  await settle()
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await resetDatabase()
  vi.stubGlobal('localStorage', memoryStorage())
  document.documentElement.removeAttribute('style')
  onClose.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('TOKEN_GROUPS', () => {
  it('TOKEN_GROUPS covers every token exactly once', () => {
    const all = TOKEN_GROUPS.flatMap((g) => g.tokens)
    expect([...all].sort()).toEqual([...THEME_COLOR_TOKENS].sort())
    expect(TOKEN_GROUPS.map((g) => g.label)).toEqual([
      'Surfaces', 'Text', 'Interaction', 'Element kinds', 'Ink', 'Triage scores',
    ])
  })
})

describe('ThemeBuilderDialog', () => {
  it('new mode starts as a copy of the current theme, named "<name> copy", with a fresh id', async () => {
    await mount(
      <ThemeProvider>
        <Spy />
        <ThemeSettings />
      </ThemeProvider>,
    )
    const dup = document.body.querySelector<HTMLButtonElement>('button[aria-label="Duplicate Dark"]')!
    await act(async () => dup.click())
    expect(field('Theme name').value).toBe('Dark copy')
    expect(field('background hex').value).toBe(
      latest.ctx!.builtIns.find((t) => t.id === 'dark')!.colors.background,
    )
    await act(async () => footerButton('Save').click())
    await settle()
    const saved = await loadCustomThemes()
    expect(saved.map((t) => t.id)).toEqual(['dark-copy'])
    expect(latest.ctx!.builtIns.map((t) => t.id)).not.toContain('dark-copy')
  })

  it('new mode never saves over a built-in id', async () => {
    await mount(<Harness initial={{ ...base, id: 'dark' }} mode="new" />)
    await act(async () => footerButton('Save').click())
    await settle()
    expect((await loadCustomThemes()).map((t) => t.id)).toEqual(['dark-2'])
  })

  it('editing a colour previews it live', async () => {
    await mount()
    await type(field('background hex'), '#102030')
    expect(bg()).toBe(hexToHslTriplet('#102030'))
  })

  it('an invalid hex is flagged and not previewed', async () => {
    await mount()
    await type(field('background hex'), '#102030')
    await type(field('background hex'), '#12')
    expect(field('background hex').getAttribute('aria-invalid')).toBe('true')
    expect(bg()).toBe(hexToHslTriplet('#102030'))
    expect(footerButton('Save').disabled).toBe(true)
    await type(field('background hex'), 'zzzzzz')
    expect(bg()).toBe(hexToHslTriplet('#102030'))
  })

  it('cancel restores the previous theme', async () => {
    await mount()
    const before = bg()
    expect(before).not.toBe('')
    await type(field('background hex'), '#102030')
    expect(bg()).not.toBe(before)
    await act(async () => footerButton('Cancel').click())
    await settle()
    expect(bg()).toBe(before)
    expect(await loadCustomThemes()).toEqual([])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('save persists, activates and closes', async () => {
    await mount()
    await type(field('background hex'), '#102030')
    await act(async () => footerButton('Save').click())
    await settle()
    const saved = await loadCustomThemes()
    expect(saved.map((t) => t.id)).toEqual(['mine'])
    expect(saved[0].colors.background).toBe('#102030')
    expect(latest.ctx!.active.id).toBe('mine')
    expect(bg()).toBe(hexToHslTriplet('#102030'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('name is required', async () => {
    await mount()
    await type(field('Theme name'), '   ')
    expect(footerButton('Save').disabled).toBe(true)
    await type(field('Theme name'), 'Named')
    expect(footerButton('Save').disabled).toBe(false)
  })

  it('a low-contrast ink/canvas pair shows a warning but still saves', async () => {
    await mount()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
    await type(field('ink hex'), base.colors['canvas-bg'])
    expect(document.body.querySelector('[role="status"]')!.textContent).toMatch(/contrast/)
    expect(footerButton('Save').disabled).toBe(false)
    await act(async () => footerButton('Save').click())
    await settle()
    expect((await loadCustomThemes()).map((t) => t.id)).toEqual(['mine'])
  })

  it('shape and font fields edit the theme and preview it', async () => {
    await mount()
    const root = document.documentElement.style
    await type(field('Corner radius'), '8px')
    await type(field('Border width'), '2px')
    await type(field('UI font'), 'Georgia, serif')
    expect(root.getPropertyValue('--radius')).toBe('8px')
    expect(root.getPropertyValue('--border-width')).toBe('2px')
    expect(root.getPropertyValue('--font-ui')).toBe('Georgia, serif')
    await type(field('Corner radius'), 'big')
    expect(field('Corner radius').getAttribute('aria-invalid')).toBe('true')
    expect(root.getPropertyValue('--radius')).toBe('8px')
    await type(field('Corner radius'), '8px')
    await act(async () => footerButton('Save').click())
    await settle()
    const [saved] = await loadCustomThemes()
    expect(saved.shape).toEqual({ radius: '8px', borderWidth: '2px' })
    expect(saved.fonts.ui).toBe('Georgia, serif')
  })
})
