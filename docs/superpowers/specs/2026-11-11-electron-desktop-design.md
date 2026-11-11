# TakingNotes as a desktop app (Electron): design

Date: 2026-11-11 · Branch: `electron` (cut from `main` at `59ed3a4`) · Status: draft for owner review

## 1. Intent

Today the owner runs TakingNotes from the local Vite dev server in their own
browser on a Mac. That browser's storage for the dev server's address holds
the notes they want to keep. The goal is to turn the same app into a desktop
application that the owner builds, installs and launches like any other Mac
app, and can send to a few interested people for testing.

Why it matters:
- It's a real app, not a browser tab that depends on a running dev server.
- Testers can install it without cloning the repo or running npm.
- Only one window can touch the data, so the two-tabs-racing problems the app
  defends against today become impossible (see `docs/architecture.md`, the
  transcription lease guard).

The app's features stay the same: tablet ink over Bluetooth or USB, mic
recording, Whisper and Ollama transcription, notes, sessions, triage, gaps,
search and themes. This project changes where the app runs and how data moves
in and out of it. It doesn't change what the app does.

## 2. Goals, non-goals, anti-goals

**Goals**
1. **G1 Backup export/import in Settings**, in both the web and desktop
   builds. It's how the owner moves their browser data into the desktop app,
   and how testers move data between versions or machines.
2. **G2 A desktop shell** that loads the existing app, with every current
   feature working on macOS: the Huion X10 over BLE, Wacom BLE, a USB/HID
   tablet, mic recording, the Whisper worker, PDF.js syllabus import, regex
   search, and Ollama.
3. **G3 An Ollama setup check in the app** that tells a tester exactly what is
   missing: Ollama not installed or running, the model not pulled, or the
   app's requests being blocked.
4. **G4 Installable builds:** a macOS `.dmg` (unsigned; testers open it with the
   "unidentified developer" workaround). A Windows installer must also build,
   but it doesn't need to be tested on real Windows hardware.
5. **G5 The web build keeps working.** `npm run dev`, `npm run build` and the
   Cloudflare Pages deploy stay as they are.

**Non-goals (for now; recorded as tech debt in §9)**
- Bundling or launching Ollama from the app. Testers install Ollama themselves.
  *The owner wants this planned eventually.*
- Auto-update. Testers get new versions by downloading them by hand.
- Apple code signing and notarization, and Windows code signing.
- Bundling the Whisper model or ONNX runtime for offline use. Both still
  download from the CDN on first use and are cached after that.
- Real testing and polish on Windows, beyond making sure the code paths
  exist (for example Bluetooth pairing).
- Moving storage out of IndexedDB to the file system, or any other change to
  the data model.
- Merging a backup into existing data (see G1 rules).

**Anti-goals (what would make this a failure even if it technically works)**
- Losing or corrupting any of the owner's notes, ink, recordings or
  transcripts while moving them across.
- A desktop app that is less capable than the browser tab. For example, a
  tablet that won't connect, or a `requestDevice()` that hangs with no picker.
- Weakening the renderer's security: Node access in the page, remote code, or
  arbitrary navigation.
- Forking the app code into "web" and "desktop" versions. Desktop-specific
  code stays in the shell and a thin bridge.

## 3. Constraints and facts from the codebase

- The app is client-only Vite 7 + React 19 + TypeScript, built with
  `base: './'`, and has no backend. Tests use Vitest with happy-dom and
  fake-indexeddb, and must stay green (1963 tests at `59ed3a4`).
- **Storage.** IndexedDB database `takingnotes`, `DB_VERSION = 5`
  (`src/storage/db.ts`). The stores are: `notes`, `pages`, `pageRenders`
  (image bytes, which can be the only copy of a page), `settings`, `sessions`,
  `recordings`, `recordingAudio` (blobs), `recordingChunks`, `events`,
  `tasks`, `gaps`, and `pcmCache` (decoded audio, a cache that can be rebuilt).
  `localStorage` is also used: the theme mirror read early in `src/main.tsx`,
  `src/sessions/sessionsUiStore.ts`, and the legacy notebook library that
  `src/storage/migrate.ts` reads once.
- Storage is per-origin. The Electron app's origin is new, so it starts empty.
- **Devices.** Web Bluetooth (`src/utils/huionTransport.ts`,
  `src/utils/wacomBLE.ts`), WebHID (`src/utils/tabletUSB.ts`), `getUserMedia`
  plus `MediaRecorder` (`src/audio/recorder.ts`), WebGPU (the Whisper worker).
- **Workers.** These use `new Worker(new URL(..., import.meta.url), { type: 'module' })`:
  `src/search/regexRunner.ts` and `src/audio/whisperWorkerFactory.ts`. The PDF.js
  worker is set up in `src/syllabus/pdfjs.ts`. The session handoff already
  flags that module workers under `file://` are untested.
- **Network.** Ollama is at `http://localhost:11434` (setting `ollama.baseUrl`,
  default model `gemma4:12b`). Models are listed in
  `src/notes/TranscriptionSettings.tsx` through `listOllamaModels`.
  transformers.js fetches the ORT wasm from jsdelivr and the models from
  Hugging Face. `vite.config.ts` strips the bundled ort wasm on purpose.
