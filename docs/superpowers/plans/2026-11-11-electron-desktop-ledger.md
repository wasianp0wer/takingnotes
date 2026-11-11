# SDD ledger — plan: docs/superpowers/plans/2026-11-11-electron-desktop.md

Spec: docs/superpowers/specs/2026-11-11-electron-desktop-design.md (approved by owner 2026-11-11)
Branch: electron @ 7ff935d. Lanes (CLAUDE.md parallelism): A = T1→T5 in worktree lane-a; B = T6 in lane-b; C = T7→T9 in lane-c. Then merge A, B, C one at a time; then T8 (conditional), T10, T11 on electron.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T3,T4 | encodeRecord/buildBackupBlob/readBackupHeader/sliceBinary/BackupFormatError | names consistent |
| T2→T4 | openNamedDb, setActiveDbName, canSwitchDatabase, closeNotesDb | consistent |
| T3→T4,T5 | exportBackup, backupFileName, BACKUP_STORES, isBackupLocalStorageKey | consistent |
| T4→T5 | inspectBackup, importBackup, ImportBlockedError(.blockers), BackupTooNewError, ImportBlocker | consistent |
| T5 vs T7 | vitest.config.ts owned by T5; T7 told not to touch it | parallel-safe as long as T7 uses electron/vitest.config.ts if needed |
| T5 vs T7 | package.json/lockfile: only T7 (lane C) | ok |
| T6→T10 | OllamaSetupStatus probeReachable prop; bridge.probeOllama | consistent |
| T7→T9 | main.ts/preload.ts extended; electron/types.ts created in T9 | sequential in lane C |
| T8 vs T9 | both mention src/desktop/bridge.ts | T8 runs after T9 → extends it |
| T9→T10 | getDesktopBridge, ChooserMessage, devices.onChooser/select/cancel | consistent |
| T1 self | tests match interface | ok |
| T2 self | ok | ok |
| T3 self | ok | ok |
| T4 self | step 6 writes localStorage then pointer; staging cleanup on failure | ok |
| T5 self | copy fixed | ok |
| T6 self | ok | ok |
| T7 self | vitest include for electron/ tests undetermined | Ruling below |
| T11 self | names electron-builder.yml but leaves json/yml open | Ruling below |

Ruling: T7 electron tests — if root vitest config doesn't include electron/**, add electron/vitest.config.ts + make `npm test` run both — keeps lane C off lane A's vitest.config.ts — cost if wrong: one extra config file to fold in later.
Ruling: T11 uses electron-builder.json (not .yml) — avoids a YAML dependency just for a test — cost if wrong: trivial rename.
Ruling: Lanes run in parallel per owner CLAUDE.md, overriding the SDD skill's "never parallel implementers" — owner instruction outranks skill — cost if wrong: merge conflicts, caught at merge with full-suite runs.

