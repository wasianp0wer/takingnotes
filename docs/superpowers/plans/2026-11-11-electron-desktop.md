# TakingNotes Desktop (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship TakingNotes as an installable desktop app for macOS (Windows target building), with full backup export/import and an Ollama setup check, without forking the app code.

**Architecture:** The renderer is the existing Vite/React app, with only small additions (backup, Ollama check, device picker, a bridge reader). A new top-level `electron/` holds the main process and preload. esbuild bundles them to `dist-electron/*.cjs`. The production build is served from a privileged `app://takingnotes/` scheme. Backup import writes into a *staging* IndexedDB database and then flips a pointer in `localStorage`. That makes it all-or-nothing without holding the backup in memory.

**Tech Stack:** Electron (latest stable at install time, exact pin), esbuild (exact pin), electron-builder (exact pin), React 19, TypeScript 5.9, Vitest 3 + happy-dom + fake-indexeddb, `idb`.

**Spec:** `docs/superpowers/specs/2026-11-11-electron-desktop-design.md`. Read it before any task. Section numbers below (§N) refer to it.

## Global Constraints

- The web build keeps working: `npm run dev`, `npm run build`, `npm test`, `npm run lint` and `cf:deploy` keep their current meaning (G5).
- The whole suite stays green after every task (1963 tests at `59ed3a4`), and `npx tsc -b` stays clean.
- Renderer security: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no `webSecurity: false`. Only a narrow typed bridge is exposed as `window.takingnotesDesktop`.
- CSP `connect-src` covers the app origin, `http://localhost:*`, `http://127.0.0.1:*`, `https://cdn.jsdelivr.net` and `https://huggingface.co` plus its CDN hosts. Ollama is supported on localhost only.
- App ID: `org.takingnotes.app`. Product name: `TakingNotes`.
- Desktop-only code lives in `electron/` (main and preload) and `src/desktop/` (renderer side of the bridge). Feature code never imports Electron.
- Backup file extension: `.tnbackup`. Default file name: `takingnotes-backup-YYYY-MM-DD.tnbackup`.
- Every IndexedDB store except `pcmCache` is exported. Exported `localStorage` keys are those starting with `takingnotes.` or `takingnotes_`, except `takingnotes.activeDb`.
- Never base64 binary data. Never build the whole backup or import in JS memory at once.
- Worktrees: create them from local `HEAD` (`origin` is not authoritative), and run a real `npm install` in each worktree. Don't symlink `node_modules`.

## Review Focus

1. **A backup from a database at `DB_VERSION` < 5** (stores missing). Import must succeed with those stores empty, and missing stores must not fail the import. → Task 4 test `imports a v4 backup that lacks pcmCache-era stores`.
2. **Two IndexedDB records sharing one ArrayBuffer, or zero-length buffers.** These must round-trip byte-exact, and a zero-length buffer must not shift later offsets. → Task 1 test `round-trips empty and repeated buffers`.
3. **A truncated or foreign file picked by mistake** (a `.zip`, or a backup cut off mid-download). The app must say so clearly before anything is touched. → Task 1 test `rejects a truncated file` and Task 4 test `foreign file leaves data untouched`.
4. **Reload after a successful import while `localStorage` is blocked.** The pointer can't be written, so import must refuse up front rather than import into a database the app will never open. → Task 2 test `canSwitchDatabase is false when storage throws`.
5. **The Bluetooth chooser fires with an empty list, then updates, then the user cancels.** `requestDevice()` must reject (as in the browser) and not hang, and a second request must still work. → Task 9 test `cancel then re-request`.

---

## Task graph and parallel lanes