- Settings UI is in `src/app/SettingsDialog.tsx`.
- **Owner's working rules (CLAUDE.md).** Work test-first. Implementation is
  split across subagents. Parallel-safe tasks run in separate worktrees.
  Lockfile and shared-config changes count as conflicts.

## 4. Part A: backup export and import (G1)

**What the owner sees.** Settings gets a "Backup" section with two actions:
- **Export backup…** saves one file, named like `takingnotes-backup-2026-11-11.tnbackup`.
- **Import backup…** picks a file, shows what it contains (counts of notes,
  pages, recordings, sessions, plus the export date and app version), warns
  that it **replaces everything currently in the app**, and asks for
  confirmation. When the import finishes, the app reloads.

**Rules (decided)**
- **Exports everything** the user would miss: every IndexedDB store except
  `pcmCache`, plus the app's `localStorage` keys. Audio blobs and page images
  are included byte for byte.
- **Import replaces everything; it never merges.** Merging is a non-goal.
- **Import is all-or-nothing.** If any part fails (bad file, unreadable entry,
  or a write fails partway), the app's data must end up exactly as it was
  before. Two ways to get that are the builder's call: stage the data and
  swap it in, or export an automatic safety backup first and restore it on
  failure. "Half imported" must be impossible.
- **Versioning.** A backup records the app version and `DB_VERSION`. An older
  backup is imported and brought forward through the same upgrade path the
  app already uses. A backup from a newer `DB_VERSION` is refused with a
  clear message.
- **Blocked while busy.** Import is unavailable while a recording or session
  is active, or while transcription is running. The app says why.
- **Other tabs (web build only; owner's decision).** Import refuses to run
  while another tab holds a connection to the database, and asks the user to
  close the other tabs first. Detect this with the existing
  `blocked`/`blocking` handling in `src/storage/db.ts` or an equivalent
  check. No cross-tab coordination is built. The desktop app has only one
  window, so this never comes up there.
- **Not text-encoded.** The format must not inflate binary data (no base64
  in JSON). It must handle backups of 1 GB or more without holding the whole
  backup in JS memory at once. Expect hours of lecture audio.
- **Same code in both builds.** It uses standard browser file download and
  upload, so it needs nothing desktop-specific. If the desktop build's
  default download behaviour is poor, a save-dialog bridge in the desktop
  build is fine.

**Builder's call:** the container format (for example a zip via a small
streaming library such as `fflate`, or a simple custom framed format), the
internal layout, how progress is reported, and the exact UI wording.

**Verification:** round-trip tests on fake-indexeddb. Export, wipe, import,
then deep-compare every store, including blob bytes. Also test failure
injection partway through an import (the data must be unchanged), refusal of
a newer `DB_VERSION`, and that import is blocked during recording.

## 5. Part B: the desktop shell (G2)

**Layout (decided):** desktop-only code lives in a new top-level `electron/`
directory (main process and preload). The renderer is the existing app,
unchanged except where a bridge is truly needed. The shell is written in
TypeScript.

**Loading the app.** The production build is served from a custom scheme
registered as privileged (standard, secure, fetch, CORS and streaming
support), such as `app://takingnotes/`. It is **not** served from `file://`.
That gives module workers, WASM, `fetch` and IndexedDB a stable, secure
origin. In development the shell loads the Vite dev server URL.

**Security baseline (decided):**
- `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`.
- The preload script exposes only a narrow, typed bridge.
- Navigation away from the app origin is blocked. External links open in
  the system browser.
- No `webSecurity: false`.
- A Content-Security-Policy that allows only the app origin, Ollama on
  localhost (`http://localhost:*` and `http://127.0.0.1:*`), and the CDNs the
  app already uses (jsdelivr, Hugging Face). **Owner's decision: the desktop
  app supports Ollama on the same machine only.** A remote Ollama host is
  out of scope (see §9).
- Permission handlers grant only the specific permissions below, and only to
  the app origin.

**Single window, single instance (decided).** Launching the app a second time
focuses the existing window.

**Devices and permissions.** Electron has no browser prompts of its own, so
the app must supply each one:
- **Bluetooth (Huion and Wacom).** Handle `select-bluetooth-device`. The
  renderer shows its own picker dialog that lists devices as they're
  discovered (Electron calls the handler again and again with an updated
  list), and the user picks one or cancels. Cancelling must reject
  `requestDevice()` the same way the browser does, so existing error paths
  still work. The auto-reconnect behaviour in `huionTransport.ts` (keep the
  device, reconnect GATT without a user gesture) must keep working within a
  run. Whether a device remembered across app restarts can reconnect without
  the picker is the builder's to find out and document; it's nice to have,
  not required.
- **Windows Bluetooth pairing.** Handle `bluetooth-pairing-request` so the
  code path exists. It is untested.
- **HID (USB tablet).** Handle `select-hid-device`, reusing the same picker
  pattern, and set device permission handlers.
