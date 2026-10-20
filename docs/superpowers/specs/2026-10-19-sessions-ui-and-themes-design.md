# Sessions UI, search rework and themes — design

Written 2026-10-19 from an interview with the owner. Builds on `phase3`
(see `docs/session-handoff.md`). Mockup of record:
`.superpowers/brainstorm/84846-1792455913/content/sessions-layout-v3.html`
(local, untracked).

Items marked **(owner)** were the owner's own decision. Items marked **(call)**
are the designer's calls, played back to the owner without objection but open
to overturning. Anything not covered here is left to the builder.

## Why

Two daily frustrations drive this:

1. **The app forgets where you were.** The selected note and page live in local
   state inside `NotesView`. Radix `TabsContent` unmounts inactive tabs, so a
   trip to Triage throws the selection away. `RecordingsView` has the same
   problem.
2. **Notes and the lecture audio are never on screen together.** Reviewing a
   lecture means flipping between the Notes and Recordings tabs.

The fix is a view built around the **session**, meaning one lecture: the pages
written during it plus its recordings. Notes and audio sit side by side. Themes
come along at the same time because the restyle touches every surface anyway.

## Goals

- Two large top-level tabs, **Sessions** and **Triage**, replacing Notes,
  Recordings, Triage and Search. **(owner)**
- A Sessions view that shows one session's notes and its audio transcript side
  by side, each taking half the main area. **(owner)**
- Selection that survives tab switches and reloads.
- Search moves into the header, with a quick dropdown and an expandable
  full-screen advanced search that supports regex. **(owner)**
- A sharper visual language as the default. **(owner)**
- JSON themes, five built-ins, and an in-app theme builder. **(owner)**

## Non-goals

- Triage's layout does not change. It is only restyled. **(owner)**
- No change to capture, transcription, auto-naming, smart-search ranking or the
  storage of notes and recordings.
- No Electron work. Theme files must not *depend* on a filesystem.
- Restyling `src/probe/ProbeApp.tsx` (a debug page) is out of scope.

## Anti-goals

These would make the work a failure even if every test passed:

- **Losing the session the owner is viewing**, on a tab switch or a reload.
- **Any regression to live capture.** That covers the writing-destination
  banner, the session lock (New note / Start session disabled while a session
  runs), Resume, typed pages, and pen-on-typed-page opening a new live page.
- **Handwriting unreadable in a dark theme.** Black ink on a near-black canvas
  is a failure.
- **A theme that leaves pockets of the old palette.** Hard-coded colours still
  showing through after a theme switch count as a defect.
- **The quick search box interpreting input as regex.** It must not, ever.

## The shell

### Header

The header is laid out left to right **(owner, centring)**:

- **Left:** the app name.
- **Centre:** the **Sessions** and **Triage** tabs, large, with **Start
  session** next to them.
- **Right:**
  - the search icon
  - pad status and battery (`DeviceStatus`)
  - Record (`RecorderControl`)
  - the settings gear

`SessionControls` is split. Start session moves to the centre. End session
stays wherever the builder judges best, as long as it is always visible while a
session runs **(call)**. All of today's lock rules still hold.

### Tab state

The active tab, plus all Sessions-view and search state below, lives above the
tabs (in `AppShell` or a context), not inside the views. Two approaches would
work: Radix `forceMount` with hidden content, or lifted state. That choice is
the builder's, but the anti-goal above is the requirement.

## The Sessions view

### What counts as a session

A sidebar entry is a **note**. In practice a note and its `SessionRecord` are
1:1: `engine.openNote` creates both, and Resume reattaches.

- A note with a `sessionId` is listed under **Sessions**. **(owner)**
- A note without a `sessionId` (legacy or imported) is listed under
  **Uncategorized**. **(owner)**
- A recording whose `noteId` is null, and whose session has no note, gets its
  own entry under **Uncategorized**. Its notes half is blank. **(call)**
- A note's recordings are the recordings with that `noteId`, plus any with a
  matching `sessionId` and a null `noteId`. They are ordered by `startedAt`.
  **(call)**

### Left sidebar

- **Quick filter box.** Narrows the list as you type, by title or tag, as plain
  substring matching. **(owner)**