| Task | Files (main) | Depends on | Lane |
|---|---|---|---|
| 1 Backup codec | `src/backup/format.ts` | none | A |
| 2 Active DB pointer | `src/storage/db.ts`, `src/storage/activeDb.ts` | none | A |
| 3 Export | `src/backup/exportBackup.ts` | 1 | A |
| 4 Import guards + import | `src/backup/guards.ts`, `src/backup/tabPresence.ts`, `src/backup/importBackup.ts`, `src/main.tsx` | 1, 2, 3 | A |
| 5 Backup Settings UI + version | `src/backup/BackupSettings.tsx`, `src/app/SettingsDialog.tsx`, `vite.config.ts`, `vitest.config.ts`, `src/vite-env.d.ts` | 3, 4 | A |
| 6 Ollama setup check | `src/llm/ollamaSetup.ts`, `src/notes/OllamaSetupStatus.tsx`, `src/notes/TranscriptionSettings.tsx`, `src/notes/TranscriptPanel.tsx` | none | B |
| 7 Shell + spike | `electron/*`, `scripts/build-electron.mjs`, `scripts/electron-dev.mjs`, `package.json`, lockfile, `.gitignore`, `docs/desktop-spike.md` | none | C |
| 8 Ollama main-process route (conditional) | `electron/ollama.ts`, `src/desktop/bridge.ts`, `src/llm/ollamaClient.ts` | 6, 7 | after merge |
| 9 Device chooser + permissions (main) | `electron/devices.ts`, `electron/permissions.ts`, `electron/main.ts`, `electron/preload.ts`, `src/desktop/bridge.ts` | 7 | C |
| 10 Renderer device picker + desktop probe wiring | `src/desktop/DevicePickerDialog.tsx`, `src/app/AppShell.tsx`, `src/notes/OllamaSetupStatus.tsx` | 6, 9 | after merge |
| 11 Packaging + tester docs + handoff | `electron-builder.yml`, `build/entitlements.mac.plist`, `package.json`, `docs/desktop-testers.md`, `docs/session-handoff.md`, `docs/architecture.md` | all | last |

**Parallel-safe:** lanes A, B and C run at the same time in separate worktrees. Their file lists don't overlap. Only lane C touches `package.json` and the lockfile. Lane A owns `vite.config.ts`/`vitest.config.ts`. Lane C must not edit them. Within a lane, tasks run in order. Merge the lanes back one at a time (A, then B, then C) and run the full suite after each merge. Tasks 8, 10 and 11 run in order after all three merges.

---

### Task 1: Backup file codec

**Files:**
- Create: `src/backup/format.ts`
- Test: `src/backup/format.test.ts`

**Interfaces:**
- Produces:
  - `BACKUP_MAGIC = 'TNBACKUP1\n'`
  - `interface BackupManifest { format: 1; appVersion: string; dbVersion: number; exportedAt: number; stores: Record<string, BackupEntry[]>; localStorage: Record<string, string>; binaries: BinaryRef[] }`
  - `type BackupEntry = { key: IDBValidKey | null; value: unknown }`: the key is given only for out-of-line-key stores (`pageRenders`, `recordingAudio`). Otherwise it is `null`.
  - `interface BinaryRef { offset: number; length: number }`: offsets are relative to the start of the binary section.
  - `encodeRecord(value: unknown, sink: (buf: ArrayBuffer) => number): unknown` replaces every `ArrayBuffer` (and the `.buffer` slice of any `ArrayBufferView`) found at any depth with `{ $tnbin: <index> }`. `sink` returns the index.
  - `decodeRecord(value: unknown, load: (index: number) => ArrayBuffer): unknown` reverses this. It is synchronous; the caller preloads buffers.
  - `buildBackupBlob(manifest: Omit<BackupManifest, 'binaries'>, parts: Blob[]): Blob` produces `MAGIC + 12-digit zero-padded decimal manifest byte length + manifest JSON + concatenated parts`. It fills `binaries` from `parts[i].size`.
  - `readBackupHeader(file: Blob): Promise<{ manifest: BackupManifest; binaryStart: number }>` throws `BackupFormatError` (exported, with `.reason: 'not-a-backup' | 'truncated' | 'corrupt'`).
  - `sliceBinary(file: Blob, binaryStart: number, ref: BinaryRef): Blob`

- [ ] **Step 1: Write failing tests** in `src/backup/format.test.ts`:
  - `round-trips a manifest and two binaries`: build from parts `[new Blob([Uint8Array.of(1,2,3)]), new Blob([Uint8Array.of(9)])]`. `readBackupHeader` returns an equal manifest, and `sliceBinary(...,binaries[1])` has bytes `[9]`.
  - `round-trips empty and repeated buffers`: `encodeRecord({a: buf, b: buf, c: new ArrayBuffer(0)}, sink)`. Decoding gives byte-equal `a`, `b`, `c`, and the binary after the empty one keeps the right offset.
  - `encodes nested ArrayBuffers inside arrays`: `{ segments: [{ data: buf }] }`.
  - `rejects a file without the magic` → `reason === 'not-a-backup'` (for example the bytes of `PK\x03\x04`).
  - `rejects a truncated file`: a blob cut inside the manifest gives `'truncated'`, and a blob whose last binary extends past `file.size` also gives `'truncated'`.
  - `rejects corrupt manifest JSON` → `'corrupt'`.