## Progress
Dispatched (parallel): T1 lane-a base 7ff935d; T6 lane-b base 7ff935d; T7 lane-c base 7ff935d
Task 6: complete (commits 7ff935d..6914eb8, review clean) — lane B done
Task 6: minor (deferred): set-state-in-effect lint warning in OllamaSetupStatus mount check
Task 6: minor (deferred): status stale when baseUrl/model edited until "Check again"
Task 6: minor (deferred): getSettingValue rejection leaves `checking` stuck true (no try/finally)
Task 6: minor (deferred): HTTP 4xx/5xx from running Ollama classed as unreachable/blocked
Task 6: minor (deferred): clipboard writeText rejection unhandled; no copy feedback
Task 6: minor (deferred): TranscriptPanel failed-transcript tests now hit real fetch to localhost:11434 (non-hermetic); clipboard stub not restored
Task 1: complete (commits 7ff935d..2f64e15, review clean)
Task 1: minor (deferred): Date/Map/Set/Blob in records serialize to {} silently — current schema has none; document or throw
Task 1: minor (deferred): whole-buffer typed views copied (transient 2x memory); views not deduped
Task 1: minor (deferred): dedup of same ArrayBuffer not asserted in test; semicolon style mismatch test vs src
Ruling: Task 1 shallow manifest validation (stores/localStorage/ref shapes unchecked) is carried into Task 4 as a requirement: inspectBackup must validate manifest shape and every BinaryRef bound and throw BackupFormatError('corrupt') before any write — Review Focus #3 lives in Task 4 anyway — cost if wrong: Task 4 slightly larger
Task 2: complete (commits 2f64e15..28e8b98, review clean)
Task 2: minor (deferred): db.ts <-> activeDb.ts circular import (call-time only; TDZ trap if top-level use added)
Task 2: minor (deferred): openNotesDb blocked/blocking/terminated logs name DB_NAME not the opened name
Task 2: minor (deferred): no test for bare `takingnotes-` rejection; brittle spread of localStorage stub in a test
Task 3: complete (commits 28e8b98..ae30562, review clean)
Task 3: minor (deferred): default globalThis.localStorage path untested; exported values not asserted; recordingAudio key not asserted; `takingnotes.activeDb.probe` would be exported if left behind
Ruling: Task 7 CSP adds `blob:` to script-src (transformers.js loads ORT loader as blob: URL; Whisper fails without it) and Google Fonts hosts to style-src/font-src (src/index.css imports them) — spec anti-goal "desktop less capable than browser" outranks the plan's exact CSP list — cost if wrong: slightly wider CSP (blob: scripts are same-origin-created only)
Ruling: Task 8 skipped — spike shows default Ollama allows app://* (GET, preflighted POST, 127.0.0.1 all 200; docs/desktop-spike.md) — cost if wrong: testers with custom OLLAMA_ORIGINS see the `blocked` setup message
Task 7: review 1 — spec ❌: `npm test -- <filter>` exits 1 / filter not applied to web suite (G5). Fix round 1 dispatched (resume implementer), FIX_BASE 8d36bb0
Ruling: Task 7 nav hardening (will-frame-navigate, will-redirect, web-contents-created/will-attach-webview) pulled into fix round 1 though reviewer rated Minor — spec §5 states navigation is blocked — cost if wrong: a few lines of extra wiring
Task 7: minor (deferred): app:// handler ignores Range header; no CSP in dev; window title from index.html (Task 11); connect-src lists 'self' and app://takingnotes; electron-dev stopAll re-entry
Task 7: note: Ollama default-origins verified on Ollama 0.40.13 only
Task 4: flaky test noted: GapPanel > carries draft choices… failed once in full run, passed after (pre-existing, untouched)
Task 4: review 1 approved (no Critical/Important). FIX_BASE b189124
Ruling: Task 4 minors #2 (re-check blockers before swap), #1 (pin 3rd-batch failure + async failure variant), #5 (re-export ImportBlockedError) pulled into fix round 1 — spec anti-goal is data loss; a recording started mid-import would be dropped at the swap — cost if wrong: one extra small round
Task 4: minor (deferred): orphaned staging/old DBs after a crash are never swept (a sweep risks deleting the active DB if the pointer is unreadable — needs care)
Task 4: minor (deferred): gap analysis pending/running is not an import blocker
Task 4: minor (deferred): closeNotesDb microtask window could reopen old DB before swap (reload follows; comment it)
Task 4: minor (deferred): unreachable `if (!storage)` check; records decoded 3x during import
Task 4: fix round 1/5 (3 addressed, 0 open; commits b189124..c27f325)
Task 4: complete (commits ae30562..c27f325, review clean)
Task 4: minor (deferred): `export { ImportBlockedError }` sits mid-import-block; doubled blank line in test
Task 7: note: web suite flaky under heavy load (NotesHalf, ThemeBuilderDialog, AdvancedSearch) — verify on idle machine at merge
Task 7: fix round 1/5 (2 addressed, 0 open; commits 8d36bb0..b39e34c)
Task 7: complete (commits 7ff935d..b39e34c, review clean)
Task 7: minor (deferred): test-all.mjs detects empty suite by matching vitest's stdout text; piped output loses TTY formatting
Task 8: skipped (Ruling above: Ollama accepts app://* by default)
Task 5: complete (commits c27f325..c122b04, review clean) — lane A done
Task 5: minor (deferred): revoke not asserted in test; URL stubs leak (Object.assign on URL); revoke not in finally / sync revoke after click; only 2/5 blocker messages + progress text untested; "1 notes" plural; config quote style
Merged lane A (7cb07cf, 2024 tests green, tsc clean)
Merged lane B (f91887b): 2033 tests; 1 intermittent failure in 2 of 8 runs under load (avg ~50-60), 5/5 consecutive green after; tsc clean; lint 0 errors/6 warnings (+1 from Task 6). Flake noted for final review.
Task 9: complete (commits b39e34c..80b152e, review clean) — lane C done
Task 9: carry to Task 10: DevicePickerDialog must subscribe at app root for the document's lifetime (late/unmounted subscription = hung requestDevice); Bluetooth e2e unverified (macOS TCC prompt; owner check)
Task 9: minor (deferred): no test for wrong requestId while pending; IPC sender gating untested + duplicates isAppOrigin; HID device permission allows all HID devices; did-start-navigation cancels picker before will-navigate; mic shows granted before TCC
Merged lane C (728fb05): web 2035 + electron 45 green, tsc clean, build + desktop:build ok
Task 10: complete (commits 728fb05..3f16c1f, review clean)
Task 10: minor (deferred): ollama:probe net.fetch follows redirects (use redirect:'manual'); picker exit animation never plays; duplicate HID names indistinguishable; test file style; DESCRIPTIONS copy not in brief
Ruling: Task 11 also keeps the desktop window title "TakingNotes" (prevent page-title-updated in main) rather than editing index.html's web title — web title is the web build's business — cost if wrong: one-line change
Task 11: complete (commits 3f16c1f..75f458d, review clean)
Task 11: minor (deferred): handoff says "one web test is flaky" but names four, and points at the untracked ledger; "Nobody clicked anything" wording; long line in architecture §10.4; electron-builder npm audit findings uninvestigated; page-title-updated untested (wiring)
Ruling: Task 11 mac.identity "-" (ad-hoc) instead of plan's null — null skipped signing, codesign --verify failed; spec §7 requires ad-hoc — cost if wrong: none known
Ruling: Task 11 excludes node_modules from the app + npmRebuild false — main/preload are esbuild bundles with only electron external; dmg 238→118 MiB — cost if wrong: a future runtime dep in main would need adding back
Final review (59ed3a4..75f458d): 0 Critical, 2 Important (I1 old DB deleted at import while pointer may be unflushed/absent → orphaned data; I2 older backups bypass upgrade path), 8 Minor. FIX_BASE 75f458d
Ruling: Final fix wave includes I1 (deferred old-DB deletion + desktop storage flush), I2 as guard comment + recorded debt (no data migrations exist yet), M1 explicit userData + separate dev profile/lock, M2 OLLAMA_ORIGINS copy + tester guide, M5 Electron fuses, M6/M7/M8 handoff notes, M4 port note in §8 steps (no --strictPort: would change `npm run dev`), T1 encodeRecord throws on unsupported objects, T10 probe redirect:'manual', T6 hermetic TranscriptPanel tests, T11 flaky wording — these are cheap and the reviewer marked I1/M1 tester-blocking — cost if wrong: a larger single fix wave
Ruling: M3 (manifest string size limit ~512MB of strokes) stays recorded debt — far beyond current data — cost if wrong: very large libraries can't export until format v2
Final fix wave re-review (75f458d..fca575b): all addressed except I1 residual — startup cleanup also runs on the import's own reload, so web build / failed desktop flush can still delete old DB before pointer is on disk
Ruling: I1 residual gets one targeted follow-up (resume the fixer): cleanup skips the browser session that performed the import (sessionStorage marker set before reload) + test "cleanup after the import's own reload keeps the old database" — data loss is the spec's top anti-goal and the fix is tiny; deviates from the skill's "no second fix wave" — cost if wrong: one extra small commit
Final minor (deferred): flushStorageData only starts the write (comment overclaims); empty --user-data-dir= in dev falls back to shared profile; blocked delete stays queued
Final: I1 residual fixed (d82b38e); verified by controller: web 2070 + electron 69 green, tsc clean, lint 0 errors/6 warnings. Plan complete.