- **"Advanced filter"** expands an inline panel below the quick filter.
  **(owner)** Its fields **(call; owner accepted the mockup's set)**:
  - a date range on `startedAt`
  - tags, with an any/all toggle (this replaces `TagFilterBar`; keep its rule
    that a filter never hides the note being written)
  - title contains
  - text contains, across page transcripts, typed text, summaries and audio
    transcripts
  - "has recording" and "has typed page"
  - status (complete / interrupted / active)
  - a **Regex** toggle that applies to the title, tag and text fields. An
    invalid pattern shows an inline error and does not empty the list.
    **(owner: regex on the sidebar; call: inline error)**
  - Clear
- **Groups.** Sessions first, then Uncategorized. Each shows a match count, and
  entries are sorted newest first. **(call)**
- **Entries.** Each shows the title, a date, and its tags.

### Session header (above the halves)

- The title, editable inline (`NoteTitle`).
- Tags, editable inline (`TagEditor`).
- **Resume** (`ResumeButton`), with the same rules as today.
- A "⋯" menu for rarer actions such as delete, if delete exists today. **(call)**
- The writing-destination banner, unchanged in behaviour.

### Notes half (left)

- **Handwriting/Transcription switch.** A single toggle switch, not two buttons,
  centred at the top of the half. **(owner)** It defaults to Handwriting.
  - **Handwriting** shows `InkCanvas`, or `TypedPageEditor` for a typed page.
  - **Transcription** shows the page's OCR transcript (`TranscriptPanel`), with
    **gap analysis** (`GapPanel`) below it. **(call)**
- **Page navigation** ("‹ Page N of M ›") sits centred just below the switch,
  with the `NoteToolbar` actions (Type page and the rest) nearby.
- **Blank when there are no pages.** The owner can Resume and type a page.
  **(owner)**

### Audio half (right)

- **"‹ Recording N of M ›"** arrows step between the session's recordings.
  **(owner)**
- Below them: the audio player, then the transcription status, progress,
  pause/resume and retry. These sit *above* the transcript, per commit
  `127fb56`.
- Then the segment transcript with clickable timestamps that seek the player.
- Rename and delete of a recording go in a small menu by the arrows. **(call)**
- **Blank when there are no recordings.** **(owner)**
- **One component, not two.** `RecordingDetail`'s content is reused here.
  `RecordingsView` goes away.

### Persistence

| What | Survives tab switch | Survives reload |
|---|---|---|
| Selected session | yes | yes |
| Page index | yes | yes |
| Recording index | yes | yes |
| Handwriting/Transcription switch | yes | yes |
| Sidebar filters (quick and advanced) | yes | no |

All of this is **(call)**.

**Live capture wins over the saved selection. (owner)** When a note becomes
active (Start session clicked from anywhere, including Triage, or the pen
starting a note on its own), the app switches to the Sessions tab and selects
the live session. While the owner is viewing the live session, the view follows
page turns, and a newly started recording becomes the selected recording.
This keeps `NotesView`'s current follow behaviour. The persisted selection then
records the live session like any other choice. The anti-goal "losing the
session the owner is viewing" means losing it to a tab switch or reload, not to
the owner's own capture starting. Reload persistence goes through the existing
settings store or `localStorage`; the builder chooses. A stale persisted id (a
deleted note) must fall back quietly to the newest session.

## Search

### Quick search (header)

- **Opening it.** Clicking the icon opens an inline text box in the header.
  **(owner)**
- **Plain text only, always. (owner)**
- **The dropdown.** As you type, a dropdown lists the top hits from `find.ts`
  (local and immediate, with the existing `MIN_QUERY_LENGTH`). Each row shows
  the source kind, the session title and a snippet.
- **Picking a hit** selects that session in the Sessions view and switches to
  the Sessions tab if needed.
  - A page hit selects the page and sets the switch to Transcription. **(call)**
  - An audio hit selects the recording **and seeks the player** to the segment.
    **(call)** This was declined in Phase 3 only because the player was private
    to another view. It is now in the same view.
- **Expanding it.** An "expand" button in the dropdown, plus Enter with no
  selection **(call)**, opens Advanced search with the query carried over.

### Advanced search (full screen)

- A full-screen overlay holding today's `SearchView` capabilities (Find
  results in full, and Smart search on the existing Gemma two-stage pipeline),
  plus **new** filters: date range, tags, and which sources to search. Today's
  `find.ts` has no filters; these are new work. **The filters narrow Find only.
  Smart search ignores them and its pipeline is untouched. (owner)**
