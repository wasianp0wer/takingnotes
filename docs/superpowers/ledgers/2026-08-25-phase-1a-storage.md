# SDD ledger — plan: docs/superpowers/plans/2026-08-25-phase-1a-storage.md

Spec: docs/superpowers/specs/2026-08-25-note-capture-app.md (read)

## Setup

- Worktree: `.claude/worktrees/phase-1a-storage` on branch `worktree-phase-1a-storage`,
  branched from `main` @ d150499 (local == origin/main, verified).
- Commit c296070: copied spec + plans into the branch so the plan travels with the code.
  Left untracked on `main`: `probe.html`, `src/probe/` (the Huion diagnostic probe) —
  not part of Phase 1A, and not committed because the user did not ask for a commit on main.

## BLOCKED — environment: npm cannot fetch packages

Baseline setup (worktree skill Step 2/3) could not complete. Diagnosis, in order:

1. `npm install` and `npm ci` both abort with `Exit handler never called!`, leaving a
   corrupt tree — `node_modules/.bin/{vite,tsc,eslint}` all missing, many packages
   marked invalid/extraneous.
2. Not a Node version problem. `EBADENGINE` (Node v25.8.1 vs required `>=20 <23`) was a
   red herring: installed Node 20.20.2 via fnm and reproduced the identical failure.
3. Root cause is network. The npm debug log shows every tarball fetch failing with
   `ETIMEDOUT` against `packages.applied-caas-gateway1.internal.api.openai.org/artifactory/...`
   — a transparent sandbox proxy — even though `npm config get registry` is
   `https://registry.npmjs.org/` and that host answers HTTP 200 in 45ms.
4. Offline install is not viable: `npm cache ls` reports **0** cached entries for all four
   packages Phase 1A needs (`vitest`, `fake-indexeddb`, `happy-dom`, `idb`).

Consequence: subagents cannot run Task 1 Step 1 or Task 2 Step 1 (both are `npm install`),
and cannot run tests or builds at all. Execution cannot start.

The main checkout at `/Users/maddiepersonal/takingnotes` still has a healthy, untouched
`node_modules` — it was installed before, when the registry was reachable.

## Rulings

- Ruling: Installed Node 20.20.2 via fnm to match `.nvmrc` and the `engines` field —
  the repo declares it, and it removed EBADENGINE as a variable while diagnosing.
  Cost if wrong: a ~50MB Node version added to fnm; nothing else on the machine changed,
  and it is removable with `fnm uninstall 20`.
- Ruling: Did NOT retry installs with the sandbox disabled. Bypassing the sandbox is a
  security-sensitive action and one of the four things SDD says to stop and ask about,
  rather than decide unilaterally.
  Cost if wrong: one round trip to the user instead of an autonomous fix.
- Ruling (pending user action): dependencies will be installed out-of-band, so Task 1
  Step 1 and Task 2 Step 1 become *verification* steps for the implementers rather than
  install steps. Subagents inherit the same broken proxy and cannot install.
  Cost if wrong: none material — the plan's intent is that the deps exist.

## Status

Not started. No tasks dispatched. Awaiting a working dependency install.

---

## UNBLOCKED (2026-08-25)

Dependencies installed successfully in the worktree. The registry proxy failure was
transient — a retry in-sandbox succeeded in 323ms. Installed: idb 8.0.3, vitest 3.2.7,
fake-indexeddb 6.2.5, happy-dom 17.6.3. `node_modules/.bin/{vite,tsc,eslint,vitest}` all present.

### Baseline (worktree skill Step 3)

- `npm run build` — PASSES (tsc -b + vite build, ~1.25s).
- `npm run lint` — **1 error, 52 warnings, all pre-existing.**
  Error: `src/components/CanvasEngine.tsx:370` `'_isDrawing' is assigned a value but never used`
  (@typescript-eslint/no-unused-vars). Warnings are react-hooks/refs and no-explicit-any
  across the studio.
- `npm test` — not yet runnable; Task 1 creates it.
- Working tree: `package.json` + `package-lock.json` modified (the dependency install).
  Task 1 commits these.

### Rulings

- Ruling: Phase 1A exit criterion "npm run lint is clean" is amended to "introduces no NEW
  lint problems; baseline is 1 error + 52 warnings, all in studio files".
  Why: the single error is in `src/components/CanvasEngine.tsx`, which the plan's own Global
  Constraints forbid touching, and Phase 5 deletes outright. Requiring a clean global lint
  would force implementers to violate the plan.
  Cost if wrong: a stale lint error survives until Phase 5, where the file is deleted anyway.
