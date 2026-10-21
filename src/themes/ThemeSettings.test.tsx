import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '@/test/resetDb'
import { BUILT_IN_THEMES, lightTheme } from './builtins'
import { ThemeProvider, useThemes, type ThemesContextValue } from './ThemeProvider'
import { ThemeSettings } from './ThemeSettings'
import { themeToJson } from './themeFile'

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
const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
const button = (name: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
const mine = { ...lightTheme(), id: 'mine', name: 'Mine', builtIn: false }

async function mount(onOpenBuilder?: (t: unknown, m: string) => void) {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Spy />
        <ThemeSettings onOpenBuilder={onOpenBuilder} />
      </ThemeProvider>,
    )
  })
  await settle()
}

async function importFile(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File([text], 'x.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await resetDatabase()
  vi.stubGlobal('localStorage', memoryStorage())
  document.documentElement.removeAttribute('style')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ThemeSettings', () => {
  it('renders a Theme radiogroup with every theme and a swatch each', async () => {
    await mount()
    await act(async () => latest.ctx!.saveCustom(mine))
    const group = container.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Theme')
    expect(radios()).toHaveLength(BUILT_IN_THEMES.length + 1)
    expect(BUILT_IN_THEMES).toHaveLength(5)
    expect(container.querySelectorAll('[data-testid="theme-swatch"]')).toHaveLength(6)
  })

  it('checking Sakura activates it and changes --background', async () => {
    await mount()
    const before = bg()
    const sakura = container.querySelector<HTMLInputElement>('input[aria-label="Sakura"]')!
    await act(async () => sakura.click())
    await settle()
    expect(latest.ctx!.active.id).toBe('sakura')
    expect(bg()).not.toBe(before)
  })

  it('built-ins offer Duplicate only; custom themes offer Edit, Duplicate, Export, Delete', async () => {
    await mount()
    await act(async () => latest.ctx!.saveCustom(mine))
    expect(button('Edit Light')).toBeNull()
    expect(button('Delete Light')).toBeNull()
    expect(button('Duplicate Light')).not.toBeNull()
    expect(button('Edit Mine')).not.toBeNull()
    expect(button('Duplicate Mine')).not.toBeNull()
    expect(button('Delete Mine')).not.toBeNull()
  })

  it('Delete asks for confirmation, then removes the theme', async () => {
    await mount()
    await act(async () => latest.ctx!.saveCustom(mine))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    await act(async () => button('Delete Mine')!.click())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(latest.ctx!.custom).toHaveLength(1)
    confirm.mockReturnValueOnce(true)
    await act(async () => button('Delete Mine')!.click())
    await settle()
    expect(latest.ctx!.custom).toHaveLength(0)
  })

  it('Export downloads a Blob whose text parses back to the theme', async () => {
    await mount()
    let blob: Blob | null = null
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), 'blob:x'))
    URL.revokeObjectURL = vi.fn()
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })
    await act(async () => button('Export Dark')!.click())
    await settle()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
    expect(names).toEqual(['dark.theme.json'])
    const parsed = JSON.parse(await blob!.text())
    expect(parsed.id).toBe('dark')
    expect(parsed.colors.background).toBe(BUILT_IN_THEMES.find((t) => t.id === 'dark')!.colors.background)
  })

  it('deleting the active custom theme falls back to Light', async () => {
    await mount()
    await act(async () => latest.ctx!.saveCustom(mine))
    expect(latest.ctx!.active.id).toBe('mine')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => button('Delete Mine')!.click())
    await settle()
    expect(latest.ctx!.active.id).toBe('light')
    expect(latest.ctx!.custom).toHaveLength(0)
  })

  it('an import file over 256 KB is refused before it is read', async () => {
    await mount()
    const text = vi.spyOn(File.prototype, 'text')
    await importFile(' '.repeat(256 * 1024 + 1))
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Not a theme file: too large')
    expect(text).not.toHaveBeenCalled()
    expect(latest.ctx!.custom).toHaveLength(0)
  })

  it('a rejected save during import shows an alert', async () => {
    await mount()
    const dark = BUILT_IN_THEMES.find((t) => t.id === 'dark')!
    const mod = await import('./themeStore')
    vi.spyOn(mod, 'saveCustomTheme').mockRejectedValueOnce(new Error('disk full'))
    await importFile(themeToJson({ ...dark, id: 'x', name: 'X', builtIn: false }))
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/Could not save/)
  })

  it('New opens the builder dialog and Cancel closes it', async () => {
    await mount()
    const create = [...container.querySelectorAll('button')].find((b) => b.textContent === 'New theme')!
    await act(async () => create.click())
    expect(document.body.querySelector('input[aria-label="Theme name"]')).not.toBeNull()
    const cancel = [...document.body.querySelectorAll('[data-slot="dialog-footer"] button')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement
    await act(async () => cancel.click())
    expect(document.body.querySelector('input[aria-label="Theme name"]')).toBeNull()
  })

  it('a bad import file shows an alert and adds nothing', async () => {
    await mount()
    await importFile('{')
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/Not a theme file/)
    expect(latest.ctx!.custom).toHaveLength(0)
  })

  it('a good import adds and activates the theme, showing warnings', async () => {
    await mount()
    const dark = BUILT_IN_THEMES.find((t) => t.id === 'dark')!
    const broken = { ...JSON.parse(themeToJson(dark)), id: 'dark', colors: {} }
    await importFile(JSON.stringify(broken))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(latest.ctx!.custom.map((t) => t.id)).toEqual(['dark-2'])
    expect(latest.ctx!.active.id).toBe('dark-2')
    expect(container.querySelector('[role="status"]')!.textContent).toMatch(/fallback/)
  })

  it('New, Edit and Duplicate hand a theme to onOpenBuilder', async () => {
    const open = vi.fn()
    await mount(open)
    await act(async () => latest.ctx!.saveCustom(mine))
    await act(async () => button('Edit Mine')!.click())
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'mine' }), 'edit')
    await act(async () => button('Duplicate Dark')!.click())
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'dark-copy', builtIn: false }),
      'new',
    )
    const create = [...container.querySelectorAll('button')].find((b) => b.textContent === 'New theme')!
    await act(async () => create.click())
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'my-theme' }), 'new')
  })
})