- A **Regex** toggle. When it is on, Find matches by `RegExp` (case-insensitive
  by default **(call)**). Smart search ignores it, because its query goes to the
  model as prose. **(call)** An invalid pattern shows an inline error.
- **State persists.** Query, results and smart-search results survive closing
  the overlay and picking a hit, until the owner clears them or reloads. **(call)**
  This resolves the Phase 3 open question S6-A9.
- Picking a hit navigates exactly as quick search does, and closes the overlay.
- **Regex safety.** Regex runs over local text only. A catastrophic pattern
  could freeze the tab, so a cheap guard is required, such as a length cap on
  the pattern or matching off the main thread. The mechanism is the builder's.
  **(call)**

## Visual language (the default themes)

- **Square corners**: radius 0. **(owner)**
- **Very few explicit borders.** Regions are told apart by slight background
  tints. **(owner)** One hairline between the two halves is acceptable.
- **Interactive elements show an outline and background only on hover.** This
  covers tabs, buttons, list items, timestamps and menu triggers. **(owner)**
  Keyboard focus must still show a visible ring, for accessibility. **(call)**
- The selected list item is marked by a tinted fill plus an inset left bar
  **(call, per the mockup)**. The active tab is marked by an underline bar.
- Triage gets the same treatment, with its layout unchanged. **(owner)**

## Themes

### Format

A theme is a JSON document. **(owner)**

```jsonc
{
  "id": "sakura",            // stable, unique
  "name": "Sakura",
  "builtIn": true,           // false for custom
  "base": "light",           // "light" | "dark": hints for third-party bits
  "colors": { "<token>": "<css colour>", ... },
  "shape":  { "radius": "0px", "borderWidth": "0px" },
  "fonts":  { "ui": "...", "mono": "...", "transcript": "..." }
}
```

- **Themes can change shape and fonts as well as colours. (owner)** The five
  built-ins all use the sharp default shape.
- **Applying a theme** sets CSS custom properties on `:root`. The existing HSL
  variable scheme in `src/index.css` (consumed by Tailwind and the shadcn
  components) is the base. The builder may change the variable format.
- **Validating a theme.** A loaded theme is checked before it is applied.
  Unknown tokens are ignored, and missing ones fall back to Light's values, so
  a partial or older custom theme still renders. **(call)**

### Tokens

Tokens are **per element kind**, not just a palette, because the Rainbow theme
needs it. **(owner, via Rainbow)** The set below is the minimum; the builder
may refine the names. Quiet themes give most of the accent kinds the same value.

| Group | Tokens |
|---|---|
| Surfaces | background, surface (sidebar and panels), surface-raised (popovers, dialogs, dropdown), overlay scrim |
| Text | foreground, muted-foreground |
| Interaction | hover-bg, hover-outline, focus-ring, selected-bg, selected-bar, primary, primary-foreground, destructive |
| Element kinds | heading, tag, timestamp, date, link/button-text, session-title, search-highlight, status-ok / warn / error |
| Ink canvas | canvas-bg, ink |
| Triage | the priority-score bands (red through green) remain absolute in meaning; each theme may shade them but must keep them distinguishable |

### Removing hard-coded colours

Roughly 142 hex/rgb values in `src/index.css`, and about 11 Tailwind palette
classes (`bg-white` and similar), must be routed through tokens.

**Ink.** `InkCanvas` (`bg-white`) and its drawing colour take `canvas-bg` and
`ink` **(call)**. **However, `src/transcription/rasterize.ts` must stay white
background and black ink, regardless of theme.** It produces the image the OCR
model reads, and theming it would change transcription input. This is the
"who consumes what you're changing" trap the Phase 3 handoff warns about.

### The five built-ins **(owner names; palettes are calls)**