- **Microphone.** Grant `media` (audio) for the app origin. On macOS, add
  `NSMicrophoneUsageDescription` and `NSBluetoothAlwaysUsageDescription` to
  Info.plist (BLE fails on macOS without the latter), and request mic access
  from the system when it's needed.
- **WebGPU.** Confirm the Whisper worker gets a GPU adapter in Electron, and
  that it still falls back the way it does today when it doesn't.

**Picker UI.** It's a small dialog in the app's own style (Radix dialog,
theme tokens), fed over the bridge. In the web build the bridge is absent and
the browser's own picker is used, so this code never runs there.

**Data location.** Electron's per-app profile directory (`userData`), keyed by
a fixed app ID chosen now (for example `org.takingnotes.app`), so later
builds and renames keep the same data. Replacing the app with a newer
download keeps the data.

**Dev workflow.** One npm script starts Vite and the shell together, with
reload. One script builds the installers. The builder chooses the tools
(for example electron-vite, vite-plugin-electron, or a plain Vite build plus
`tsc` for the shell; electron-builder or Electron Forge for packaging),
as long as the existing `npm run dev`, `build`, `test` and `lint` keep their
current meaning.

## 6. Part C: Ollama setup check (G3)

**What a tester sees.** In Settings, next to the existing transcription
settings, and as a non-blocking notice when transcription is attempted and
fails at setup:
- **Not reachable:** "Ollama isn't running at `<baseUrl>`", with a link to
  install it and how to start it.
- **Reachable, model missing:** "The model `<model>` isn't installed", with the
  exact `ollama pull <model>` command and a copy button.
- **Reachable but the app's requests are refused** (a CORS rejection of the
  app's origin): explain how to set `OLLAMA_ORIGINS`.
- **All good:** a quiet "Ready" state.

**Decided:** the check runs in both builds. It builds on `listOllamaModels`
(`/api/tags`). It doesn't install or start anything.

**Open for the builder to settle early (spike):** whether Ollama's default
allowed origins accept the desktop origin. I believe they include `app://*`,
but this hasn't been checked. If they do, the renderer keeps fetching
directly. If they don't, or if the "not running" and "blocked" cases can't be
told apart from the renderer (CORS failures give no detail), the desktop
build sends Ollama requests through the main process over the bridge. That
gets rid of CORS entirely. The web build keeps direct fetch. Record the
outcome in the plan.

## 7. Part D: packaging and handing builds to testers (G4)

- **macOS:** a `.dmg` (and optionally a `.zip`) for Apple Silicon. Whether to
  also build Intel/universal is the builder's call, guided by installer size;
  record the call. The app is ad-hoc signed only (Apple Silicon requires at
  least that), with no notarization.
- **Windows:** an NSIS installer target configured and building. It may be
  built on Windows or CI if cross-building from macOS isn't practical;
  document how.
- **Tester guide:** `docs/desktop-testers.md` covers:
  - Opening an unidentified-developer app on current macOS (System Settings →
    Privacy & Security → Open Anyway, or the `xattr` command).
  - Installing Ollama and pulling the model.
  - Granting mic and Bluetooth permission.
  - Exporting a backup before installing a new version.
  - Where the data lives.
- The app shows its version, for example in Settings, so testers can report
  which build they're on.

## 8. Moving the owner's data (the one-time migration)

1. On the `electron` branch, run the web build from the same local dev server
   address the owner uses today. The origin must match: same host and port.
2. In Settings, choose Export backup.
3. Install and open the desktop app, then choose Import backup.
4. Check that notes, ink, recordings and transcripts all came across.

The browser copy is never deleted. It stays as a fallback.

## 9. Tech debt to record (in the handoff when this ships)

- **Bundle or launch Ollama from the app** (the owner wants this planned).
- **Auto-update.** It realistically needs signing first.
- **Apple Developer signing and notarization,** and Windows signing.
- **Real testing on Windows hardware** (BLE pairing, HID, mic).
- Optionally, bundle the Whisper model and ORT wasm for offline first run.
- Support Ollama on another machine (a non-localhost base URL) in the desktop
  build. That needs a CSP that follows the setting, or Ollama calls routed
  through the main process.
- Once desktop is the only target, the multi-tab guards can be simplified.

## 10. Verification the owner must do (tests can't reach these)

On a packaged build, not the dev shell:
- Pair the Huion X10 and draw.
- Record with the mic, interrupt, reopen the app, and confirm the recording
  plays and transcribes.
- Transcribe a page through Ollama, run Whisper on a recording, and import a
  syllabus PDF.
- Run a regex search.
- Round-trip a real backup from the browser into the app.
- Install on a second Mac and follow `docs/desktop-testers.md` from scratch.

## 11. Left to the builder

- The backup container format and its layout.
- The Electron build and packaging tools.
- The exact bridge API shape.
- The picker's design within the app's style.
- Intel/universal builds.
- How the Ollama proxy works, if it's needed.
- The exact UI wording.

Each of these is recorded in the plan as the builder's call.

As built, the calls are recorded in `docs/session-handoff.md` (2026-11-11
section, "The builder's calls").
