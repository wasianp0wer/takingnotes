# Sessions UI, Header Search and Themes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-tab, note-centred UI with a Sessions/Triage shell (notes and audio side by side), a header search with an expandable regex-capable advanced search, and a JSON theme system with five built-ins and an in-app builder.

**Architecture:** Themes are validated JSON objects applied as CSS custom properties on `:root`; Tailwind reads every colour, radius and font from those variables, so a theme switch restyles everything. UI state that must survive tab switches and reloads (selection, page, recording, notes mode, search) moves out of the views into two small external stores created once in `AppShell` and read through `useSyncExternalStore`. The Sessions view is built from pure, separately tested pieces (catalog, filter, matcher) plus thin components that reuse the existing Phase 3 widgets (`NoteTitle`, `TagEditor`, `ResumeButton`, `TranscriptPanel`, `GapPanel`, `TypedPageEditor`, `InkCanvas`, `RecordingDetail`).

**Tech Stack:** Vite, React 19, TypeScript, Tailwind v3, shadcn/Radix (`src/components/ui/*`), IndexedDB via `idb`, Vitest 3 + happy-dom + fake-indexeddb. Tests render with `createRoot` + `act`; there is no Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-19-sessions-ui-and-themes-design.md`. Read it first; every task's requirements include it.

## Global Constraints

- Work on a new branch `sessions-ui` created from local `phase3` HEAD, in the main checkout. Do not create worktrees from the remote: `origin/main` is 230 commits stale (handoff "environment traps"). If a worktree is used anyway, verify `git merge-base --is-ancestor phase3 HEAD` and run a real in-tree `npm install`.
- Verification bar for every task: `npx vitest run <touched test files>` green. At each task end, also run `npx tsc -b` clean. At the plan end, all of these:
  - `npm test` (baseline 1614 tests in 119 files; no test may disappear without a mapped replacement or a stated reason in the commit message)
  - `npx tsc -b`
  - `npm run lint`: 0 errors. The 5 pre-existing warnings in `src/utils/huionTransport.ts` are fine.
  - `npm run build`
- Test style: `createRoot` + `act`, `resetDatabase()` from `@/test/resetDb`, fakes from `src/test/*`. Copy the setup in `src/notes/NotesView.test.tsx`.
- **Mutation check.** Every test named for a spec constraint must be shown to fail against a deliberately broken implementation before it is trusted. Revert the break afterwards, and say in the task report which break was tried.
- Theme colours in theme JSON are `#rrggbb` hex only. CSS variables hold HSL triplets (`"210 33% 97%"`), so Tailwind's `/alpha` modifiers keep working.
- **Element-kind colour classes.** Every UI task applies these where the element appears:
  - `text-heading`: section and pane headings
  - `text-session-title`: session titles, in the sidebar and the header
  - `text-tag`: tags
  - `text-timestamp`: audio clock times
  - `text-date`: dates
  - `text-link`: link-like and text buttons
  - `bg-search-highlight`: matched snippet text
- **No hard-coded colours in `src/**/*.tsx`**, apart from `src/probe/**` and tests. `src/transcription/rasterize.ts` stays white `#ffffff` background and black `#000000` ink, always.
- **Default look** (every built-in theme):
  - corner radius `0px`
  - no resting borders on controls; regions are told apart by background tints
  - hover adds `bg-hover` and an outline in `--hover-outline`
  - `focus-visible` always shows a ring in `--focus-ring`
- The quick header search box is **always plain text**. Regex exists only in advanced search and in the sidebar's advanced filter.
- Smart search's pipeline (`src/search/smartSearch.ts`, `prompts.ts`, `screenBatch.ts`, `validate.ts`) is not modified.
- Live capture behaviour is not modified. This covers:
  - the K15 lock
  - the K16 writing-destination banner
  - Resume
  - Type page
  - pen-on-typed-page opening a live page
- New settings keys go in `src/storage/settingKeys.ts`. No `DB_VERSION` bump.
- Commit after each task with a conventional message ending in
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A persisted selection naming a note or recording that has since been deleted**, or a reload with an empty library. The view falls back quietly (active note, else newest session, else newest uncategorized, else empty state), with no crash and no error banner. Pinned in Task 9 and Task 13.
2. **A corrupt theme anywhere it can enter:** a hand-edited `localStorage` mirror, a malformed `ui.customThemes` entry, or an imported `.json` that is not a theme. The app always renders, falling back to Light, and an import shows an error naming the problem. Pinned in Task 1, Task 2 and Task 16.
3. **Hostile or broken regex** (`(a+)+$`, `[`, a 10,000-character pattern) in the sidebar or advanced search. It shows an inline error, the list is not emptied, and the tab never freezes. Pinned in Task 6 and Task 8.
4. **A just-started live session with zero finished pages and zero finished recordings.** Both halves render their empty or live state, with no crash. Pen ink appears on the live canvas immediately. Pinned in Task 11 and Task 13.
5. **Handwriting in a dark theme.** On-screen ink must contrast with the canvas, while the OCR raster stays white/black. Pinned in Task 5.

---

### Task 1: Theme model, validation and the five built-ins

**Files:**
- Create: `src/themes/types.ts`, `src/themes/color.ts`, `src/themes/parseTheme.ts`, `src/themes/builtins.ts`
- Create: `src/themes/builtin/light.json`, `dark.json`, `midnight-blue.json`, `rainbow.json`, `sakura.json`
- Test: `src/themes/parseTheme.test.ts`, `src/themes/color.test.ts`, `src/themes/builtins.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export const THEME_COLOR_TOKENS = [
    'background','foreground','surface','surface-foreground','surface-raised','surface-raised-foreground',
    'muted','muted-foreground','primary','primary-foreground','secondary','secondary-foreground',
    'accent','accent-foreground','destructive','destructive-foreground','border','input',
    'focus-ring','hover-bg','hover-outline','selected-bg','selected-bar','overlay',
    'heading','session-title','tag','timestamp','date','link','search-highlight',
    'status-ok','status-warn','status-error','canvas-bg','ink',
    'score-red','score-orange','score-amber','score-lime','score-green',
  ] as const;
  export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
  export interface ThemeShape { radius: string; borderWidth: string }
  export interface ThemeFonts { ui: string; mono: string; transcript: string }
  export interface Theme {
    id: string; name: string; builtIn: boolean; base: 'light' | 'dark';
    colors: Record<ThemeColorToken, string>; shape: ThemeShape; fonts: ThemeFonts;
  }
  // color.ts
  export function isHexColor(value: unknown): value is string;   // /^#[0-9a-f]{6}$/i
  export function hexToHslTriplet(hex: string): string;          // "#ffffff" -> "0 0% 100%"
  // parseTheme.ts
  export type ParseThemeResult =
    | { ok: true; theme: Theme; warnings: string[] }
    | { ok: false; error: string };
  export function parseTheme(input: unknown, fallback: Theme): ParseThemeResult;
  // builtins.ts
  export const LIGHT_THEME_ID = 'light';
  export const BUILT_IN_THEMES: readonly Theme[];   // order: light, dark, midnight-blue, rainbow, sakura
  export function lightTheme(): Theme;
  ```

- [ ] **Step 1: Write the failing tests**
  - `color.test.ts`:
    - `hexToHslTriplet('#ffffff') === '0 0% 100%'`
    - `hexToHslTriplet('#000000') === '0 0% 0%'`
    - `hexToHslTriplet('#ff0000') === '0 100% 50%'`
    - `isHexColor` rejects `'#fff'`, `'red'`, `'rgb(0,0,0)'` and `'#ff00001'`
  - `parseTheme.test.ts`. `fallback` is `lightTheme()` throughout.
    - `'rejects a non-object'`: `parseTheme('x', fallback).ok === false`. Same for `null` and `[]`.
    - `'requires an id slug and a name'`: `id: 'Bad Id!'` → not ok, with an error mentioning `id`. A missing `name` → not ok.
    - `'fills a missing or invalid colour from the fallback, with a warning'`: `colors: { background: '#123456', tag: 'pink' }`. Result: `theme.colors.background === '#123456'`, `theme.colors.tag === fallback.colors.tag`, `theme.colors.ink === fallback.colors.ink`, and `warnings` contains a string mentioning `tag`.
    - `'ignores unknown colour tokens'`: `colors: { nope: '#000000' }` → ok, and `'nope' in theme.colors === false`.
    - `'forces builtIn to false'`: input `builtIn: true` → `theme.builtIn === false`.
    - `'validates shape'`: `radius: '4px'` is kept, `radius: '1em'` falls back with a warning, and `borderWidth: '0.5rem'` is kept.
    - `'rejects font values that could inject CSS'`: `fonts.ui: 'x; color: red'`, `'url(http://a)'` and a 201-character string each fall back with a warning.
    - `'base defaults to light'`: a missing or invalid `base` gives `'light'`.
  - `builtins.test.ts`:
    - five themes, with ids `['light','dark','midnight-blue','rainbow','sakura']`
    - every one has `builtIn === true`
    - every one round-trips through `parseTheme(json, lightTheme())` with `warnings.length === 0`
    - every one has `shape.radius === '0px'`
    - `rainbow` has at least five distinct values among `heading, tag, timestamp, date, link`
    - for every theme, the relative-luminance contrast of `ink` against `canvas-bg` is at least 4.5
    - for every theme, the contrast of `foreground` against `background` is at least 4.5

    Put a small `contrastRatio(hexA, hexB)` in `color.ts`, exported, so the builder can reuse it.

- [ ] **Step 2: Run them and confirm they fail:** `npx vitest run src/themes`. They fail because the modules don't exist yet.

- [ ] **Step 3: Implement the module.** `parseTheme` copies only known keys. Accepted values:
  - `id` matches `^[a-z0-9-]{1,40}$`
  - `name` is a trimmed string of 1–60 characters
  - `shape` values match `^\d+(\.\d+)?(px|rem)$`
  - fonts are strings of at most 200 characters with no `;`, `{`, `}` or `url(`

  `builtins.ts` imports the five JSON files, runs each through `parseTheme`, then sets `builtIn = true`. It throws at module load if a bundled theme fails, since that is a build defect.

  Palettes follow the spec's "The five built-ins". Light gives `canvas-bg` `#ffffff` and `ink` `#111111`. Dark-base themes give a dark `canvas-bg` and a light `ink`. Rainbow gives:
  - `heading` yellow `#ffd866`
  - `tag` magenta `#ff6ac1`
  - `timestamp` cyan `#5ad4e6`
  - `date` green `#a9dc76`
  - `link` orange `#fc9867`

  It sits on a charcoal background (`#1e1f22`). The score bands keep red, orange, amber, lime and green hues in every theme, shaded to fit.

  Fonts in every built-in:
  - `ui`: `'TASA Orbiter', ui-sans-serif, system-ui, sans-serif`
  - `mono`: `ui-monospace, SFMono-Regular, Menlo, monospace`
  - `transcript`: same as `ui`

- [ ] **Step 4: Run the tests and confirm they pass:** `npx vitest run src/themes`.
- [ ] **Step 5: Commit:** `feat(themes): theme model, validation and five built-in themes`.

---

### Task 2: Theme runtime — apply, persist, early paint, provider

**Files:**
- Create: `src/themes/applyTheme.ts`, `src/themes/themeStore.ts`, `src/themes/ThemeProvider.tsx`
- Modify: `src/storage/settingKeys.ts` (two keys), `src/main.tsx` (early apply plus the provider)
- Test: `src/themes/applyTheme.test.ts`, `src/themes/themeStore.test.ts`, `src/themes/ThemeProvider.test.tsx`

**Interfaces:**
- Consumes: Task 1's `Theme`, `parseTheme`, `BUILT_IN_THEMES` and `lightTheme`.
- Produces:
  ```ts
  // applyTheme.ts
  /** token -> extra shadcn variable names it also writes */
  export const CSS_VAR_ALIASES: Partial<Record<ThemeColorToken, string[]>>;
  export function applyTheme(theme: Theme, root?: HTMLElement): void;
  // settingKeys.ts
  'ui.theme': string                // default 'light'
  'ui.customThemes': unknown[]      // default []
  // themeStore.ts
  export const THEME_MIRROR_KEY = 'takingnotes.activeTheme';
  export function resolveTheme(id: string, custom: readonly Theme[]): Theme;   // unknown id -> lightTheme()
  export async function loadCustomThemes(): Promise<Theme[]>;                   // drops entries parseTheme rejects
  export async function saveCustomTheme(theme: Theme): Promise<Theme[]>;        // upsert by id
  export async function deleteCustomTheme(id: string): Promise<Theme[]>;
  export function uniqueThemeId(wanted: string, taken: readonly string[]): string;  // 'x' -> 'x-2' -> 'x-3'
  export function applyMirroredThemeEarly(storage?: Pick<Storage, 'getItem'> | null): void;  // never throws
  export function writeThemeMirror(theme: Theme, storage?: Pick<Storage, 'setItem'> | null): void;  // never throws
  // ThemeProvider.tsx
  export interface ThemesContextValue {
    active: Theme; builtIns: readonly Theme[]; custom: readonly Theme[];
    setActive(id: string): Promise<void>;
    saveCustom(theme: Theme): Promise<void>;        // also activates it
    deleteCustom(id: string): Promise<void>;        // falls back to light if it was active
    preview(theme: Theme | null): void;             // null restores `active`
  }
  export function ThemeProvider(props: { children: ReactNode }): JSX.Element;
  export function useThemes(): ThemesContextValue;
  ```

- [ ] **Step 1: Write the failing tests**
  - `applyTheme`:
    - after `applyTheme(dark, el)`, `el.style.getPropertyValue('--background')` equals `hexToHslTriplet(dark.colors.background)`
    - each alias (for example `--card` from `surface`, `--popover` from `surface-raised`, `--ring` from `focus-ring`) holds the same triplet as its token
    - `--radius === dark.shape.radius`, and `--border-width` and `--font-ui` are set
    - `el.dataset.themeBase === 'dark'`, and `el.classList.contains('dark')` is true; applying Light removes the `dark` class
  - `themeStore`:
    - `'resolveTheme falls back to light for an unknown id'`
    - `'loadCustomThemes drops a malformed stored entry and keeps valid ones'`: store `[{bad:true}, validCustom]` under `ui.customThemes` with `setSettingValue`, then expect a result of length 1
    - `'saveCustomTheme upserts by id'`
    - `uniqueThemeId('light', ['light','light-2'])` returns `'light-3'`
    - `'applyMirroredThemeEarly ignores corrupt JSON'`: storage returns `'{not json'`, nothing throws, and `--background` stays unset
    - `'applyMirroredThemeEarly applies a valid mirror'`
  - `ThemeProvider` (mount a consumer that renders `active.id`):
    - with no setting stored, it renders `light`
    - `setActive('sakura')` updates the rendered id, `getSettingValue('ui.theme')`, the mirror in `localStorage`, and `document.documentElement`'s `--background`
    - `'deleting the active custom theme falls back to light'`
    - `preview(dark)` changes `--background` but not `active.id`, and `preview(null)` restores it

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
  - `applyTheme` writes `--<token>` for every token, plus the aliases. Map at least: `surface`→`card`, `surface-foreground`→`card-foreground`, `surface-raised`→`popover`, `surface-raised-foreground`→`popover-foreground`, `focus-ring`→`ring`, and `surface`→`sidebar-background`. Shape and fonts go to `--radius`, `--border-width`, `--font-ui`, `--font-mono` and `--font-transcript`. It also sets `<meta name="theme-color">` to `background` when that element exists.
  - `ThemeProvider` loads `ui.theme` and the custom themes on mount, resolves and applies them, and writes the mirror whenever the active theme changes.
  - In `main.tsx`, call `applyMirroredThemeEarly(window.localStorage)` inside a try/catch *before* `createRoot`, and wrap `<TabletProvider>` in `<ThemeProvider>`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(themes): apply, persist and provide the active theme`.