- Ruling: Task 1 Step 1 and Task 2 Step 1 (the `npm install` steps) become VERIFICATION
  steps — implementers confirm the package is present and do not re-install.
  Why: all four dependencies are already installed; the sandbox proxy is unreliable and a
  redundant install risks corrupting a working tree.
  Cost if wrong: none material — the plan's intent is that the deps exist.
- Ruling: Task 1 commits `package.json` + `package-lock.json` covering ALL FOUR dependencies,
  including `idb` (nominally Task 2's). Task 2 then has no dependency commit of its own.
  Why: they were installed in one out-of-band operation and cannot be cleanly separated.
  Cost if wrong: `idb` appears one commit earlier than the plan implies; no functional impact.

---

## Pre-flight conflict scan

### Cross-task: shared files and interfaces

| Tasks | Shared file / interface | Produces vs consumes | Finding |
|---|---|---|---|
| T1 ↔ T2 | `package.json`, `package-lock.json` | T1 adds test deps; T2 adds `idb` | **CONFLICT** — both mutate the same file for the same purpose. Resolved by ruling above: deps pre-installed, T1 commits all four, T2 verifies only. |
| T1 → T2..T6 | `vitest.config.ts`, `src/test/setup.ts` | T1 produces the runner + fake-indexeddb global; every later task consumes it | OK. `include: ['src/**/*.test.ts']` matches all five later test files. |
| T2 → T3,T4,T5,T6 | `openNotesDb()`, `src/storage/types.ts` | T2 produces; all four consume | OK. Names match across every task. |
| T2 → T3,T4,T5,T6 | `resetDatabase()` from `@/test/resetDb` | T2 produces; all four `beforeEach(resetDatabase)` | OK — single definition, four consumers. |
| T3 → T4 | `newId()` | T3 creates `src/storage/id.ts`; T4 imports it | OK. T4 must run after T3 — ordering respected. |
| T3 → T4 | `deleteNote()` | T3 produces; T4's final test asserts page cascade | OK, but T4's test exercises **T3's** code. A cascade bug surfaces as a T4 failure. Noted, not a defect. |
| T3 → T6 | `createNote()`, `updateNote()` | signatures `{title, deviceId, pageBaseline}` / `(id, patch)` | OK — T6 uses exactly these. |
| T4 → T6 | `createPage()` | `{noteId, pageIndex, devicePageNum, source, strokes}` | OK — T6 passes exactly these five fields. |
| T5 → T6 | `getSetting()`, `setSetting()` | T5 produces; T6 uses for the idempotency flag | OK. |

### Per-task self-consistency

| Task | Tests vs code vs files | Finding |
|---|---|---|
| T1 | `setup.test.ts` asserts the env `setup.ts` + `vitest.config.ts` create | Self-consistent. |
| T2 | `resetDb.ts` imports `db.ts`, created in the same task | Self-consistent. Step 5 explicitly states the test fails until Step 6 — ordering is intentional, not an error. |
| T3 | 7 tests against 6 exported functions | Self-consistent. |
| T4 | 10 tests; `countPoints` exported and tested directly | Self-consistent. |
| T5 | 5 tests incl. the stored-`null` vs unset distinction, which the impl handles via `record === undefined` | Self-consistent. |
| T6 | 9 tests; fixture shape matches `DownloadedMemoryNotebook` in `src/types/memory.ts` | Self-consistent. |

### Watch items (not conflicts)

- `tsconfig.app.json` sets `noUncheckedSideEffectImports: true`, and `src/test/setup.ts` is a
  bare side-effect import (`import 'fake-indexeddb/auto'`). If that subpath does not resolve
  under `moduleResolution: bundler`, `npm run build` fails even though tests pass. T1 Step 8
  runs the build specifically to catch this.
- T4 Step 5 is a live branch, not boilerplate: if `fake-indexeddb` cannot structured-clone a
  `Blob`, `PageRecord.render` changes shape and Phases 2 and 4 inherit that change.

Scan complete. One conflict found (T1↔T2 package.json), ruled on before dispatch.

---

## Execution

Task 1: complete (commits c296070..bb9fc03, review clean — spec ✅, quality Approved)
Task 1: minor (deferred): out-of-band install regenerated package-lock.json, bumping ~169
  pre-existing transitive versions (@babel/*, @esbuild/*, nested @radix-ui dedupes) beyond
  the 4 target deps. Reviewer traced it as ordinary lockfile-regeneration churn, all within
  existing semver ranges, no unexpected packages; build verified green. Surface to the final
  whole-branch review.
Task 2: complete (commits bb9fc03..35a9a30, review clean — spec ✅, quality Approved)
Task 2: minor (deferred): `by-started` index on `notes` has no direct assertion in
  db.test.ts (plan-mandated gap in the brief's own test code). NOTE: Task 3's
  "lists notes newest first" test exercises it via getAllFromIndex, so it is covered
  downstream — confirm at final review.
Task 2: minor (deferred): `if (!db.objectStoreNames.contains(...))` guards in db.ts upgrade()
  are unreachable at DB_VERSION=1; harmless defensive code, copied verbatim from the brief.
Task 2: minor (deferred): early-return branch of resetNotesDbForTests() untested.
Task 3: complete (commits 35a9a30..4c8503a, review clean — spec ✅, quality Approved)
Task 3: minor (deferred): task-3-report.md overstates coverage ("plus cascading delete
  validation") — the delete test asserts only that the note is gone; the page cascade is
  verified by reading, not by test. Task 4's final test is what actually covers it.
Task 3: minor (deferred): line counts cited in task-3-report.md do not match the diff.
Task 3: note: cascading delete verified by code inspection only (transaction spans both
  stores, cursor advances, awaits tx.done). Task 4's last test is its first real exercise.
Task 4: BLOCKED on first dispatch — Blob round-trip test failed. `fake-indexeddb` does not
  structured-clone Blob: value returns as `{type:'image/png'}`, prototype and bytes lost.
  8/9 tests passed; implementer correctly escalated instead of applying the fallback.
  Note: the note-cascade test PASSED, independently validating Task 3's deleteNote().
Task 4: Ruling: adopt the ArrayBuffer + renderType fallback (spec D7 added; plan Task 4
  amended). Why: real browsers do support Blob in IndexedDB, so this is a test-tool limit
  rather than a platform one — but keeping Blob would leave the render path permanently
  untestable, Safari has a documented history of Blob-in-IDB bugs, and the runtime cost of
  ArrayBuffer is two lines (blob.arrayBuffer() on write, new Blob([buf],{type}) on read).
  Lateral at runtime, strictly better for testability. Authorised the implementer to edit
  src/storage/types.ts (Task 2's file) for these two fields ONLY.
  Cost if wrong: Phase 2's renderer and Phase 4's viewer must convert Blob<->ArrayBuffer at
  the boundary; if that proves annoying, reverting to Blob means re-amending D7 and giving
  up test coverage on that path.
Task 4: fix round 1/5 — ruling applied (ArrayBuffer + renderType per D7); 22/22 suite green;
  commits 0f97ae6..4b6742b. Not a re-review: the task was BLOCKED before any review ran, so
  the full task-reviewer gate applies to 4b6742b.
Task 4: complete (commits 0f97ae6..4b6742b, review clean — spec ✅, quality Approved)
Task 4: controller resolved reviewer's ⚠️ (lint/build claims not visible in diff) by running
  them directly: 22/22 tests pass, lint exactly 53 problems (1 error + 52 warnings, the
  unchanged baseline), npm run build green.
Task 4: minor (deferred): no "unknown id throws" test for setPageRender (only for
  setPageTranscript); both share patchPage so risk is low.
Task 4: minor (deferred): `id: existing.id` in patchPage merge is redundant given
  patch is typed Omit<PageRecord,'id'>.
Task 5: complete (commits 4b6742b..41d7050, review clean — spec ✅, quality Approved, no issues)
Task 6: DONE_WITH_CONCERNS on first dispatch (commit d5fd401, 36/36 green). Implementer
  flagged a brief-inherent defect: migrateLegacyNotebooks() sets legacyMigratedAt
  unconditionally, so a failed read/parse on the first run permanently marks the migration
  complete and the user's notebooks never import.
Task 6: Ruling: fix it — set legacyMigratedAt only when the read+parse succeeded, so an
  unreadable source stays retryable. Why: the failure is silent and permanent, and it
  contradicts the plan's own stated care for this data (it never deletes the localStorage key
  precisely because it is the only other copy). The alternative failure mode — re-attempting a
  cheap getItem + JSON.parse on each start for a user with genuinely corrupt data — is far
  milder than never importing their notes.
  Cost if wrong: a permanently-corrupt source is re-parsed once per app start (negligible),
  and the plan's literal code no longer matches the implementation.
Task 6: fix round 1/5 — retryability fix applied; 37/37 green; commits d5fd401..d8fc5bf.
  Not a re-review: no review ran before the fix, so the full task-reviewer gate covers both commits.
Task 6: complete (commits 41d7050..d8fc5bf, review clean — spec ✅, quality Approved)
Task 6: controller resolved reviewer's ⚠️ (lint claim not independently run): 37/37 tests,
  lint exactly 53 problems (unchanged baseline), build green.
Task 6: minor (deferred): isRecord() accepts arrays (typeof [] === 'object'), so an array-shaped
  notebook/point entry silently falls back to defaults rather than being rejected. Not a crash
  risk; add !Array.isArray(value) if stricter semantics are wanted. Untested shape.
Task 6: OUTSTANDING (human-only): the plan's "Verification against real data" section cannot be
  run headlessly — it needs a browser and the user's real localStorage notebook library.
  Automated tests use synthetic fixtures only.

ALL 6 TASKS COMPLETE. Proceeding to final whole-branch review.

---

## Final whole-branch review (opus, d150499..d8fc5bf)

Verdict: **Ready to merge — with fixes.** 2 Critical, 6 Important, ~9 Minor. Every finding was
empirically probed, not speculated.

### Controller rulings on the final review

- Ruling: fix Critical 1 (non-array JSON permanently strands the library) and Critical 2
  (migration duplicates everything on retry after partial failure). Both are silent,
  unrecoverable user-data outcomes. Critical 1 is the same class of bug as my earlier Task 6
  ruling — I guarded the *throw* path but not the *wrong-shape* path, so my own fix was
  incomplete. Cost if wrong: none, these are strict improvements.
- Ruling: fix Important 3 (upgrade() needs oldVersion branching), 4 (read-modify-write race),
  6 (migration discards pageWidth/pageHeight, deviceType, page timestamps).
  6 is a direct violation of the plan's own exit criterion "import without loss".
  Cost if wrong: modest extra scope in a phase meant to be foundational.
- Ruling: ALSO fix Important 5 + 7 together (move render bytes to a separate `pageRenders`
  store; accept/return `Blob` at the API boundary so `ArrayBuffer` stays a storage detail).
  Why: the reviewer measured 6.0 MB pulled into the JS heap by a single listPages() on a
  30-page note, and correctly notes D7 + inline renders is the bad combination — a browser
  Blob in IDB is lazy, an inline ArrayBuffer is not. Free at DB_VERSION=1, a data migration
  after this ships. Shipping a knowingly-bad foundation to save one fix wave is false economy.
  Cost if wrong: Phase 1A grows by one store and one accessor; if it proves over-built,
  collapsing it back is a local change to the pages repo only.
- Ruling: DEFER Important 8 (no quota handling / navigator.storage.persist()) to Phase 2 as
  its own task rather than folding it into this fix wave. Why: it is new capability, not a
  defect in what was built — the plan never asked for it. Scope discipline: the fix wave
  repairs what is broken. Cost if wrong: the window between merge and Phase 2 has no
  persist() call; risk is low because no real user data is written until Phase 2 anyway.
- Ruling: accept the lockfile churn (~169 transitive bumps, all within existing semver ranges,
  build green). Cost if wrong: a studio dependency moved a minor version; build and lint
  both verified green.
- Controller amended the plan's exit criteria directly (the D7/Blob criterion was unsatisfiable
  by design, and "npm run lint is clean" was unreachable under the plan's own constraints).
  The reviewer was right that a plan should not set exit criteria its own rules forbid meeting.

### Final-review fix wave

First fix dispatch (opus) was cut off by an API error mid-task, then stalled on resume during a
platform outage that blocked Bash safety checks. All implementation work had landed uncommitted;
only the migration tests were missing. A fresh implementer (sonnet) added them and committed the
whole wave. Ruling: treated the two platform failures as infrastructure, not agent failure — the
work was inspected directly (db.ts, types.ts, migrate.ts all read in full) and found complete and
correct before scoping the finish. Cost if wrong: none; the re-review is the gate.

Fix wave: commit 6496f4e. 51/51 tests, lint exactly 53 (unchanged baseline), build green.
Controller verified all three independently.

### Scoped re-review of the fix wave (d8fc5bf..6496f4e)

Verdict: ALL findings ADDRESSED (C1, C2, I3, I4, I5+I7, I6, all minors). No new
Critical/Important breakage. `failed` confirmed load-bearing, not decorative.

Two Minor residuals adjudicated (no second fix wave per SDD):
- Task: parked — migrate.ts:153-163, if a notebook import throws AND its deleteNote rollback
  also throws, the half-written note survives with its real legacySourceId, so the next run
  skips it and it is stuck rather than retried.
  Ruling: park. Requires two compounding failures; nothing downstream builds on it; the
  observable outcome is one stuck notebook, not corruption or loss of the localStorage source.
  Cost if wrong: a user hitting both failures must clear that note manually to re-import it.
- Task: parked — no test induces a real mid-loop exception, so the rollback/continue-to-next
  path is verified by inspection only.
  Ruling: park. The logic was read and confirmed correct by two reviewers; inducing a genuine
  throw needs fault injection the repo has no harness for.
  Cost if wrong: a regression in the rollback path would not be caught by the suite.

ALL 6 TASKS COMPLETE. Final review clean after one fix wave.
