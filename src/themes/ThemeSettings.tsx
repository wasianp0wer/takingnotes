import { useRef, useState, type ChangeEvent } from 'react'

import { Button } from '@/components/ui/button'
import { useThemes } from './ThemeProvider'
import { lightTheme } from './builtins'
import { importThemeText, themeFileName, themeToJson } from './themeFile'
import { uniqueThemeId } from './themeStore'
import type { Theme } from './types'

export interface ThemeSettingsProps {
  /** Task 17 wires the builder; until then New/Edit/Duplicate are no-ops. */
  onOpenBuilder?(initial: Theme, mode: 'new' | 'edit'): void
}

function downloadTheme(theme: Theme) {
  const blob = new Blob([themeToJson(theme)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = themeFileName(theme)
  link.rel = 'noopener'
  // Appended first: Firefox and Safari ignore a click on a detached anchor.
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Released on the next tick so the save the click started is not cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Settings section: pick, create, duplicate, edit, import, export and delete themes. */
export function ThemeSettings({ onOpenBuilder }: ThemeSettingsProps = {}) {
  const { active, builtIns, custom, setActive, saveCustom, deleteCustom } = useThemes()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const takenIds = [...builtIns, ...custom].map((t) => t.id)

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setWarnings([])
    let text: string
    try {
      text = await file.text()
    } catch {
      setError('Could not read that file.')
      return
    }
    const result = importThemeText(text, takenIds)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await saveCustom(result.theme)
    setWarnings(result.warnings)
  }

  function handleDelete(theme: Theme) {
    if (!window.confirm(`Delete the theme "${theme.name}"?`)) return
    void deleteCustom(theme.id)
  }

  function duplicate(theme: Theme) {
    const id = uniqueThemeId(`${theme.id}-copy`.slice(0, 40), takenIds)
    onOpenBuilder?.({ ...theme, id, name: `${theme.name} copy`.slice(0, 60), builtIn: false }, 'new')
  }

  function create() {
    const id = uniqueThemeId('my-theme', takenIds)
    onOpenBuilder?.({ ...lightTheme(), id, name: 'My theme', builtIn: false }, 'new')
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-heading">Theme</h3>
      <div role="radiogroup" aria-label="Theme" className="space-y-1">
        {[...builtIns, ...custom].map((theme) => (
          <div key={theme.id} className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-2 text-sm">
              <input
                type="radio"
                name="theme"
                value={theme.id}
                aria-label={theme.name}
                checked={active.id === theme.id}
                onChange={() => void setActive(theme.id)}
              />
              <span
                data-testid="theme-swatch"
                aria-hidden="true"
                className="inline-block size-5 shrink-0"
                style={{
                  background: theme.colors.background,
                  outline: `2px solid ${theme.colors.primary}`,
                }}
              />
              <span>{theme.name}</span>
            </label>
            {theme.builtIn ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenBuilder?.(theme, 'edit')}
                aria-label={`Edit ${theme.name}`}
              >
                Edit
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => duplicate(theme)}
              aria-label={`Duplicate ${theme.name}`}
            >
              Duplicate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadTheme(theme)}
              aria-label={`Export ${theme.name}`}
            >
              Export
            </Button>
            {theme.builtIn ? null : (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDelete(theme)}
                aria-label={`Delete ${theme.name}`}
              >
                Delete
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={create}>
          New theme
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          Import theme
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Import theme file"
          data-testid="theme-import-input"
          onChange={(e) => void handleImport(e)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <ul role="status" className="list-disc pl-5 text-sm text-muted-foreground">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