- [ ] **Step 2:** Run `npx vitest run src/backup/format.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/backup/format.ts` to the interface above. The header is read with `file.slice(...).text()`. Only the header is ever read into memory.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): framed .tnbackup codec with out-of-band binaries`.

### Task 2: Active database pointer

**Files:**
- Create: `src/storage/activeDb.ts`
- Modify: `src/storage/db.ts` (extract the upgrade callback, open by name)
- Test: `src/storage/activeDb.test.ts`, keep `src/storage/db.test.ts` green

**Interfaces:**
- Produces:
  - `ACTIVE_DB_KEY = 'takingnotes.activeDb'`
  - `getActiveDbName(storage?: Pick<Storage,'getItem'> | null): string` returns the stored value if it is `DB_NAME` or `${DB_NAME}-<suffix>`. Otherwise, and whenever storage throws, it returns `DB_NAME`.
  - `setActiveDbName(name: string, storage?: Storage): void` writes and then reads back, and throws if the read-back doesn't match.
  - `canSwitchDatabase(storage?: Storage | null): boolean` is true when a test write and remove of `takingnotes.activeDb.probe` succeeds.
  - In `db.ts`: `openNamedDb(name: string): Promise<IDBPDatabase<NotesDb>>` uses the same `upgrade`/`blocked`/`terminated` handlers and does not cache. `openNotesDb()` now opens `getActiveDbName()`. The default storage is `globalThis.localStorage`, wrapped in try/catch.

- [ ] **Step 1: Write failing tests:**
  - `defaults to takingnotes when unset`
  - `returns a stored staging name`
  - `ignores a foreign value`: `'other'` gives `'takingnotes'`.
  - `canSwitchDatabase is false when storage throws`
  - `openNamedDb creates all v5 stores`: for `'takingnotes-x'`, `objectStoreNames` has all 12 store names.
  - `openNotesDb opens the pointed-to database`: set the pointer, open, check `db.name`.
- [ ] **Step 2:** Run `npx vitest run src/storage/activeDb.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Move the inline `upgrade` function to a named `upgradeNotesDb` that both openers share. Don't change any `if (oldVersion < N)` block.
- [ ] **Step 4:** Run `npx vitest run src/storage`. Expected: all PASS.
- [ ] **Step 5:** Commit: `feat(storage): open the database named by an active-db pointer`.

### Task 3: Export

**Files:**
- Create: `src/backup/exportBackup.ts`, `src/backup/stores.ts`
- Test: `src/backup/exportBackup.test.ts`

**Interfaces:**
- Consumes: Task 1 `encodeRecord`, `buildBackupBlob`. Task 2 `openNotesDb`.
- Produces:
  - `src/backup/stores.ts`: `BACKUP_STORES` is the 11 store names except `pcmCache`, in `db.ts` creation order. `OUT_OF_LINE_STORES = ['pageRenders', 'recordingAudio']`. `isBackupLocalStorageKey(key: string): boolean`.
  - `exportBackup(opts: { appVersion: string; now?: () => number; storage?: Storage | null }): Promise<Blob>` walks each store with a cursor, encodes each value immediately, and turns each buffer into a `new Blob([buf])` part so no list of ArrayBuffers is kept.
  - `backupFileName(now: number): string` gives `takingnotes-backup-YYYY-MM-DD.tnbackup` in local time.

- [ ] **Step 1: Write failing tests:**
  - `exports every store except pcmCache`: seed one row per store, including a `pcmCache` row. Then `manifest.stores` has 11 keys and no `pcmCache`.
  - `keeps out-of-line keys`: a `pageRenders` row under key `'p1'` gives an entry with `key: 'p1'` and a binary of the right length.
  - `exports only takingnotes localStorage keys`: `takingnotes.activeTheme`, `takingnotes_downloaded_memory` and `takingnotes.sessionsUi` are in. `takingnotes.activeDb` and `other.key` are out.
  - `records appVersion and DB_VERSION`.
  - `backupFileName uses the local date`.
- [ ] **Step 2:** Run `npx vitest run src/backup/exportBackup.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): export every store and the app's localStorage`.

### Task 4: Import, with guards

