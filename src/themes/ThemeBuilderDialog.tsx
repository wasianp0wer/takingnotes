import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { contrastRatio } from './color'
import { parseTheme } from './parseTheme'
import { useThemes } from './ThemeProvider'
import { uniqueThemeId } from './themeStore'
import { TOKEN_GROUPS } from './tokenGroups'
import type { Theme, ThemeColorToken } from './types'

export interface ThemeBuilderDialogProps {
  open: boolean
  initial: Theme
  mode: 'new' | 'edit'
  /** Called after save or cancel. */
  onClose(): void
}

const MIN_INK_CONTRAST = 3

type TextField = 'radius' | 'borderWidth' | 'ui' | 'mono' | 'transcript'
const TEXT_FIELDS: { key: TextField; label: string; hint?: string }[] = [
  { key: 'radius', label: 'Corner radius', hint: 'e.g. 0px or 0.5rem' },
  { key: 'borderWidth', label: 'Border width', hint: 'e.g. 1px' },
  { key: 'ui', label: 'UI font' },
  { key: 'mono', label: 'Monospace font' },
  { key: 'transcript', label: 'Transcript font' },
]

function readField(theme: Theme, key: TextField): string {
  return key === 'radius' || key === 'borderWidth' ? theme.shape[key] : theme.fonts[key]
}

function withField(theme: Theme, key: TextField, value: string): Theme {
  return key === 'radius' || key === 'borderWidth'
    ? { ...theme, shape: { ...theme.shape, [key]: value } }
    : { ...theme, fonts: { ...theme.fonts, [key]: value } }
}

function BuilderBody({ initial, mode, onClose }: Omit<ThemeBuilderDialogProps, 'open'>) {
  const { builtIns, custom, preview, saveCustom } = useThemes()
  // `draft` only ever holds valid values (it is what gets previewed and saved);
  // `raw` holds what the person typed, and `bad` the fields that are not valid yet.
  const [draft, setDraft] = useState<Theme>(initial)
  const [raw, setRaw] = useState<Record<string, string>>({})
  const [bad, setBad] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const saved = useRef(false)

  // Any way out that is not a save (including the parent unmounting us) restores the real theme.
  useEffect(() => {
    preview(initial)
    return () => {
      if (!saved.current) preview(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, [])

  function setValidity(field: string, ok: boolean) {
    setBad((prev) => {
      if (prev.has(field) === !ok) return prev
      const next = new Set(prev)
      if (ok) next.delete(field)
      else next.add(field)
      return next
    })
  }

  /** Applies `next` if every field is valid, otherwise leaves the draft and preview alone. */
  function tryApply(field: string, typed: string, next: Theme) {
    setRaw((r) => ({ ...r, [field]: typed }))
    const parsed = parseTheme({ ...next, name: next.name.trim() || 'x' }, draft)
    const ok = parsed.ok && parsed.warnings.length === 0
    setValidity(field, ok)
    if (ok) {
      setDraft(next)
      preview(next)
    }
  }

  function editColor(token: ThemeColorToken, value: string) {
    tryApply(`color:${token}`, value, { ...draft, colors: { ...draft.colors, [token]: value } })
  }

  function editText(key: TextField, value: string) {
    tryApply(key, value, withField(draft, key, value))
  }

  function cancel() {
    preview(null)
    onClose()
  }

  const name = draft.name.trim()
  const canSave = name.length > 0 && bad.size === 0 && !saving

  async function save() {
    if (!canSave) return
    const taken = [...builtIns, ...custom]
      .filter((t) => mode === 'new' || t.id !== initial.id)
      .map((t) => t.id)
    const id = mode === 'new' ? uniqueThemeId(draft.id, taken) : initial.id
    const parsed = parseTheme({ ...draft, id, name }, initial)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await saveCustom(parsed.theme)
    } catch {
      setSaving(false)
      setError('Could not save the theme.')
      return
    }
    saved.current = true
    onClose()
  }

  const ratio = contrastRatio(draft.colors.ink, draft.colors['canvas-bg'])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === 'new' ? 'New theme' : 'Edit theme'}</DialogTitle>
        <DialogDescription>
          Changes preview live on the app behind this window. Cancel puts everything back.
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1" data-testid="theme-builder-body">
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-heading">Name</span>
          <Input
            aria-label="Theme name"
            value={draft.name}
            maxLength={60}
            aria-invalid={name.length === 0}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-heading">Base</span>
          <select
            aria-label="Theme base"
            className="bg-muted h-9 w-full rounded px-3 text-sm focus-visible:ring-2 focus-visible:ring-focus-ring"
            value={draft.base}
            onChange={(e) => {
              const next = { ...draft, base: e.target.value === 'dark' ? 'dark' : 'light' } as Theme
              setDraft(next)
              preview(next)
            }}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        {TOKEN_GROUPS.map((group) => (
          <fieldset key={group.label} className="space-y-1">
            <legend className="text-sm font-semibold text-heading">{group.label}</legend>
            {group.tokens.map((token) => {
              const field = `color:${token}`
              return (
                <div key={token} className="flex items-center gap-2 text-sm">
                  <input
                    type="color"
                    aria-label={`${token} colour`}
                    value={draft.colors[token]}
                    onChange={(e) => editColor(token, e.target.value)}
                    className="size-8 shrink-0 cursor-pointer bg-transparent"
                  />
                  <span className="flex-1">{token}</span>
                  <Input
                    aria-label={`${token} hex`}
                    value={raw[field] ?? draft.colors[token]}
                    aria-invalid={bad.has(field)}
                    spellCheck={false}
                    onChange={(e) => editColor(token, e.target.value)}
                    className="w-28 font-mono"
                  />
                </div>
              )
            })}
          </fieldset>
        ))}
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-heading">Shape and fonts</legend>
          {TEXT_FIELDS.map(({ key, label, hint }) => (
            <label key={key} className="block space-y-1 text-sm">
              <span>{label}</span>
              <Input
                aria-label={label}
                placeholder={hint}
                value={raw[key] ?? readField(draft, key)}
                aria-invalid={bad.has(key)}
                onChange={(e) => editText(key, e.target.value)}
              />
            </label>
          ))}
        </fieldset>
        {ratio < MIN_INK_CONTRAST ? (
          <p role="status" className="text-sm text-status-warn">
            Low contrast between ink and canvas ({ratio.toFixed(1)}:1). Handwriting may be hard
            to read, but you can still save.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={!canSave}>
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

/** Modal editor for a custom theme. The real app behind it previews every valid change. */
export function ThemeBuilderDialog({ open, initial, mode, onClose }: ThemeBuilderDialogProps) {
  const { preview } = useThemes()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        preview(null)
        onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <BuilderBody initial={initial} mode={mode} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}