---

### Task 3: Route every colour, radius and font through tokens

**Files:**
- Modify: `src/index.css`, `tailwind.config.js`
- Modify: `src/triage/TaskList.tsx:17-21` and its test's `BAND_CLASSES`
- Modify: `src/app/DeviceStatus.tsx:48-50`, `src/capture/SessionControls.tsx:307`
- Modify: `src/components/ui/button.tsx:14`, `src/components/ui/slider.tsx:56`, `src/components/ui/dialog.tsx` (the `bg-black/50` scrim)
- Modify: `index.html` (`theme-color`)
- Test: `src/themes/noHardcodedColors.test.ts`

**Interfaces:**
- Consumes: Task 2's CSS variable names.
- Produces: Tailwind colour names for every token, used by every later task:
  - `bg-background`, `bg-surface`, `bg-surface-raised`, `bg-hover`, `bg-selected`, `bg-overlay`, `bg-search-highlight`, `bg-canvas`
  - `text-heading`, `text-session-title`, `text-tag`, `text-timestamp`, `text-date`, `text-link`, `text-ink`
  - `text-status-ok/warn/error`, `bg-status-ok/warn/error`
  - `text-score-red|orange|amber|lime|green`
  - `outline-hover-outline`, `shadow-selected-bar` (or an equivalent `selected-bar` colour)
  - `font-sans` (meaning `--font-ui`), `font-mono`, `font-transcript`
  - `rounded` (meaning `var(--radius)`)