**Files:**
- Create: `src/backup/guards.ts`, `src/backup/tabPresence.ts`, `src/backup/importBackup.ts`
- Modify: `src/main.tsx` (call `registerTabPresence()` once at startup)
- Test: `src/backup/guards.test.ts`, `src/backup/tabPresence.test.ts`, `src/backup/importBackup.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `DB_VERSION`, `openNamedDb`, `setActiveDbName`, `canSwitchDatabase`, `closeNotesDb`.
- Produces:
  - `tabPresence.ts`: `registerTabPresence(locks?: LockManager): void` holds an exclusive Web Lock `takingnotes:tab:<random id>` forever. `countOpenTabs(locks?: LockManager): Promise<number | null>` counts held locks with that prefix via `locks.query()`. It returns `null` when `navigator.locks` is missing.
  - `guards.ts`: `type ImportBlocker = 'other-tabs' | 'session-active' | 'recording-active' | 'transcription-running' | 'storage-blocked'`. `findImportBlockers(deps?: { countTabs?: () => Promise<number|null>; storage?: Storage|null }): Promise<ImportBlocker[]>`.
    - `other-tabs` when the count is > 1.
    - `session-active` when any session or note has `status === 'active'`.
    - `recording-active` when any recording has `endedAt === null`.
    - `transcription-running` when any page transcript or recording transcript has status `'pending'` or `'running'`.
    - `storage-blocked` when `!canSwitchDatabase()`.
    - A tab count of `null` is not a blocker.
  - `importBackup.ts`: `type BackupSummary = { appVersion: string; exportedAt: number; dbVersion: number; counts: Record<string, number> }`.
    - `inspectBackup(file: Blob): Promise<BackupSummary>` throws `BackupFormatError`, or `BackupTooNewError` (exported) when `dbVersion > DB_VERSION`.
    - `importBackup(file: Blob, opts?: { onProgress?: (done: number, total: number) => void; storage?: Storage }): Promise<void>`:
      1. Inspect the file.
      2. Check `findImportBlockers()`. If any are found, throw `ImportBlockedError` (exported, `.blockers`).
      3. Pick a staging name `${DB_NAME}-${Date.now().toString(36)}` and `openNamedDb(staging)`.
      4. For each store, write the entries in transactions of at most 50 records or 64 MB of binaries. Load the binaries for a batch (`sliceBinary(...).arrayBuffer()`) *before* opening that batch's transaction.
      5. Verify that the per-store counts in staging equal the manifest's.
      6. Close staging and `closeNotesDb()`. Write the backup's `localStorage` keys (first removing existing allowlisted keys), then `setActiveDbName(staging)`.
      7. Best-effort `indexedDB.deleteDatabase(oldName)`.
      8. Any failure before step 6 deletes the staging database and leaves the pointer and `localStorage` untouched. The caller reloads the page.

- [ ] **Step 1: Write failing tests:**
  - `tabPresence`: `two registered tabs count 2`, using a fake `LockManager` with `request`/`query`. `countOpenTabs returns null without navigator.locks`.
  - `guards`: one test per blocker (`blocks on an active session`, …, `blocks on other tabs`), plus `no blockers on idle data`.
  - `importBackup`:
    - `round-trips export → import byte-exact`: seed every store with binaries, export, wipe, import. Then every store deep-equals the seed, ArrayBuffer bytes are equal, and `localStorage` keys are restored.
    - `failure mid-import leaves data untouched`: inject a `put` failure on the 3rd batch. The original data is unchanged, the pointer is unchanged, and the staging DB is deleted (`indexedDB.databases()` lists it nowhere).
    - `foreign file leaves data untouched`
    - `refuses a newer DB_VERSION` → `BackupTooNewError`, nothing written.
    - `imports a v4 backup that lacks pcmCache-era stores`
    - `refuses while recording` → `ImportBlockedError` with `['recording-active']`.
    - `reports progress up to total`
- [ ] **Step 2:** Run `npx vitest run src/backup`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `tabPresence.ts`, then `guards.ts`, then `importBackup.ts`. Wire `registerTabPresence()` into `src/main.tsx` next to the existing startup calls, wrapped so a missing `navigator.locks` is a no-op.
- [ ] **Step 4:** Run `npx vitest run src/backup src/storage`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(backup): all-or-nothing import via a staging database`.

### Task 5: Backup section in Settings, plus app version

**Files:**
- Create: `src/backup/BackupSettings.tsx`
- Modify: `src/app/SettingsDialog.tsx` (mount it after `AudioSettings`, with a `Separator`), `vite.config.ts` and `vitest.config.ts` (`define: { __APP_VERSION__: JSON.stringify(pkg.version) }`), `src/vite-env.d.ts` (or the existing global .d.ts: `declare const __APP_VERSION__: string`)
- Test: `src/backup/BackupSettings.test.tsx`

**Interfaces:**
- Consumes: `exportBackup`, `backupFileName`, `inspectBackup`, `importBackup`, the error classes, and `ImportBlocker`.
- Produces: `BackupSettings({ deps?, reload? })`. Deps can be injected for tests, and `reload` defaults to `() => location.reload()`.

