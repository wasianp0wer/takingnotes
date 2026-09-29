# TakingNotes — Phase 1 Spec

Status: interview complete 2026-09-28. This document is the product spec for
Phase 0 and Phase 1. The shared data model and module contracts live in
`docs/architecture.md`; assumptions made without asking live in
`docs/assumptions.md`.

## Purpose

Turn the existing drawing studio into a handwritten note-taking app for the
Huion X10 (Bluetooth). You write on the pad; the app captures the live pen
stream, shows plain ink, and transcribes each finished page locally with Gemma
via Ollama. Alongside notes: local audio recording with local Whisper
transcription, and a triage center (to-dos + calendar + scratchpad).

Everything runs locally. The app stays a static SPA with no backend; the
browser talks to Ollama at `http://localhost:11434` and runs Whisper in a Web
Worker.

## Starting point

- Build on existing work. The Huion driver, device controller, storage layer
  (IndexedDB via `idb`) and the unmerged `phase-2a-link-resilience` branch
  (paced writes, silent reconnect, liveness watchdog, poll-based page-turn
  detection) are the foundation. Phase 1 is built on a `notes-app` branch cut
  from `phase-2a-link-resilience`.
- The committed design decisions still hold where they apply, notably:
  - **D9**: the live stream is the source of truth; device ROM download is a
    manual last resort, not part of Phase 1.
  - **Transcription findings F1–F4**: `think: false` always; render pages at
    1024 px long edge (floor 768); cap `num_predict` (~2000), detect
    degenerate repetition, per-page timeout; default model `gemma4:12b`.
  - **D8**: prompts live in a registry keyed by model family with a generic
    fallback; `transcribePage(image) → markdown` is a single interface;
    render resolution is a user setting; every transcript records `model` and
    `promptVersion`.
  - **D2**: the user picks among their installed Ollama models.
- The old plans under `docs/superpowers/` are background only. The feature plan
  is this document.

## Decisions from the interview

| # | Question | Decision |
|---|----------|----------|
| I1 | Relation to existing roadmap | Build on existing code and designs; feature plan is the brief. |
| I2 | Deleted `docs/superpowers/` files | Leave deleted in the main checkout; may be read from git history. |
| I3 | Where Whisper runs | In the browser: transformers.js in a Web Worker (WebGPU when available, WASM otherwise). |
| I4 | Calendar source | Local in-app calendar stored in IndexedDB. Phase 2 syllabus import writes to the same store. |
| I5 | Which page-turn button | The pad's physical page turn, detected by polling the stored page count with `0x8A` as an early hint (already built on `phase-2a`). Plus an on-screen "New page" fallback button. |
| I6 | Page view / transcription timing | Live plain black ink while writing (no tools). A page is transcribed when it is finished (page turn or note end); transcript shown beside the ink. |
| I7 | Priority formula | Slack-based (below). |
| I8 | Which events become tasks | Only `deadline`-kind events, look-ahead 7 days. `event`-kind (lectures, meetings) never spawn tasks. |
| I9 | Scratchpad | Typed text, autosaved; a line can be promoted to a task. |

### Priority formula (I7)

Inputs: `required` (bool), `h` = hours until due, `d` = estimated duration in
hours.

```
slack   = h - d
urgency = slack >= 0 ? 1 / (1 + slack / 24)
                     : 1 + min(-slack / 24, 1)      // overdue boost, cap 2
weight  = required ? 1.0 : 0.5
score   = round(100 * weight * urgency)
```

- Tasks with no due date: `urgency = 0.1`.
- Default estimate when unset: 60 minutes.
- Score is computed at render time from `now`; it is never stored.
- Reference values: required/48h/2h → 34; required/12h/8h → 86;
  optional/12h/1h → 34; required/2h/4h → 108.

## Phase 1 features

### F1 — Drawing removal + handwriting transcription

- Remove all drawing-specific code: the studio `App.tsx`, canvas engine,
  brushes, colors, layers, animation timeline, export, image filters, rulers,
  minimap, the old `TabletPanel` and `DownloadedMemoryPage` UI, and deps used
  only by them (`@dnd-kit/*`, `react-colorful`, `@ffmpeg/*`).
- Keep pen-movement tracking: device controller → capture engine, which
  segments the pen stream into strokes (with per-point timestamps) and
  persists them incrementally to IndexedDB (flush on pen-up plus a periodic
  flush).
- Writing with no active note starts one automatically, so writing is never
  dropped.
- Notes view: note list; the current page drawn as plain black ink in real
  time; a transcript panel beside it; page navigation within a note.
- When a page is finalized it is rasterized (1024 px long edge by default) and
  queued for transcription through Ollama. Status per page: pending → running
  → done/failed, with a retry action. The queue resumes after reload.
- Settings: Ollama base URL, model (picked from installed models), render
  resolution.

### F2 — Audio recording + local transcription

- Record from the microphone (MediaRecorder). A recording started while a
  note is active is linked to that note and its session.
- On stop: save the audio, then transcribe locally with Whisper
  (transformers.js in a Web Worker), producing text plus timestamped segments.
- Recordings view: list, playback, transcript with segment times, retry on
  failure. Transcription queue resumes after reload.
- Settings: Whisper model.

### F3 — Triage center

- Tasks: manual tasks plus tasks auto-generated from deadline events due from
  today through the next 7 days. Each task has required/optional, estimated
  duration and due date; sorted by the priority score.
- Calendar: local events with kind (`deadline` | `event`), date/time or
  all-day, and default required/estimate for generated tasks. Month grid plus
  an agenda of the coming days.
- Scratchpad: typed text, autosaved, with "promote line to task".
- Sync rules: generation is idempotent (one task per event); done or dismissed
  tasks are never re-created; editing an event updates the title and due date
  of its open task; deleting an event dismisses its open task.

### F4 — Page turn creates a new page

- A physical page turn on the X10 (as reported by the controller's page-turn
  detection) finalizes the current page and starts a new one in the active
  note.
- An on-screen "New page" button does the same.
- Page-turn capture (poll, reconnect, liveness) runs while the pad is
  connected.
- A page turn with no active note is ignored; the next pen input starts a note.

## Phase 2 (not built; Phase 1 must make these easy)

1. Fill gaps in notes from the recording plus Gemma → needs per-point
   timestamps on strokes and timestamped audio segments on a shared clock
   (both epoch ms), linked through `Session`.
2. Syllabus import populates assignments into the calendar → `CalendarEvent`
   has `source` and `sourceRef`; deadlines already drive task generation.
3. Manual session start, then automatic recording and grouping → `Session` is
   a first-class record; notes and recordings reference it by `sessionId`.

## Done means

For each feature: the app builds (`npm run build`), existing tests pass
(`npm test`), new tests cover core logic, and the work is committed on its
branch with a short summary. Features are merged sequentially into `notes-app`
at the end. Nothing is pushed.

## Out of scope for Phase 1

ROM download UI, gap accounting (§9 of the Phase 2 design), note summaries,
search, multi-device support beyond the Huion driver, cloud sync.