- [ ] **Step 1: Write the failing guard test** `noHardcodedColors.test.ts`. It uses `import.meta.glob('/src/**/*.tsx', { query: '?raw', import: 'default', eager: true })`, excluding paths containing `/probe/` and `.test.`. It asserts that no file matches:
  - `/\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|shadow)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})\b/`
  - `/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/`

  A second `it` reads `/src/index.css?raw` and asserts that it contains no hex colour and no `rgb(`. The failure message lists the offending file and match.
- [ ] **Step 2: Run it and confirm it fails**, listing `TaskList.tsx`, `DeviceStatus.tsx`, `SessionControls.tsx`, `button.tsx`, `slider.tsx`, `dialog.tsx`, `InkCanvas.tsx` and `index.css`. `InkCanvas.tsx` is fixed in Task 5. Until then, mark only that file with a `KNOWN_UNTIL_TASK_5` allowlist, which Task 5 removes.
- [ ] **Step 3: Rewrite `src/index.css`.**
  - The `:root` block holds Light's token values as HSL triplets, so the first paint before JS is Light.
  - Delete every legacy rule `grep` shows unused in `src`. Verified unused at plan time: `.react-colorful*`, `.app-*`, `.memory-library-*`, `.tablet-*`, `.no-select`, `.animate-pulse-record`, `@keyframes pulse-record`, `tab-attention-pulse`, and every `.light …` override.
  - Scrollbar rules use `hsl(var(--muted))` and `hsl(var(--muted-foreground))`.
  - Keep the Google Fonts import.
  - `*:focus-visible` uses `hsl(var(--focus-ring))`.
- [ ] **Step 4: Update `tailwind.config.js`.**
  - Add a colour for every token as `hsl(var(--<token>) / <alpha-value>)`.
  - Add `borderRadius.DEFAULT: 'var(--radius)'` and keep the existing scale.
  - Add `borderWidth.DEFAULT: 'var(--border-width)'`.
  - Add `fontFamily: { sans: 'var(--font-ui)', mono: 'var(--font-mono)', transcript: 'var(--font-transcript)' }`.
  - Keep `darkMode: ['class']`. Task 2 toggles `.dark`.
- [ ] **Step 5: Replace the palette classes.**
  - `TaskList` bands become `text-score-*`, and the test's `BAND_CLASSES` follows.
  - The `DeviceStatus` dots become `bg-status-warn` and `bg-status-ok`.
  - `SessionControls` uses `text-status-warn`.
  - `button` destructive uses `text-destructive-foreground`.
  - `slider` uses `bg-background`.
  - The dialog scrim uses `bg-overlay/60`.
  - `index.html`'s `theme-color` becomes Light's background hex. That file is HTML, not `.tsx`, so it is allowed.
- [ ] **Step 6: Run the guard test, then everything:** `npx vitest run src/themes src/triage src/app src/capture` and `npx tsc -b`. Expect pass. Mutation check: re-add `bg-white` to `slider.tsx` and confirm the guard fails.
- [ ] **Step 7: Commit:** `refactor(styles): route every colour, radius and font through theme tokens`.

---

### Task 4: The default visual language in the shared primitives, plus a Switch

**Files:**
- Modify: `src/components/ui/button.tsx`, `tabs.tsx`, `input.tsx`, `dialog.tsx`, `select.tsx`
- Create: `src/components/ui/switch.tsx`
- Test: `src/components/ui/switch.test.tsx`, `src/components/ui/primitives.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface SwitchProps {
    checked: boolean; onCheckedChange(checked: boolean): void;
    offLabel: string; onLabel: string;          // rendered left and right of the track
    'aria-label': string; disabled?: boolean;
  }
  export function Switch(props: SwitchProps): JSX.Element;   // <button role="switch" aria-checked>
  export const HOVER_AFFORDANCE: string;   // shared class string: transparent outline at rest; hover: bg-hover + outline-hover-outline
  ```

- [ ] **Step 1: Write the failing tests**
  - Switch:
    - it renders `role="switch"` with `aria-checked="false"`
    - a click calls `onCheckedChange(true)`
    - Space and Enter do the same, which a native button gives you
    - a disabled switch does not call back
    - both labels are rendered
  - Primitives:
    - a `Button` with `variant="outline"` and one with `variant="ghost"` include `HOVER_AFFORDANCE`'s classes and contain no `border-input` or resting `bg-` fill class
    - every variant keeps a `focus-visible:` ring class
    - `TabsTrigger` with `data-state="active"` carries the active-underline class (`data-[state=active]:shadow-[inset_0_-3px_0_hsl(var(--primary))]` or equivalent) and no `rounded-md`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **Button variants:**
    - `default` uses `text-primary font-semibold` with no fill at rest
    - `destructive` uses `text-destructive`
    - `outline`, `secondary` and `ghost` are text-only at rest
    - every variant gets `HOVER_AFFORDANCE` and `rounded`, which resolves to `--radius`
  - **Tabs:**
    - `TabsList` has no background or padding pill
    - `TabsTrigger` is `text-base px-5 py-2` with an underline when active
  - **Input and select triggers:** `bg-muted`, no resting border, and the ring on focus.
  - **Dialog content:** `bg-surface-raised`, no border, `rounded`.
- [ ] **Step 4: Run** `npx vitest run src/components src/app src/notes src/triage src/audio src/capture`. Snapshot-free tests that assert old class names may need updating. Update only assertions about appearance, never behaviour, and list each one in the commit body.
- [ ] **Step 5: Commit:** `feat(ui): sharp hover-only visual language and a Switch primitive`.

---

### Task 5: Themed on-screen ink, untouched OCR raster

**Files:**
- Modify: `src/transcription/rasterize.ts:70-84` (`drawStrokes` takes colours)
- Modify: `src/notes/InkCanvas.tsx`
- Modify: `src/themes/noHardcodedColors.test.ts` (remove the Task 3 allowlist)
- Test: `src/transcription/rasterize.test.ts` (extend), `src/notes/InkCanvas.test.tsx` (create)

**Interfaces:**
- Consumes: `useThemes()` from Task 2.
- Produces:
  ```ts
  export interface InkColors { background: string; ink: string }
  export const RASTER_INK: InkColors;   // { background: '#ffffff', ink: '#000000' }
  export function drawStrokes(ctx: InkContext, strokes: readonly PageStroke[], size: RasterSize, colors?: InkColors): void; // default RASTER_INK
  ```