UI copy (exact):
- Heading: **Backup**.
- Version line: `TakingNotes <version>`.
- Export button: `Export backup…`. It downloads via an object URL and an `<a download>`.
- Import button: `Import backup…`. It uses a hidden `<input type="file" accept=".tnbackup">`.
- The summary shows the export date, app version, and counts of notes, pages, recordings and sessions.
- Warning: `This replaces everything currently in TakingNotes. Export a backup first if you want to keep it.`
- Confirm button: `Replace and import`.
- Blocker messages:
  - `other-tabs` → `Close other TakingNotes tabs first.`
  - `session-active` → `End the active session first.`
  - `recording-active` → `Stop the recording first.`
  - `transcription-running` → `Wait for transcription to finish, or pause it.`
  - `storage-blocked` → `This browser is blocking site storage, so a backup can't be switched in.`
- `BackupFormatError` → `That file isn't a TakingNotes backup, or it's incomplete.`
- `BackupTooNewError` → `This backup is from a newer version of TakingNotes. Update the app first.`

- [ ] **Step 1: Write failing tests:**
  - `shows the app version`
  - `export downloads a .tnbackup`
  - `import shows summary then replaces on confirm and reloads`
  - `shows blocker messages and does not reload`
  - `shows the not-a-backup message`
- [ ] **Step 2:** Run `npx vitest run src/backup/BackupSettings.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement with the existing `Button` and dialog components and theme tokens. `src/themes/noHardcodedColors.test.ts` must stay green.
- [ ] **Step 4:** Run the full suite with `npx vitest run && npx tsc -b`. Expected: green.
- [ ] **Step 5:** Commit: `feat(backup): export and import in Settings; show the app version`.

### Task 6: Ollama setup check

**Files:**
- Create: `src/llm/ollamaSetup.ts`, `src/notes/OllamaSetupStatus.tsx`
- Modify: `src/notes/TranscriptionSettings.tsx` (render the status above the model picker), `src/notes/TranscriptPanel.tsx` (when a page transcript is `failed` and the check isn't `ready`, render `<OllamaSetupStatus compact />` under the error)
- Test: `src/llm/ollamaSetup.test.ts`, `src/notes/OllamaSetupStatus.test.tsx`

**Interfaces:**
- Consumes: `listOllamaModels(baseUrl, fetch)` from `src/llm/ollamaClient.ts`.
- Produces:
  - `type OllamaSetup = { state: 'ready' } | { state: 'unreachable' } | { state: 'blocked' } | { state: 'unreachable-or-blocked' } | { state: 'model-missing'; model: string }`
  - `checkOllamaSetup(opts: { baseUrl: string; model: string; fetch?: FetchLike; probeReachable?: (baseUrl: string) => Promise<boolean> }): Promise<OllamaSetup>`. If the renderer fetch fails: with `probeReachable` given, the result is `blocked` when the probe says reachable and `unreachable` otherwise. Without it, the result is `unreachable-or-blocked`. If the model isn't among the listed names (an exact match, or a match after appending `:latest` when the setting has no tag), the result is `model-missing`.
  - `OllamaSetupStatus({ compact?: boolean; probeReachable? })` reads `ollama.baseUrl`/`ollama.model` from settings and has a "Check again" button.

Copy (exact):
- `unreachable`: `Ollama isn't running at <baseUrl>.` plus `Install it from https://ollama.com and open it, then check again.`
- `model-missing`: `The model <model> isn't installed.` plus the command `ollama pull <model>`, with a Copy button.
- `blocked`: `Ollama is running but refused this app's requests.` plus `Set OLLAMA_ORIGINS to include this app's address, then restart Ollama.`
- `unreachable-or-blocked`: both the `unreachable` and the `blocked` hint.
- `ready`: `Ollama ready`.