1. **Light**, the default for a new install. A near-white background, dark
   text, one blue accent.
   - Today's app is dark by default, so existing installs switch to Light on
     upgrade unless a theme is already saved. **(call; the owner asked for
     Light as the default)**
2. **Dark.** Neutral near-black, close to today's palette.
3. **Midnight Blue.** A deep navy background, a blue-grey surface, a pale-blue
   foreground, and a cyan or soft-gold accent.
4. **Rainbow.** A dark charcoal background, with each element kind in its own
   saturated colour, in the spirit of the Hiberbee editor theme:
   - headings yellow
   - tags magenta
   - timestamps cyan
   - dates green
   - links and buttons orange

   **(owner: "different colors on different types of elements")** It is
   inspired by Hiberbee, not a copy of its palette or name.
5. **Sakura.** A white or very pale pink background, cherry-blossom pink
   accents, leaf-green secondary accents, and dark plum-grey text. **(call;
   owner said pink/white/green)**

Built-ins live as JSON files in the repo (for example `src/themes/*.json`) and
are bundled.

### Storage and selection

- **The current theme id** is a new settings key, such as `ui.theme`, with
  default `"light"`.
- **Custom themes** are stored in the app's own storage, in the same JSON
  shape, either as a settings key holding an array or as a small store. A new
  store means a `DB_VERSION` bump, which a new phase may make. **(call)**
- **Applying early.** The chosen theme is applied before first paint where
  practical, to avoid a flash of the wrong theme. A synchronous `localStorage`
  mirror of the active theme is acceptable. **(call)**
- **The Google-hosted UI font** (`TASA Orbiter`) remains the default `ui` font.
- **Fonts are CSS font-family lists only.** A theme names fonts that are already
  installed or bundled; the app never fetches a font a custom theme asks for.
  The `transcript` font covers all transcript text: OCR page text, typed pages
  and audio segments. **(call)**

### Settings UI

- **A Theme section in `SettingsDialog`. (owner)** It shows a picker listing the
  built-in and custom themes, each with a small swatch. Choosing one applies it
  immediately.
- **"New theme…"** opens the **theme builder** modal. **(owner)** The builder:
  - starts as a copy of the current theme
  - edits every token with a colour picker plus a text field, and also shape
    (radius, border width) and fonts
  - shows a **live preview**: a miniature Sessions view, or the real app
    behind the modal, at the builder's choice
  - offers name, Save and Cancel
  - can edit or delete custom themes; built-ins are read-only, and "Duplicate"
    makes an editable copy
- **Export and import** a theme as a `.json` file **(call)**. This keeps "a
  theme is a JSON file" true in the browser today, and carries over to Electron.
- **Deleting the active custom theme** falls back to Light.

## What is removed

Once each of these components' responsibilities has moved, it is removed:

- **`RecordingsView`**, **`SearchView`** as a tab, **`TagFilterBar`**
  (superseded by the advanced filter), and **`NoteList`** (superseded by the
  sidebar).
- **The four-tab assertions in `AppShell.test.tsx`.** These are rewritten, not
  deleted blind. The navigation-target tests carry over to quick and advanced
  search.

## Constraints

- **Stack.** Vite, React 19, TypeScript, Tailwind v3 and shadcn/Radix. Tests use
  Vitest, happy-dom and fake-indexeddb, rendered with `createRoot` and `act` (no
  Testing Library). The test count is 1614 across 119 files, and none may be
  lost without a stated reason.
- **The same verification bar as Phase 3**:
  - `npx tsc -b` clean
  - `npm run lint` with 0 errors
  - `npm run build` succeeds
- **Mutation-check claims.** Any test named for a constraint in this document,
  especially the anti-goals, must fail against a broken implementation.

## Left to the builder

- **Forced mount versus lifted state** for keeping views alive across tabs.
- **Exact token names**, and the HSL versus raw-colour variable format.
- **Where custom themes are stored**: a settings key or a new store.
- **The theme builder's preview mechanism.**
- **Where End session sits**, and how the `NoteToolbar` actions are arranged
  around the page arrows.
- **The regex safety mechanism.**
- **How the work is split into waves or units.** Theme tokens and the
  hard-coded-colour sweep are a natural first unit, because every other unit's
  styling lands on them.