- [ ] **Step 1: Write the failing tests**
  - Rasterize: `'the OCR raster stays white on black ink whatever theme is applied'`. Call `applyTheme(darkTheme, document.documentElement)`, run the module's page-render path (the exported function that produces the image for the model) against a recording fake context, and assert that the first `fillStyle` is `'#ffffff'` and the `strokeStyle` is `'#000000'`.
  - InkCanvas: with `ThemeProvider` active on Dark, mount `<InkCanvas strokes={[oneStroke]} dims=…/>`. Stub `HTMLCanvasElement.prototype.getContext` to a recording fake, as `NotesView.test.tsx` does. Assert that the first `fillStyle` equals `dark.colors['canvas-bg']`, the `strokeStyle` equals `dark.colors.ink`, and the canvas element has no `bg-white` class.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - `drawStrokes` uses `colors.background` and `colors.ink`.
  - Every rasterize call site keeps passing nothing, which means `RASTER_INK`.
  - `InkCanvas` passes `{ background: active.colors['canvas-bg'], ink: active.colors.ink }`, adds the theme to its draw callback's dependencies so a theme switch repaints, and uses `bg-canvas` instead of `border bg-white`.
  - Update `InkCanvas`'s header comment ("plain black ink"). The shared-geometry claim still holds, but the on-screen colours now differ from the raster by design.
- [ ] **Step 4: Run** `npx vitest run src/transcription src/notes src/themes`. Expect pass. Mutation check: make `InkCanvas` pass `RASTER_INK` and confirm the InkCanvas test fails.
- [ ] **Step 5: Commit:** `feat(ink): canvas follows the theme; OCR raster stays white and black`.

---

### Task 6: Pattern matcher and Find options (regex, filters)

**Files:**
- Create: `src/search/matcher.ts`
- Modify: `src/search/find.ts`
- Test: `src/search/matcher.test.ts`, `src/search/find.test.ts` (extend only; existing tests stay untouched and must still pass)

**Interfaces:**
- Produces:
  ```ts
  // matcher.ts
  export const MAX_PATTERN_LENGTH = 200;
  export interface TextMatcher {
    test(text: string): boolean;
    firstMatch(text: string): { index: number; length: number } | null;
  }
  export type MatcherResult = { ok: true; matcher: TextMatcher } | { ok: false; error: string };
  export function compileMatcher(query: string, options: { regex: boolean }): MatcherResult;
  // find.ts
  export interface FindOptions {
    regex?: boolean;
    from?: number | null;        // epoch ms, inclusive
    to?: number | null;          // epoch ms, inclusive
    tags?: readonly string[];
    tagMode?: TagFilterMode;     // from '@/notes/tagFilter'; default 'or'
    sources?: readonly FindHitSource[];   // default: all four
  }
  export function findInCorpus(corpus: SearchCorpus, query: string, options?: FindOptions): FindHit[];
  export function snippetAt(text: string, index: number, length: number, radius?: number): string;
  ```

- [ ] **Step 1: Write the failing tests**
  - Matcher:
    - plain mode is case-insensitive substring, and `'a.b'` in plain mode does **not** match `'axb'`
    - regex mode: `'a.b'` matches `'AXB'`, since it is case-insensitive
    - `firstMatch` returns the index and length of the match
    - `'['` gives `ok: false` with an error starting `Invalid pattern`
    - a pattern of `MAX_PATTERN_LENGTH + 1` characters gives `ok: false` naming the limit
    - `'(a+)+$'`, `'(a*)*'`, `'(\\w+\\s?)+$'` and `'(a|aa)+'` each give `ok: false` with an error containing `too long to run`
    - `test()` called twice on the same text returns `true` both times, which proves no `g`/`lastIndex` state
  - Find, as new `describe('FindOptions')` cases:
    - `regex: true` with `'reconstr\\w+'` finds a page-text hit, and its snippet contains the matched word
    - an invalid regex returns `[]` without throwing
    - `from`/`to` exclude a note outside the range, and an orphan audio hit is dated by `recording.startedAt`
    - `tags: ['hist']` excludes a note without that tag and every hit whose `noteId` is null
    - `sources: ['audio-segment']` returns only audio hits
    - `'regex mode has no minimum length'`: `'x'` with `regex: true` can match
    - `'no options behaves exactly as before'`: deep-equal to calling it with `{}`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **The `compileMatcher` guard.** After `new RegExp(query, 'i')` succeeds, reject a pattern if it contains a quantified group whose body itself contains a quantifier or an alternation. Detect that with a small scanner over the pattern that tracks group depth, not a single regex. This is the regex-safety mechanism the spec leaves to the builder: a length cap plus a nested-repetition rejection. State that in the file header.
  - **`findInCorpus`.** Compile once, then use `matcher.test` and `snippetAt` in place of `includes` and `snippetAround`. Plain mode keeps `MIN_QUERY_LENGTH`.
- [ ] **Step 4: Run** `npx vitest run src/search`. Expect every test in the folder to pass.
- [ ] **Step 5: Commit:** `feat(search): regex matcher with a safety guard, and Find filters`.

---

### Task 7: The session catalog

**Files:**
- Create: `src/sessions/catalog.ts`, `src/sessions/useSessionCatalog.ts`
- Test: `src/sessions/catalog.test.ts`, `src/sessions/useSessionCatalog.test.tsx`

**Interfaces:**
- Consumes: `recordingOwnersByNote`, `listFinishedRecordings` (`src/storage/recordings.ts`) and `listNotes`.
- Produces:
  ```ts
  export type EntryKey = `note:${string}` | `recording:${string}`;
  export type SessionEntry =
    | { kind: 'note'; key: `note:${string}`; note: NoteRecord; recordings: RecordingRecord[] } // startedAt ascending
    | { kind: 'recording'; key: `recording:${string}`; recording: RecordingRecord };
  export interface SessionCatalog { sessions: SessionEntry[]; uncategorized: SessionEntry[] } // each newest first
  export function noteKey(noteId: string): `note:${string}`;
  export function recordingKey(recordingId: string): `recording:${string}`;
  export function buildSessionCatalog(notes: readonly NoteRecord[], finished: readonly RecordingRecord[]): SessionCatalog;
  export function findEntry(catalog: SessionCatalog, key: string | null): SessionEntry | null;
  export function entryStartedAt(entry: SessionEntry): number;
  export function entryTitle(entry: SessionEntry): string;
  export function useSessionCatalog(deps: {
    transcriptionQueue: { subscribe(l: () => void): () => void };
    audioQueue: { subscribeChanges(l: () => void): () => void };
    namingQueue: { subscribe(l: () => void): () => void };
  }): { catalog: SessionCatalog; loaded: boolean; reload(): void };
  ```