- [ ] **Step 1: Write failing tests:** `ready when model listed`, `matches untagged model to :latest`, `model-missing`, `unreachable with probe false`, `blocked with probe true`, `unreachable-or-blocked without probe`. Component tests: `shows pull command and copies it`, `check again re-runs`.
- [ ] **Step 2:** Run `npx vitest run src/llm/ollamaSetup.test.ts src/notes/OllamaSetupStatus.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite plus `tsc -b`. Expected: green.
- [ ] **Step 5:** Commit: `feat(llm): Ollama setup check in settings and on failed transcripts`.

### Task 7: Desktop shell, plus spike

**Files:**
- Create: `electron/main.ts`, `electron/preload.ts`, `electron/appProtocol.ts`, `electron/security.ts`, `electron/tsconfig.json`, `scripts/build-electron.mjs`, `scripts/electron-dev.mjs`, `docs/desktop-spike.md`
- Modify: `package.json` (devDeps `electron`, `esbuild`; `"main": "dist-electron/main.cjs"`; scripts `desktop:dev`, `desktop:build`), `package-lock.json`, `.gitignore` (`dist-electron/`, `release/`), `tsconfig.json` (reference `electron/tsconfig.json` so `tsc -b` covers it), `vitest.config.ts` is **not** touched (it's lane A's). Electron tests live under `electron/**/*.test.ts`. If the current vitest `include` doesn't match them, add `electron/vitest.config.ts` and a `test:electron` script, and have `npm test` run both.
- Test: `electron/appProtocol.test.ts`, `electron/security.test.ts`

**Interfaces:**
- Produces:
  - `APP_SCHEME = 'app'` and `APP_ORIGIN = 'app://takingnotes'`.
  - `resolveAppRequest(url: string, root: string): string | null` maps `app://takingnotes/<path>` to an absolute file under `root`. `/` maps to `index.html`. It returns `null` for another host, a path that escapes `root` (`..`, encoded `%2e%2e`), or a missing extension-less SPA path that should fall back to `index.html` (decide fallback: unknown paths → `index.html`).
  - `contentSecurityPolicy(): string` follows Global Constraints. `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self' data:`, `media-src 'self' blob:`.
  - `isAllowedNavigation(url: string, devUrl: string | null): boolean` allows only the app origin, plus `devUrl`'s origin in dev.
  - `isExternalHttpUrl(url: string): boolean` is true for http(s) URLs not on those origins. These open via `shell.openExternal`.
  - `main.ts` does the following:
    - Sets `app.setAppUserModelId('org.takingnotes.app')` and `app.setName('TakingNotes')`.
    - Calls `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])` before ready.
    - Takes `requestSingleInstanceLock()`; a second instance focuses the window and quits.
    - Uses `protocol.handle('app', ...)` with `net.fetch(pathToFileURL(resolved))` and sets the CSP response header.
    - Creates one `BrowserWindow` with the Global Constraints webPreferences and `preload: dist-electron/preload.cjs`.
    - Wires `will-navigate` and `setWindowOpenHandler` to the guards.
    - Loads `process.env.TAKINGNOTES_DEV_URL` when it is set, and otherwise `app://takingnotes/`.
  - `preload.ts`: `contextBridge.exposeInMainWorld('takingnotesDesktop', { platform: process.platform })`. Task 9 extends it.
  - `scripts/build-electron.mjs`: esbuild bundles `electron/main.ts` and `electron/preload.ts` into `dist-electron/{main,preload}.cjs` (`platform: 'node'`, `format: 'cjs'`, `external: ['electron']`).
  - `scripts/electron-dev.mjs`: starts Vite on port 5199, waits for it, builds the shell, and launches Electron with `TAKINGNOTES_DEV_URL=http://localhost:5199`.
  - `desktop:build` = `npm run build && node scripts/build-electron.mjs`.

- [ ] **Step 1: Write failing tests** for `resolveAppRequest` (`maps root to index.html`, `maps asset path`, `rejects traversal`, `rejects encoded traversal`, `rejects foreign host`, `falls back to index.html for unknown route`), `contentSecurityPolicy` (`allows localhost Ollama and CDNs`, `has no unsafe-eval`), `isAllowedNavigation`, and `isExternalHttpUrl`.
- [ ] **Step 2:** Run `npx vitest run electron` (or `npm run test:electron`). Expected: FAIL.
- [ ] **Step 3:** Install `electron` and `esbuild` as exact-pinned devDependencies, then implement the files above.
- [ ] **Step 4:** Run the electron tests and the full suite plus `tsc -b`. Expected: green.
- [ ] **Step 5: Spike.** Run `npm run desktop:build`, then launch the packaged-style load (`npx electron .`). Check each of these in DevTools and write the results to `docs/desktop-spike.md`:
  1. The app renders.
  2. `indexedDB` works and its origin is `app://takingnotes`.
  3. The regex search Worker runs (do a regex search).
  4. The Whisper worker loads and `navigator.gpu.requestAdapter()` resolves (or the existing fallback engages).
  5. PDF.js parses a sample syllabus PDF from `samples/`.
  6. A `fetch('http://localhost:11434/api/tags')` from the app origin succeeds against a running Ollama with default `OLLAMA_ORIGINS`. Record the exact outcome. **This decides whether Task 8 runs.**
  7. `npm run desktop:dev` loads with HMR.
  
  If something can't be checked (for example no Ollama installed), say so in the doc rather than guessing.
- [ ] **Step 6:** Commit: `feat(desktop): Electron shell serving the app from app://takingnotes`.

### Task 8 (conditional): Ollama through the main process

Run this only if the Task 7 spike step 6 found that requests from `app://` are refused. Otherwise, mark it skipped in this plan with the spike's evidence.

