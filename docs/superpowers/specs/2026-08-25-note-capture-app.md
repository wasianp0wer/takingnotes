# Note Capture App — Spec

**Status:** active
**Date:** 2026-08-25

## Goal

Convert `takingnotes.ink` from a drawing/animation studio into a note-taking
application built around the Huion Note X10 smart notebook.

The target workflow:

1. Start a note-taking session.
2. Write on paper; the app captures a digital copy.
3. Complete the session.
4. Pages are transcribed to markdown using a local vision model.
5. A summary of the note is generated.
6. Notes are browsable later in both original (rendered ink) and transcribed forms.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Inference runs locally via Ollama only.** No cloud APIs, no bundled model. | Privacy; no per-page cost; no backend to operate. |
| D2 | **Users choose their own models.** The app discovers installed Ollama models and lets the user pick a vision model and a text model. | Hardware varies enormously; a fixed model would exclude users. |
| D3 | **Ask every time before clearing pages off the device.** | Clearing is destructive and irreversible. |
| D4 | **Huion only.** Wacom support is deferred; USB is out of scope. | Focus. USB cannot download stored pages at all (see C3). |
| D5 | **A session is a note, 1:1.** | Avoids a second entity with no distinct lifecycle. |
| D6 | **Use the `idb` package** (~2 KB) rather than raw IndexedDB. | Raw IndexedDB transactions auto-close across non-IDB await points — a subtle, high-frequency bug class. Reversible if it becomes a burden. |
| D7 | **Rendered page images are stored as `ArrayBuffer` + a `renderType` MIME string, not as `Blob`.** | Established empirically in Phase 1A Task 4: `fake-indexeddb` does not structured-clone `Blob` (it returns `{type}` with the bytes and prototype lost), so a `Blob` field leaves the render path permanently untestable. Real browsers do support `Blob` in IndexedDB, but Safari has a documented history of bugs there, and the runtime cost of `ArrayBuffer` is two lines — `await blob.arrayBuffer()` on write, `new Blob([buf], {type})` on read. Phase 2's renderer and Phase 4's viewer must both use this shape. |
| D8 | **Phase 3 must keep changing the transcription model cheap.** Four binding constraints: (a) transcription prompts live in a registry keyed by model family with a generic fallback — never inline strings; (b) `transcribePage(image) → markdown` is an interface with a single implementation, so a two-stage OCR+cleanup variant can replace it without touching the queue; (c) image resolution is a user setting, not a constant; (d) every transcript records both `model` and `promptVersion`. | Handwriting prompts do not transfer between model families — phrasing that makes one model preserve structure makes another hallucinate. D2 already makes the model a runtime choice, so the model id itself is free to change; the second-order costs are the prompt, the resolution, and the pipeline shape. Prompts get tuned far more often than models get swapped, so `promptVersion` is what makes "which transcripts are stale" answerable at all. |

## Findings from hardware probing

These were established empirically against a real Huion Note X10 using
`probe.html` and drive several architectural choices.

- **C1 — Pages commit to device memory on page turn, not continuously.**
  A page becomes downloadable only after a new page is started. Therefore the
  *in-progress* page is never in device memory. Session completion must either
  force a page turn or fall back to the live-captured buffer for the final page.

- **C2 — Bulk download is slow and unreliable.** Roughly 15 s per stored page,
  with observed lag and flakiness. The driver already retries packages
  (`MAX_PACKAGE_RETRIES = 3`) and resolves with partial results on timeout.
  Prefer downloading each page incrementally as it commits over one bulk read
  at session end.

- **C3 — USB (WebHID) cannot access stored pages.** `HuionTabletUSB.downloadPages()`
  throws by design (`src/utils/tabletUSB.ts:194`), and its capabilities are
  `{ paper: false, tablet: true }`. Its pen decoder is also heuristic
  (`src/utils/packetHeuristics.ts`), scoring six candidate byte layouts and
  sticky-locking to the first match, which produces inconsistent results.

- **C4 — Live and offline points share a coordinate space.** Both pass through
  `scaleRawPoint()` and are normalized 0–1, so they are directly comparable.

- **C5 — Offline points carry no per-point timestamps.** `DownloadedMemoryPoint`
  is `{x, y, pressure}` only. There is no key to align live and offline streams
  point-by-point, so reconciliation must choose a source *per page* rather than
  merging within a page.

- **OPEN — Does the device write to memory while live-streaming?** Not yet
  cleanly determined. Does not block Phase 1 or 1A. The reconciliation design
  (prefer device memory, fall back to live buffer) is correct either way.

## Architecture

**No backend.** The app remains a static SPA. The browser calls Ollama at
`http://localhost:11434` directly. There is no server-side component and no
deploy-time compute.

**Runs from `localhost`.** `http://localhost` is a secure context, so Web
Bluetooth works, and a local origin avoids the public→private network crossing
that an HTTPS-hosted page would face when contacting Ollama. Users are expected
to run the app locally.

**Storage is IndexedDB.** The existing `localStorage` persistence is already
failing silently at quota (`src/App.tsx:899`) and cannot hold rendered page
images.

**Layering:**

```
huionBLE driver  →  device provider (fan-out)  →  session engine
                                                        ↓
                                                  IndexedDB
                                                        ↓
                                          page renderer → Ollama client
                                                        ↓
                                                       UI
```

## What is being kept, changed, and removed

**Kept:** `src/utils/huionBLE.ts`, `src/utils/wacomBLE.ts` (dormant),
`drawBrushStroke()` from `src/utils/helpers.ts`, and the stroke rasterization
approach in `App.tsx:2417`.

**Removed (Phase 5):** the drawing studio — `App.tsx`'s studio shell,
`CanvasEngine`, `ExportDialog`, `ToolSettingsPanel`, `CanvasSettingsPanel`,
`LayerPanel`, `AnimationTimeline`, `HslSliders`, `Ruler`, `NavigatorMinimap`,
`ImageMenu`, `imageFilters`, `useHistory`, `useAnimationRecorder`. Roughly
10,000 lines.

**Not removed:** `wacomBLE.ts` stays in the repo unused. It represents
substantial reverse-engineering work informed by the tuhi project and is cheap
to re-enable.

## Global constraints

- Node `>=20 <23` (`package.json` engines; `.nvmrc` pins 20).
- Browser target: Chromium (Chrome/Edge) — Web Bluetooth is required.
- Must be served from a secure context (`http://localhost` or HTTPS).
- TypeScript `strict` is on, with `noUnusedLocals` and `noUnusedParameters`
  (`tsconfig.app.json`). Plans must not leave unused symbols.
- Path alias `@/*` → `./src/*`.
- Existing app behaviour must not change until Phase 5. All earlier phases are
  additive.
- No new runtime dependency without an explicit note in this spec. Approved so
  far: `idb`.
- `OLLAMA_ORIGINS` must permit the app origin; the app must detect and explain
  when it does not.

## Out of scope

- Cloud or hosted inference of any kind.
- Wacom device support (deferred, driver retained).
- USB/WebHID capture.
- Multi-user, sync, or sharing.
- Mobile support.