- [ ] **Step 1: Write the failing tests**
  - `catalog.test.ts`:
    - a note with `sessionId: 's1'` is in `sessions`, and a note with `sessionId: null` or no `sessionId` is in `uncategorized`
    - recordings attach to their note directly (`noteId`) and through the session (`sessionId` matching the note's), ordered by `startedAt` ascending
    - `'a recording with no owning note is its own uncategorized entry'`
    - both lists are newest first by `startedAt`, and uncategorized interleaves notes and recordings by date
    - `findEntry(catalog, 'note:missing') === null`
  - `useSessionCatalog.test.tsx` (inside a `CaptureProvider` with a fake engine; see `NotesView.test.tsx`):
    - it loads on mount
    - it reloads when each fake queue's listener fires, and when capture state's `activeNoteId` changes
    - `'an older load resolving after a newer one never wins'`: two reloads with controlled deferred storage resolve out of order, and the newer result stays. This ports `RecordingsView`'s sequence guard.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Build the catalog with `recordingOwnersByNote`, so there is still one place that knows both link paths.
  - The hook reloads on `useCaptureState()`'s `activeNoteId`, `activePageId` and `pageIndex`, on the three queue signals, and on `reload()`, with a sequence counter.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(sessions): session catalog grouping notes and recordings`.

---

### Task 8: Sidebar filter logic

**Files:**
- Create: `src/sessions/filter.ts`, `src/sessions/useEntryText.ts`
- Test: `src/sessions/filter.test.ts`

**Interfaces:**
- Consumes:
  - `compileMatcher` (Task 6)
  - `SessionCatalog` and `SessionEntry` (Task 7)
  - `matchesTagFilter` and `TagFilterMode` (`src/notes/tagFilter.ts`)
  - `loadSearchCorpus` (`src/search/corpus.ts`)
- Produces:
  ```ts
  export interface AdvancedFilter {
    from: string | null; to: string | null;        // 'yyyy-mm-dd', local days, inclusive
    tags: string[]; tagMode: TagFilterMode;
    title: string; text: string;
    hasRecording: boolean; hasTypedPage: boolean;
    statuses: NoteRecord['status'][];              // empty = any
    regex: boolean;                                // applies to title and text
  }
  export interface SidebarFilter { quick: string; advanced: AdvancedFilter }
  export const EMPTY_SIDEBAR_FILTER: SidebarFilter;
  export function isAdvancedActive(filter: AdvancedFilter): boolean;
  export interface EntryText { text: string; hasTypedPage: boolean }  // page transcripts + typed + summary + audio text, joined
  export interface FilterOutcome { sessions: SessionEntry[]; uncategorized: SessionEntry[]; error: string | null; pending: boolean }
  export function filterCatalog(
    catalog: SessionCatalog, filter: SidebarFilter,
    textByKey: ReadonlyMap<string, EntryText> | null, activeNoteId: string | null,
  ): FilterOutcome;
  export function useEntryText(needed: boolean, catalogRevision: unknown): ReadonlyMap<string, EntryText> | null;
  ```

- [ ] **Step 1: Write the failing tests.** Fixtures: one catalog with three session notes (tags, dates, statuses, typed and recorded variety), one uncategorized note and one orphan recording.
  - The quick filter is a case-insensitive substring over the title and tags. `'hist'` keeps the notes tagged `hist210`. `'.'` matches only titles containing a literal dot: the quick box is never regex.
  - Date range: `from: '2026-10-14', to: '2026-10-14'` keeps only the Oct 14 entries, using local-day bounds.
  - Tags `['hist210']` with `tagMode: 'and'` versus `'or'` follow `matchesTagFilter`.
  - `hasRecording` keeps note entries with recordings and every orphan-recording entry.
  - `statuses: ['interrupted']` keeps only interrupted notes and drops orphan recordings.
  - `title` with `regex: true` and `'^HIST \\d+'` keeps the matching titles.
  - `'an invalid regex reports an error and does not empty the list'`: `title: '['` with `regex: true` gives a non-null `error`, and both lists equal the quick-filtered lists.
  - `'text criteria wait for the text index'`: with `text: 'bureau'` and `textByKey === null`, the result has `pending: true` and lists unchanged by the text criterion. With the map, only the matching entries remain.
  - `'the active note is never hidden'`: a filter that excludes it still returns it.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - `useEntryText` builds its map from `loadSearchCorpus()` only when `needed` is true. Each note maps to its page text, summary and `audioText`, plus `hasTypedPage` from `pages.some(p => p.isTyped)`. Each orphan recording maps to its done transcript text.
  - Tags in the advanced panel are chips from the vocabulary, matched exactly. Regex applies to title and text. *(Plan call: a chip list cannot hold a pattern, and the quick box already substring-matches tags.)*
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(sessions): sidebar quick and advanced filtering`.

---

### Task 9: Sessions UI store — selection that survives, and live follow

**Files:**
- Create: `src/sessions/sessionsUiStore.ts`, `src/sessions/SessionsUiContext.tsx`, `src/sessions/useLiveFollow.ts`
- Test: `src/sessions/sessionsUiStore.test.ts`, `src/sessions/useLiveFollow.test.tsx`

**Interfaces:**
- Consumes: `SidebarFilter` and `EMPTY_SIDEBAR_FILTER` (Task 8), `noteKey` and `recordingKey` (Task 7).
- Produces:
  ```ts
  export type MainTab = 'sessions' | 'triage';
  export type NotesMode = 'handwriting' | 'transcription';
  export interface SeekRequest { token: number; recordingId: string; startMs: number }
  export interface SessionsUiState {
    tab: MainTab; selectedKey: string | null; pageIndex: number;
    recordingId: string | null; notesMode: NotesMode;
    seek: SeekRequest | null; sidebarFilter: SidebarFilter; advancedFilterOpen: boolean;
  }
  export const SESSIONS_UI_STORAGE_KEY = 'takingnotes.sessionsUi';
  export interface SessionsUiStore {
    getState(): SessionsUiState; subscribe(listener: () => void): () => void;
    setTab(tab: MainTab): void;
    selectEntry(key: string): void;                 // resets pageIndex 0, recordingId null
    goToPage(index: number): void;
    selectRecording(recordingId: string | null): void;
    setNotesMode(mode: NotesMode): void;
    setSidebarFilter(filter: SidebarFilter): void;
    setAdvancedFilterOpen(open: boolean): void;
    openNote(noteId: string, pageIndex: number, mode?: NotesMode): void;           // tab -> sessions
    openRecording(recordingId: string, startMs: number | undefined, ownerNoteId: string | null): void; // tab -> sessions, seek token
    clearSeek(token: number): void;                 // no-op if a newer token is pending
    followActiveNote(noteId: string, pageIndex: number): void;  // tab -> sessions
    followPage(pageIndex: number): void;
  }
  export function createSessionsUiStore(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): SessionsUiStore;
  // SessionsUiContext.tsx
  export function SessionsUiProvider(props: { store: SessionsUiStore; children: ReactNode }): JSX.Element;
  export function useSessionsUi(): [SessionsUiState, SessionsUiStore];
  // useLiveFollow.ts — mounted once in AppShell
  export function useLiveFollow(store: SessionsUiStore): void;
  ```

- [ ] **Step 1: Write the failing tests**
  - `'persists selection, page, recording and notes mode; restores them in a new store'`: use one in-memory storage shared by two `createSessionsUiStore` calls.
  - `'does not persist the sidebar filter or the tab'`: a new store has `EMPTY_SIDEBAR_FILTER` and `tab: 'sessions'`.
  - `'corrupt persisted JSON yields defaults without throwing'`, and the same when `storage` is null or `getItem` throws.
  - `openRecording('r1', 4200, 'n1')` gives `selectedKey === 'note:n1'`, `recordingId === 'r1'`, `seek.startMs === 4200` and `tab === 'sessions'`. With `ownerNoteId` null it gives `selectedKey === 'recording:r1'`.
  - `'each openRecording issues a fresh seek token, even for the same target'`. This ports the `createNavigationTargetFactory` contract.
  - `clearSeek(oldToken)` after a newer request keeps the newer one.
  - `openNote('n2', 3, 'transcription')` sets the page and mode.
  - `useLiveFollow`, with a fake engine driving capture state:
    - `'a note becoming active switches to Sessions and selects it, even from Triage while viewing another session'`
    - `'a page turn on the viewed active note is followed'`
    - `'a page turn is not followed while viewing a different note'`
    - `'the initial render does not override a restored selection'`: the active note on mount equals the previous one, as in `NotesView`'s `prevActiveNoteId` rule
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Writes to storage are wrapped in try/catch.
  - `useLiveFollow` keeps `NotesView.tsx:281-333`'s previous-value comparison semantics. The view-local parts (the external token and the default fallback) move to Task 13.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(sessions): persisted Sessions UI store and live-capture follow`.

---

### Task 10: Session sidebar component

**Files:**
- Create: `src/sessions/SessionSidebar.tsx`, `src/sessions/AdvancedFilterPanel.tsx`
- Test: `src/sessions/SessionSidebar.test.tsx`

**Interfaces:**
- Consumes: `FilterOutcome`, `SidebarFilter` and `isAdvancedActive` (Task 8); `entryTitle`, `entryStartedAt` and `SessionEntry` (Task 7); `Switch` (Task 4).
- Produces:
  ```ts
  export interface SessionSidebarProps {
    outcome: FilterOutcome; selectedKey: string | null; activeNoteId: string | null;
    filter: SidebarFilter; onFilterChange(filter: SidebarFilter): void;
    advancedOpen: boolean; onAdvancedOpenChange(open: boolean): void;
    vocabulary: readonly string[];
    onSelect(key: string): void;
  }
  export function SessionSidebar(props: SessionSidebarProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**
  - Rendering:
    - the quick input has `aria-label="Filter sessions"`, and typing calls `onFilterChange` with an updated `quick`
    - group headings read `Sessions · 3` and `Uncategorized · 2`
    - each entry is a `button[data-entry-key]` showing its title, its date (`text-date`) and its tags (`text-tag`)
    - the selected entry has `aria-current="true"`
    - an orphan recording entry shows the recording's title
  - Advanced filter:
    - the "Advanced filter" toggle has `aria-expanded`, and opening it shows date inputs, tag chips from `vocabulary`, an any/all control, title and text inputs, "Has recording" and "Has typed page", status choices, a `Switch` labelled `Regex`, and Clear
    - `outcome.error` renders in `role="alert"` and the list is still shown
    - `outcome.pending` renders "Searching text…"
    - an empty group still renders its heading with `· 0`
    - Clear resets to `EMPTY_SIDEBAR_FILTER`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**, following the mockup v3 look: `bg-surface`, entries with `HOVER_AFFORDANCE`, and the selected entry with `bg-selected` plus an inset left bar in `selected-bar`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(sessions): sidebar with quick and advanced filters`.

---

### Task 11: Session header and notes half

**Files:**
- Create: `src/sessions/SessionHeader.tsx`, `src/sessions/NotesHalf.tsx`, `src/sessions/useNotePages.ts`
- Modify: `src/notes/NoteToolbar.tsx`. Drop the `noteTitle`, `title`, `meta` and `banner` props, since those move to `SessionHeader`. Keep New note, End note, `actions`, page navigation and the lock. Centre the page navigation.
- Modify: `src/notes/NoteToolbar.test.tsx` to follow.
- Test: `src/sessions/SessionHeader.test.tsx`, `src/sessions/NotesHalf.test.tsx`

**Interfaces:**
- Consumes:
  - `Switch` (Task 4)
  - `SessionEntry` (Task 7)
  - `NotesMode` (Task 9)
  - the existing `NoteTitle`, `TagEditor`, `ResumeButton`, `TranscriptPanel`, `GapPanel`, `TypedPageEditor` and `InkCanvas`, with props as used in `src/notes/NotesView.tsx:404-545`
- Produces:
  ```ts
  export interface SessionHeaderProps {
    entry: SessionEntry | null; activeNoteId: string | null; sessionLocked: boolean;
    writingDestinationTitle: string | null;   // non-null => K16 banner
    onChanged(): void;
  }
  export interface NotesHalfProps {
    entry: SessionEntry | null; pages: PageRecord[]; pageIndex: number; onGoToPage(i: number): void;
    mode: NotesMode; onModeChange(mode: NotesMode): void;
    transcriptionQueue: TranscriptionQueue;
  }
  export function useNotePages(noteId: string | null, transcriptionQueue: TranscriptionQueue): PageRecord[]; // the stale-note guard from useNotesData.ts:96-103,170
  ```

- [ ] **Step 1: Write the failing tests**
  - `SessionHeader`:
    - for a note entry it renders `NoteTitle`, `TagEditor` and a Resume button
    - for a recording entry it renders the recording title and no Resume
    - for `null` it renders nothing
    - the banner text is exactly `Writing still goes to "<title>"` in `role="status"`, shown only when `writingDestinationTitle` is non-null
  - `NotesHalf`:
    - `'the switch is centred and defaults to Handwriting'`: there is a `role="switch"` with `aria-checked="false"`, inside a container with `justify-center`
    - in Handwriting mode an ink page renders `canvas[aria-label="Page ink"]` and a typed page renders `TypedPageEditor`
    - `'Transcription mode shows gap analysis above the transcript'`: the `GapPanel` root's `compareDocumentPosition` with `TranscriptPanel`'s root shows it precedes it (`DOCUMENT_POSITION_FOLLOWING`)
    - `'the live page shows live ink'`: when `pages[i].id === state.activePageId`, the canvas is live
    - `'a note entry with no pages shows an empty prompt and no canvas'`: the text includes `Resume this session to write or type a page`
    - a recording entry renders an empty half
    - Type page is disabled with no active note and while a resume is pending; this ports the `NotesView` tests for that gating
    - New note is disabled while the session is locked or a resume is pending (ported)
    - page arrows call `onGoToPage`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Move the Type page debounce and `handleTypePage` (`NotesView.tsx:366-383`) into `NotesHalf`. Move the lock calculation (`NotesView.tsx:390-400`) to the caller (Task 13), which passes `sessionLocked` to both components.
- [ ] **Step 4: Run** `npx vitest run src/sessions src/notes`. Expect pass.
- [ ] **Step 5: Commit:** `feat(sessions): session header and notes half with transcription switch`.

---

### Task 12: Audio half, with seeking and renaming in `RecordingDetail`

**Files:**
- Create: `src/sessions/AudioHalf.tsx`
- Modify: `src/recordings/RecordingDetail.tsx`. Add the `seek` and `onRenamed` props and an inline title rename.
- Test: `src/sessions/AudioHalf.test.tsx`, `src/recordings/RecordingDetail.test.tsx` (create, or extend if the builder finds RecordingDetail coverage inside `RecordingsView.test.tsx`; move it)

**Interfaces:**
- Consumes: `SeekRequest` (Task 9) and `updateRecording` (`src/storage/recordings.ts:65`).
- Produces:
  ```ts
  // RecordingDetail gains:
  seek?: { token: number; startMs: number };   // applied once per token, after the audio URL is ready
  onSeekApplied?: (token: number) => void;
  onRenamed?: () => void;
  export interface AudioHalfProps {
    recordings: RecordingRecord[];                // ascending startedAt
    selectedRecordingId: string | null; onSelectRecording(id: string): void;
    seek: SeekRequest | null; onSeekApplied(token: number): void;
    followNewest: boolean;                        // true while this entry is the live note
    audioQueue: AudioTranscriptionQueue; onChanged(): void;
  }
  ```

- [ ] **Step 1: Write the failing tests**
  - `AudioHalf`:
    - with three recordings it shows `Recording 1 of 3` plus ‹ and › buttons; › calls `onSelectRecording` with the second id; ‹ is disabled on the first and › on the last
    - an unknown or null `selectedRecordingId` renders the first recording
    - zero recordings renders an empty half with no player
    - `'a new recording for the live session becomes selected'`: rerender with `followNewest` and one more recording, and expect `onSelectRecording` with the newest id
    - with `followNewest: false`, a new recording does not change the selection
  - `RecordingDetail`:
    - `'a seek request sets currentTime once per token'`: mount with fake audio bytes and `seek {token:1,startMs:42000}`, and expect `audio.currentTime === 42` and `onSeekApplied(1)`. Rerender with the same token, with `currentTime` manually reset to 0: it stays 0. A new token seeks again.
    - rename: click the title, type, press Enter, and expect `getRecording(id).title` to be updated and `onRenamed` called. Escape cancels. A blank title is rejected.
  - Transcription status and controls still render above the segment list (commit `127fb56`); keep that test.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** with the mockup's "‹ Recording N of M ›" row and `text-timestamp` clock links.
- [ ] **Step 4: Run** `npx vitest run src/sessions src/recordings`. Expect pass.
- [ ] **Step 5: Commit:** `feat(sessions): audio half with recording arrows, seek-on-request and rename`.

---

### Task 13: SessionsView and the new shell

**Files:**
- Create: `src/sessions/SessionsView.tsx`
- Modify: `src/app/AppShell.tsx` (rewrite the layout and drop `createNavigationTargetFactory`) and `src/app/AppShell.test.tsx` (rewrite)
- Delete: `src/notes/NotesView.tsx`, `NotesView.test.tsx`, `NoteList.tsx`, `NoteList.test.tsx`, `TagFilterBar.tsx`, `TagFilterBar.test.tsx`, `useNotesData.ts`, `useNotesData.test.tsx`, `src/recordings/RecordingsView.tsx`, `RecordingsView.test.tsx`
  - Keep `tagFilter.ts`, which Task 8 uses.
  - **Before each deletion**, list the file's `it(...)` names in the commit body, each mapped to its replacement test (Tasks 7–12, or this task) or to a one-line reason it no longer applies.
- Test: `src/sessions/SessionsView.test.tsx`, `src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 7–12, plus `ensureTranscriptionQueue`, `ensureNamingQueue` and `getAudioRuntime().queue`. Those were built in `NotesView` and `RecordingsView`, and now they are built here.
- Produces: `export function SessionsView(props?: { queue?: TranscriptionQueue; namingQueue?: NamingQueue; audioQueue?: AudioTranscriptionQueue }): JSX.Element`. The props are for tests only, matching `NotesView`'s.

- [ ] **Step 1: Write the failing tests**
  - `SessionsView`:
    - `'with no stored selection, selects the active note, else the newest session'`
    - `'a restored selection naming a deleted note falls back quietly'`: Review Focus 1. No `role="alert"`, and the newest session is selected.
    - `'an empty library shows the empty state'`
    - `'notes and audio for one session render side by side'`: both halves are present in one flex row, each `flex-1`
    - `'the writing-destination banner shows while a locked session writes elsewhere'` (ported K16)
    - `'a just-started session with no finished pages or recordings renders both halves without error'`: Review Focus 4
    - `'openRecording from the store seeks the player'` (integration with Task 12)
  - `AppShell`:
    - `'shows exactly two tabs, Sessions and Triage, centred with Start session'`: `role="tab"` names are `['Sessions','Triage']`; the Start session button and the tab list share a parent with `justify-center`
    - `'opens on Sessions'`
    - `'switching to Triage and back keeps the selected session and page'`: Anti-goal 1. Select session B, go to page 2, switch to Triage, switch back, and expect B page 2. **Mutation check**: make the views remount and keep state local, and confirm this fails.
    - `'a reload restores the selected session, page, recording and notes mode'`: unmount and remount `AppShell` sharing `localStorage`
    - `'starting capture while on Triage switches to Sessions and selects the live note'` (owner decision)
    - `'the legacy migration runs once'` (ported)
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **`AppShell`.**
    - Create the store once (`useState(() => createSessionsUiStore(safeLocalStorage()))`), wrap it in `SessionsUiProvider` and call `useLiveFollow(store)`.
    - Drive Radix `Tabs` from `store.tab`.
    - The header is a three-column grid:
      - left: the app name
      - centre: `TabsList` (Sessions, Triage) plus `<SessionControls />`
      - right: a search slot (Task 14 fills it), `DeviceStatus`, `RecorderControl`, `SettingsDialog`
    - Both `TabsContent` use `forceMount` and `hidden` when inactive (`data-[state=inactive]:hidden`), so neither view remounts.
  - **`SessionsView`.**
    - Builds the queues and runs `useSessionCatalog` and `filterCatalog`.
    - Resolves the selection: if `selectedKey` is not in the catalog once it has loaded, select the active note's key, else the newest session, else the newest uncategorized entry.
    - Lays out the sidebar, header and two halves as in mockup v3.
    - `writingDestinationTitle` and `sessionLocked` are calculated as at `NotesView.tsx:390-400`.
- [ ] **Step 4: Run** `npm test`. Every remaining test must pass, and the count drop must equal the deleted tests minus the ported ones, as listed in the commit body. Then run `npx tsc -b` and `npm run lint`.
- [ ] **Step 5: Commit:** `feat(app): Sessions/Triage shell with side-by-side notes and audio`.

---

### Task 14: Search store and the header quick search

**Files:**
- Create: `src/search/searchStore.ts`, `src/search/SearchContext.tsx`, `src/search/useSearchCorpus.ts`, `src/search/HeaderSearch.tsx`
- Modify: `src/app/AppShell.tsx` (create the search store, provide it, and mount `HeaderSearch` in the right column)
- Test: `src/search/searchStore.test.ts`, `src/search/HeaderSearch.test.tsx`

**Interfaces:**
- Consumes: `findInCorpus` and `FindOptions` (Task 6); `SessionsUiStore.openNote` and `openRecording` (Task 9).
- Produces:
  ```ts
  export interface SearchFilters { from: string | null; to: string | null; tags: string[]; tagMode: TagFilterMode; sources: FindHitSource[] }
  export const EMPTY_SEARCH_FILTERS: SearchFilters;
  export interface SearchState {
    quickQuery: string; advancedOpen: boolean;
    query: string; regex: boolean; filters: SearchFilters;
    smart: { query: string; result: SmartSearchResult } | null;
  }
  export interface SearchStore {
    getState(): SearchState; subscribe(l: () => void): () => void;
    setQuickQuery(q: string): void;
    openAdvanced(seedQuery?: string): void; closeAdvanced(): void;
    setQuery(q: string): void; setRegex(on: boolean): void; setFilters(f: SearchFilters): void;
    setSmart(smart: SearchState['smart']): void; clear(): void;
  }
  export function createSearchStore(): SearchStore;     // memory only; cleared by reload
  export function toFindOptions(state: Pick<SearchState, 'regex' | 'filters'>): FindOptions;
  export function useSearchCorpus(active: boolean): SearchCorpus | null;  // loads when active becomes true; reloads on each re-activation
  export function openHit(hit: FindHit, sessions: SessionsUiStore): void;
  export const QUICK_RESULTS_CAP = 8;
  ```

- [ ] **Step 1: Write the failing tests**
  - `searchStore`:
    - `openAdvanced('bureau')` sets `query` to `'bureau'` and `advancedOpen` to true
    - `closeAdvanced` keeps `query`, `smart`, `regex` and `filters`
    - `clear` resets everything except `advancedOpen`
    - `openHit` for a page hit calls `openNote(noteId, pageIndex, 'transcription')`
    - `openHit` for a title hit calls `openNote(noteId, 0)` without a mode
    - `openHit` for an audio hit calls `openRecording(recordingId, startMs, noteId)`
  - `HeaderSearch`:
    - the icon button has `aria-label="Search"`; clicking it reveals an input with `aria-label="Quick search"` and focuses it
    - typing `'bureau'` shows a `role="listbox"` with at most 8 `role="option"` rows, each showing a source label, the session title and a snippet
    - `'the quick box is always plain text'`: with the store's `regex` true, typing `'b.reau'` yields no options for corpus text `'bureau'`
    - ArrowDown then Enter opens the highlighted hit, closes the dropdown and calls the sessions store
    - Enter with no highlighted option calls `openAdvanced('bureau')`
    - the "Open advanced search" button does the same
    - Escape closes the dropdown
    - fewer than `MIN_QUERY_LENGTH` characters shows no listbox
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `HeaderSearch` always calls `findInCorpus(corpus, quickQuery)` with no options, and caps the rows at `QUICK_RESULTS_CAP`. Matched text in snippets uses `bg-search-highlight`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(search): header quick search with a dropdown of hits`.

---

### Task 15: Full-screen advanced search

**Files:**
- Create: `src/search/AdvancedSearch.tsx`, which grows out of `SearchView.tsx`'s body
- Delete: `src/search/SearchView.tsx`. Move `SearchView.test.tsx` to `AdvancedSearch.test.tsx`, porting every test, and map them in the commit body.
- Modify: `src/app/AppShell.tsx` (mount `<AdvancedSearch />` once, rendered when `advancedOpen`)
- Test: `src/search/AdvancedSearch.test.tsx`

**Interfaces:**
- Consumes: Task 14's store, `toFindOptions`, `useSearchCorpus` and `openHit`; `Switch` (Task 4); the existing `runSmartSearch` and `getSmartSearchDeps`.
- Produces: `export function AdvancedSearch(props?: { smartSearchDeps?: SmartSearchDeps }): JSX.Element | null`.

- [ ] **Step 1: Write the failing tests.** All existing `SearchView` tests, ported, plus these:
  - `'renders full screen over the app'`: a `role="dialog"` with `aria-modal`, covering the viewport (`fixed inset-0`), with a Close button
  - `'Find honours the regex switch'`: `reconstr\w+` finds the hit with the switch on and nothing with it off
  - `'an invalid regex shows an inline error and keeps the previous results'`: `role="alert"` containing `Invalid pattern`
  - `'filters narrow Find'`: a date range and a source checkbox each remove the expected hit
  - `'filters and regex do not reach smart search'`: with the fake deps recording calls, run smart search with filters and regex set, and the prompt input candidates equal those of a run with neither
  - `'closing and reopening keeps the query, Find results and smart results without a second model call'`: the fake generator call count is unchanged after reopening (resolves S6-A9)
  - `'opening a hit closes the overlay and navigates'`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Keep `FIND_DEBOUNCE_MS`, `FIND_RESULTS_CAP` and the existing honesty messages: the "could not check N notes" and "screened by title alone" reporting.
  - A smart result is stored with the query it answered, and shown with the line `Smart results for "<query>"` when the current query differs.
- [ ] **Step 4: Run** `npx vitest run src/search src/app`. Expect pass.
- [ ] **Step 5: Commit:** `feat(search): full-screen advanced search with regex and filters; state survives closing`.

---

### Task 16: Theme section in Settings — picker, import, export, delete

**Files:**
- Create: `src/themes/ThemeSettings.tsx`, `src/themes/themeFile.ts`
- Modify: `src/app/SettingsDialog.tsx`, which mounts `<ThemeSettings />` first, then a `Separator`
- Test: `src/themes/ThemeSettings.test.tsx`, `src/themes/themeFile.test.ts`

**Interfaces:**
- Consumes: `useThemes()` (Task 2), `parseTheme`, `uniqueThemeId` and `lightTheme`.
- Produces:
  ```ts
  export function themeToJson(theme: Theme): string;             // pretty, without builtIn
  export function themeFileName(theme: Theme): string;           // `${id}.theme.json`
  export function importThemeText(text: string, takenIds: readonly string[]):
    { ok: true; theme: Theme; warnings: string[] } | { ok: false; error: string };
    // JSON.parse errors -> "Not a theme file: …"; id collisions -> uniqueThemeId; builtIn false
  export function ThemeSettings(props?: { onOpenBuilder?(initial: Theme, mode: 'new' | 'edit'): void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**
  - `themeFile`:
    - `importThemeText(themeToJson(dark), ['dark'])` gives id `'dark-2'` and `builtIn: false`
    - `'{'` gives `ok: false` with an error starting `Not a theme file`
    - `'[]'` gives `ok: false`
  - `ThemeSettings`:
    - it renders a `role="radiogroup"` named `Theme`, with five built-in radios plus the custom ones, each with a swatch
    - checking `Sakura` calls `setActive('sakura')`, and `--background` changes
    - for a built-in, Edit and Delete are absent and Duplicate is present; for a custom theme, all are present
    - Delete asks for confirmation (`window.confirm` stubbed) and then removes the theme
    - Export creates a Blob download (stub `URL.createObjectURL` and an anchor click) whose text parses back
    - Import with a bad file shows `role="alert"`; a good file adds and activates the theme and shows any warnings
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Export uses `RecordingDetail`'s download technique: a Blob URL and a temporary anchor. Import uses a hidden `<input type="file" accept=".json,application/json">` and `File.text()`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(themes): theme picker with import, export and delete in Settings`.

---

### Task 17: Theme builder modal

**Files:**
- Create: `src/themes/ThemeBuilderDialog.tsx`, `src/themes/tokenGroups.ts`
- Modify: `src/themes/ThemeSettings.tsx`, which opens the builder for New, Edit and Duplicate
- Test: `src/themes/ThemeBuilderDialog.test.tsx`

**Interfaces:**
- Consumes: `useThemes()` (`preview` and `saveCustom`), `isHexColor`, `contrastRatio`, `uniqueThemeId`, `THEME_COLOR_TOKENS`.
- Produces:
  ```ts
  export const TOKEN_GROUPS: readonly { label: string; tokens: readonly ThemeColorToken[] }[]; // Surfaces, Text, Interaction, Element kinds, Ink, Triage scores — every token exactly once
  export interface ThemeBuilderDialogProps {
    open: boolean; initial: Theme; mode: 'new' | 'edit';
    onClose(): void;          // called after save or cancel
  }
  export function ThemeBuilderDialog(props: ThemeBuilderDialogProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**
  - `'TOKEN_GROUPS covers every token exactly once'`
  - `'new mode starts as a copy of the current theme, named "<name> copy", with a fresh id'`
  - `'editing a colour previews it live'`: change the `background` hex field to `#102030`, and `document.documentElement`'s `--background` equals `hexToHslTriplet('#102030')`
  - `'an invalid hex is flagged and not previewed'`: shows `aria-invalid="true"` and the variable is unchanged
  - `'cancel restores the previous theme'`: `--background` is back to the active theme's value and nothing is saved
  - `'save persists, activates and closes'`: `loadCustomThemes()` contains the theme, `active.id` equals it, and `onClose` is called
  - `'name is required'`: Save is disabled while the name is blank
  - `'a low-contrast ink/canvas pair shows a warning but still saves'`: the `role="status"` text contains `contrast`
  - Shape (radius, border width) and font fields edit the theme and preview it
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Each token gets an `<input type="color">` plus a hex text field.
  - The preview is the real app behind the modal, through `preview()`. Closing by any route calls `preview(null)` unless the theme was saved.
  - The dialog body scrolls; the footer holds Cancel and Save.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit:** `feat(themes): in-app theme builder with live preview`.

---

### Task 18: Restyle Triage, element-kind classes, final sweep and docs

**Files:**
- Modify: `src/triage/TriageView.tsx`, `CalendarPanel.tsx`, `TaskList.tsx`, `Scratchpad.tsx`, `EventDialog.tsx`, and any remaining `rounded-md`/`rounded-lg`/`border` resting styles in `src/**` that are not covered by Tasks 4–17
- Modify: `docs/architecture.md` (add §9, "Sessions UI, search and themes", covering the stores, the catalog, the theme tokens, the `rasterize` exemption and the regex guard), `docs/session-handoff.md` (a new section)
- Test: `src/themes/elementKinds.test.tsx`

**Interfaces:**
- Consumes: Task 3's token classes.

- [ ] **Step 1: Write the failing test** `elementKinds.test.tsx`. It mounts `TriageView` (with its test fakes from `src/triage/testing.ts`) and `SessionSidebar`, and asserts:
  - headings carry `text-heading`
  - agenda and task dates carry `text-date`
  - tags carry `text-tag`
  - no element in either tree has a class matching `/^rounded-(md|lg|xl)$/`
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Restyle.** Triage keeps its layout (owner) and gets tints instead of borders, hover-only affordances and the element-kind classes. Score bands keep `text-score-*`.
- [ ] **Step 4: Run the full verification:** `npm test`, `npx tsc -b`, `npm run lint` and `npm run build`. All must be green. Record the final test count against the 1614 baseline in the handoff.
- [ ] **Step 5: Run the app** (`npm run dev`). Switch through all five themes. Confirm the Sessions layout matches mockup v3, the Rainbow element colours show, ink is visible on Dark, and nothing shows a stray old-palette colour. Note anything that can only be checked against the real pad as an owner check in the handoff.
- [ ] **Step 6: Commit:** `style(triage): new visual language; docs for the Sessions UI and themes`.