**Files:** create `electron/ollama.ts` and `src/desktop/bridge.ts` (or extend the one from Task 9). Modify `electron/preload.ts`, `electron/main.ts`, and `src/llm/ollamaClient.ts` (the default `FetchLike` becomes the bridge's `ollamaFetch` when present).
**Interfaces:**
- `ollamaFetch(url: string, init: { method: string; body?: string; headers?: Record<string,string> }): Promise<{ status: number; body: string }>`. The main side allows only URLs whose host is `localhost` or `127.0.0.1`.
- The renderer side adapts it to `FetchLike` (a `Response` built from status and body). Abort signals are honoured by IPC cancel; if that isn't practical, document that the timeout is enforced on the main side using `DEFAULT_TIMEOUT_MS`.

- [ ] Tests: `rejects non-localhost host` and `passes status and body through` in `electron/ollama.test.ts`. `ollamaClient uses the bridge fetch when present` in `src/llm/ollamaClient.test.ts`. Use the same failing-test, implement, pass, commit cycle. Commit: `feat(desktop): route Ollama calls through the main process`.

### Task 9: Device chooser and permissions (main side)

**Files:**
- Create: `electron/devices.ts`, `electron/permissions.ts`, `src/desktop/bridge.ts`
- Modify: `electron/main.ts`, `electron/preload.ts`
- Test: `electron/devices.test.ts`, `electron/permissions.test.ts`, `src/desktop/bridge.test.ts`

**Interfaces:**
- Produces:
  - `type ChooserKind = 'bluetooth' | 'hid'`. `interface ChooserDevice { id: string; name: string }`.
  - `createDeviceChooser(send: (msg: ChooserMessage) => void)` returns `{ open(kind, devices, callback: (id: string) => void): void; update(devices): void; select(requestId: string, deviceId: string): void; cancel(requestId: string): void }`. Here `ChooserMessage = { type: 'open'; requestId; kind; devices } | { type: 'update'; requestId; devices } | { type: 'close'; requestId }`. Electron calls `select-bluetooth-device` again and again for one request. The first call with no pending request opens one; later calls `update`. `cancel` calls `callback('')`. A new `open` while one is pending cancels the old one first.
  - `isPermissionAllowed(permission: string, requestingOrigin: string, details?: { mediaTypes?: string[] }): boolean` is true only for origin `app://takingnotes` (or the dev origin) and only for `media` with audio only, `bluetooth`, `hid`, `clipboard-sanitized-write`, and `fullscreen`.
  - `isDeviceAllowed(details: { deviceType: string; origin: string }): boolean` allows `hid` and `bluetooth` for the app origin.
  - In `main.ts`:
    - `session.setPermissionRequestHandler`, `setPermissionCheckHandler` and `setDevicePermissionHandler` use these.
    - `select-bluetooth-device` and `select-hid-device` call `event.preventDefault()` and go through the chooser.
    - `bluetooth-pairing-request` replies `{ confirmed: true }` for `confirm`; other pairing kinds are cancelled and logged. This is the Windows path and is untested.
    - On macOS, `systemPreferences.askForMediaAccess('microphone')` is called when a `media` permission is requested.
  - The preload exposes `takingnotesDesktop.devices = { onChooser(fn: (msg: ChooserMessage) => void): () => void; select(requestId, deviceId): void; cancel(requestId): void }` over `ipcRenderer`.
  - `src/desktop/bridge.ts`: `getDesktopBridge(): DesktopBridge | null` reads `window.takingnotesDesktop`, is typed, and returns `null` in the web build. The `DesktopBridge` type matches the preload exactly. The `ChooserMessage` types are shared via a type-only import from `electron/types.ts`. Create that file here, with no runtime Electron import.

- [ ] **Step 1: Write failing tests:**
  - `opens on first bluetooth event, updates on later ones`
  - `select calls back with the device id`
  - `cancel then re-request`: the callback gets `''`, and the next open works.
  - `new open cancels a pending one`
  - Permissions: `allows audio media for app origin`, `denies video media`, `denies foreign origin`, `allows hid device for app origin`
  - `getDesktopBridge returns null without window.takingnotesDesktop`
- [ ] **Step 2:** Run `npx vitest run electron src/desktop`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire into `main.ts` and `preload.ts`.
- [ ] **Step 4:** Run the full suite plus `tsc -b`. Expected: green.
- [ ] **Step 5:** Commit: `feat(desktop): in-app device chooser and scoped permissions`.

### Task 10: Renderer device picker and desktop Ollama probe

**Files:**
- Create: `src/desktop/DevicePickerDialog.tsx`
- Modify: `src/app/AppShell.tsx` (mount `<DevicePickerDialog />` once), `src/notes/OllamaSetupStatus.tsx` (pass the bridge's `probeOllama` when present), `electron/preload.ts`, `electron/main.ts` (an `ollama:probe` IPC that `net.fetch`es `<baseUrl>/api/tags` from main, localhost only)
- Test: `src/desktop/DevicePickerDialog.test.tsx`, plus a probe test in `electron/permissions.test.ts` or a new `electron/ollamaProbe.test.ts`

**Interfaces:**
- Consumes: Task 9 `getDesktopBridge`, `ChooserMessage`. Task 6 `probeReachable`.
- Produces: `DevicePickerDialog({ bridge? })` renders nothing without a bridge. On `open` it shows a dialog titled `Choose a tablet` (bluetooth) or `Choose a USB device` (hid). The device list updates live, and shows `Searching…` while it's empty. Clicking a device calls `select`. Closing or `Cancel` calls `cancel`. On `close` it hides. `takingnotesDesktop.probeOllama(baseUrl: string): Promise<boolean>`.

- [ ] **Step 1: Write failing tests:** `renders nothing in web build`, `lists devices as they arrive`, `select sends the id`, `escape cancels`, and `probe rejects non-localhost`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite plus `tsc -b`. Then run `npm run desktop:dev` and confirm the picker opens when Connect is pressed (real Huion if available; record in `docs/desktop-spike.md`).
- [ ] **Step 5:** Commit: `feat(desktop): device picker dialog and Ollama reachability probe`.

### Task 11: Packaging, tester guide, handoff

**Files:**
- Create: `electron-builder.yml`, `build/entitlements.mac.plist`, `docs/desktop-testers.md`
- Modify: `package.json` (devDep `electron-builder` exact pin; scripts `desktop:dist:mac` and `desktop:dist:win`), lockfile, `docs/session-handoff.md` (new top section), `docs/architecture.md` (a desktop section), the spec's §11 calls as recorded

**Decided values:**
- `appId: org.takingnotes.app` and `productName: TakingNotes`.
- `files`: `dist/**`, `dist-electron/**` and `package.json`.
- `directories.output: release`.
- mac: target `dmg` and `zip` for `arm64` (record the Intel/universal call in the handoff). Set `identity: null` (ad-hoc), `hardenedRuntime: false` and `entitlements: build/entitlements.mac.plist`. `extendInfo` has `NSMicrophoneUsageDescription: "TakingNotes records lecture audio for your notes."` and `NSBluetoothAlwaysUsageDescription: "TakingNotes connects to your drawing tablet over Bluetooth."`. The icon comes from `icon.png`.
- win: `nsis` for `x64`.
- The entitlements cover `com.apple.security.device.audio-input`, `com.apple.security.device.bluetooth` and `com.apple.security.cs.allow-jit`.

- [ ] **Step 1:** Write a failing test, `electron/packaging.test.ts`, that reads `electron-builder.yml` (parse with a tiny YAML reader, or keep the config as `electron-builder.json` to avoid adding a YAML dependency, which is the builder's call) and asserts that the `appId`, both Info.plist strings, `files` and the mac arm64 target are present. This pins the values the app can't run correctly without.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Add the config and entitlements, plus the scripts `desktop:dist:mac` = `npm run desktop:build && electron-builder --mac` and `desktop:dist:win` = `npm run desktop:build && electron-builder --win`.
- [ ] **Step 4:** Run the test, the full suite and `tsc -b`, then `npm run desktop:dist:mac`. Expected: `release/TakingNotes-<version>-arm64.dmg` exists. Open the built app, confirm it launches and shows `TakingNotes <version>` in Settings. Attempt `desktop:dist:win`, and record whether it builds on macOS (if it needs Wine or CI, document how in the handoff instead).
- [ ] **Step 5:** Write `docs/desktop-testers.md`. It covers:
  - opening an unidentified-developer app (System Settings → Privacy & Security → Open Anyway; or `xattr -dr com.apple.quarantine /Applications/TakingNotes.app`)
  - installing Ollama and `ollama pull gemma4:12b`
  - granting mic and Bluetooth permission
  - exporting a backup before replacing the app
  - where the data lives (`~/Library/Application Support/TakingNotes`)
  - how to report the version
- [ ] **Step 6:** Update the handoff's new top section with:
  - what was built
  - the spike results
  - the owner checklist from spec §10
  - the tech debt from spec §9
  - the calls the builder made (container format, tools, Intel/universal, the Task 8 outcome)

  Then add a short desktop section to `architecture.md`.
- [ ] **Step 7:** Commit: `build(desktop): mac dmg and windows nsis packaging, tester guide and handoff`.
