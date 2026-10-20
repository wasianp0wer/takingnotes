import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { getSettingValue, setSettingValue } from '@/storage/settingKeys'
import { applyTheme } from './applyTheme'
import { BUILT_IN_THEMES, LIGHT_THEME_ID, lightTheme } from './builtins'
import {
  deleteCustomTheme,
  loadCustomThemes,
  resolveTheme,
  saveCustomTheme,
  writeThemeMirror,
} from './themeStore'
import type { Theme } from './types'

export interface ThemesContextValue {
  active: Theme
  builtIns: readonly Theme[]
  custom: readonly Theme[]
  setActive(id: string): Promise<void>
  /** Saves (upserts) and activates. */
  saveCustom(theme: Theme): Promise<void>
  /** Falls back to Light if the deleted theme was active. */
  deleteCustom(id: string): Promise<void>
  /** Temporarily applies `theme`; null restores `active`. */
  preview(theme: Theme | null): void
}

// Outside a provider (e.g. component tests that do not care about theming) the
// hook returns this inert Light default instead of throwing.
const DEFAULT_VALUE: ThemesContextValue = {
  active: lightTheme(),
  builtIns: BUILT_IN_THEMES,
  custom: [],
  setActive: async () => {},
  saveCustom: async () => {},
  deleteCustom: async () => {},
  preview: () => {},
}

const ThemesContext = createContext<ThemesContextValue>(DEFAULT_VALUE)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [custom, setCustom] = useState<Theme[]>([])
  const [activeId, setActiveId] = useState(LIGHT_THEME_ID)
  const activeRef = useRef<Theme>(lightTheme())
  // A choice made before the initial load finishes must not be overwritten by the stored one.
  const choseRef = useRef(false)
  // Until the stored choice is known the early-painted (mirrored) theme stays; applying
  // Light first would flash and overwrite the mirror.
  const [ready, setReady] = useState(false)

  const active = useMemo(() => resolveTheme(activeId, custom), [activeId, custom])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [id, themes] = await Promise.all([getSettingValue('ui.theme'), loadCustomThemes()])
        if (cancelled) return
        setCustom(themes)
        if (!choseRef.current) setActiveId(id)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    activeRef.current = active
    if (!ready) return
    applyTheme(active)
    writeThemeMirror(active)
  }, [active, ready])

  const setActive = useCallback(async (id: string) => {
    choseRef.current = true
    setReady(true)
    setActiveId(id)
    await setSettingValue('ui.theme', id)
  }, [])

  const saveCustom = useCallback(async (theme: Theme) => {
    const next = await saveCustomTheme(theme)
    choseRef.current = true
    setReady(true)
    setCustom(next)
    setActiveId(theme.id)
    await setSettingValue('ui.theme', theme.id)
  }, [])

  const deleteCustom = useCallback(async (id: string) => {
    const next = await deleteCustomTheme(id)
    setCustom(next)
    if (activeRef.current.id === id) {
      choseRef.current = true
    setReady(true)
      setActiveId(LIGHT_THEME_ID)
      await setSettingValue('ui.theme', LIGHT_THEME_ID)
    }
  }, [])

  const preview = useCallback((theme: Theme | null) => {
    applyTheme(theme ?? activeRef.current)
  }, [])

  const value = useMemo<ThemesContextValue>(
    () => ({ active, builtIns: BUILT_IN_THEMES, custom, setActive, saveCustom, deleteCustom, preview }),
    [active, custom, setActive, saveCustom, deleteCustom, preview],
  )
  return <ThemesContext.Provider value={value}>{children}</ThemesContext.Provider>
}

export function useThemes(): ThemesContextValue {
  return useContext(ThemesContext)
}
