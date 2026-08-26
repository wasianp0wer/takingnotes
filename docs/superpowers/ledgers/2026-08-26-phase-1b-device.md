# SDD ledger — plan: docs/superpowers/plans/2026-08-26-phase-1b-device.md

Spec: docs/superpowers/specs/2026-08-25-note-capture-app.md (read)

## Setup

- Worktree `.claude/worktrees/phase-1b-device` on branch `worktree-phase-1b-device`.
- **Ruling: reset the worktree branch from d150499 to local main (6228940).** EnterWorktree's
  default baseRef is `fresh`, which branches from origin/<default-branch> — and origin/main is
  still the pre-Phase-1A commit because nothing has been pushed. The worktree came up with no
  `src/storage/` at all. Caught before any work; `git reset --hard main` repointed it.
  Cost if wrong: none — the branch had no commits of its own yet.
  NOTE FOR FUTURE PHASES: this will recur on every worktree until main is pushed. Check the
  base commit immediately after EnterWorktree.
- Baseline: 51 tests pass, lint exactly 53 problems (1 error + 52 warnings, all pre-existing
  in studio files), build green.

## Pre-flight conflict scan

### Cross-task: shared files and interfaces

| Tasks | Shared file / interface | Produces vs consumes | Finding |
|---|---|---|---|
| T1 → T2..T5 | `src/utils/huionProtocol.ts` (`CMD`, `makeFrame`, `computeAuthResponse`, UUIDs) | T1 extracts; T2-T5 import | OK. T1 is a pure move, no behaviour change. |
| T1 ↔ T2..T5 | `src/utils/huionBLE.ts` | All five modify the same 953-line file | **SERIALIZATION REQUIRED** — T1-T5 must run strictly in order, never in parallel. Ruled: dispatch sequentially (SDD already forbids parallel implementers). |
| T2 → T3,T4,T5,T7 | `FakeHuionTransport`, `HuionTransport` | T2 produces; four tasks consume | OK. |
| T2 → T3,T4,T5,T7 | `src/test/huionFixtures.ts` (`withChecksum`, `connectedFake`) | T2 produces; four tasks consume | OK — deduplicated during plan self-review; previously copy-pasted into two test files. |
| T2 ↔ T3,T4,T5 | `src/utils/huionBLE.test.ts` | T2 creates it; T3, T4, T5 each append | OK, but each append must not disturb earlier describes. Sequential execution makes this safe. |
| T3 ↔ T4 | `handleNotification` CURRENT_PAGE branch | T3 adds `pageCountResolve` ahead of the existing download logic; T4 adds single-page download | **WATCH** — T3 inserts an early `break` in the CURRENT_PAGE branch. If T4's `downloadPage` relies on that branch, T3's early return could swallow it. T4's implementer must read T3's change before writing. Carried into T4's dispatch. |
| T6 → T7 | `createEmitter` | T6 produces; T7 consumes | OK. Independent of T1-T5. |
| T7 → (Phase 2) | `DeviceController` | T7 produces | OK. |

### Per-task self-consistency

| Task | Finding |
|---|---|
| T1 | Tests cover exactly the four pure functions extracted. Self-consistent. |
| T2 | Steps renumbered during plan self-review (fixture step inserted). Skeleton uses a field + constructor assignment, not a parameter property — `erasableSyntaxOnly` would reject the latter. Self-consistent. |
| T3 | 3 tests; the >255 case pins little-endian decoding. Self-consistent. |
| T4 | 3 tests; the third pins buffer reset between consecutive pulls. Self-consistent. |
| T5 | 3 tests assert emitted frames only — correct, since the wire format is unverified. Self-consistent. |
| T6 | 5 tests including the iterate-a-copy semantics the impl provides. Self-consistent. |
| T7 | `__emitPenForTest` is a declared test seam, not an accident. Self-consistent. |

### Rulings made before dispatch

- Ruling: **the hardware smoke test after Task 2 does not block Tasks 3-7.** The plan says a
  human runs it before Task 3. But Tasks 3-5 add driver methods and never touch
  `BleHuionTransport`, and all are verified against the fake transport — so a Task 2 radio
  regression would be isolated to Task 2's diff, not compounded by later work. SDD is explicit
  that a running plan does not wait on a human. The smoke test moves to a phase exit item,
  surfaced to the user with the final report.
  Cost if wrong: if Task 2 did regress the real radio, it is found at phase end rather than
  mid-run; the fix is still confined to Task 2's diff.

Scan complete. One serialization constraint, one cross-task watch item (T3→T4), both ruled.

## Execution

Task 1: complete (commits 6228940..4a3ec37, review clean — spec ✅, quality Approved, zero issues)
Task 1: reviewer independently diffed the full pre/post huionBLE.ts rather than trusting the
  report, and confirmed the move is byte-identical apart from `export` keywords + the import
  block. Controller resolved its ⚠️ (lint count not visible in diff) by running lint directly.
Task 2: DONE_WITH_CONCERNS (commit 64dc4b3, 65/65 green). Three deviations from the brief,
  all ruled acceptable before review:
  - Ruling: ACCEPT the extra `setStatus` constructor arg on BleHuionTransport. The moved code
    calls setStatus('Scanning...') and setStatus('Connecting GATT...'); a log-only transport
    would silently drop both and change the UI status sequence. Passing it through PRESERVES
    behaviour, which was the task's primary constraint — brief-literalness loses to it.
    The HuionTransport interface itself is unchanged. Cost if wrong: the concrete class has one
    more constructor arg than the plan showed; two-line revert.
  - Ruling: ACCEPT `BluetoothRequestDeviceFilter[]` instead of `BluetoothLEScanFilter[]`. My
    plan invented a type name that does not exist in this repo's hand-written
    src/types/web-bluetooth.d.ts. Plan error, not implementer error.
  - Ruling: ACCEPT dropping the unused FakeHuionTransport import from the Task 2 test file;
    noUnusedLocals would fail the build. The brief's import list was written for the combined
    Task 2+3 test file.
Task 2: implementer claimed `npm run build` does not type-check. CONTROLLER VERIFIED THIS IS
  FALSE — introduced a deliberate type error in a scratch file and `npm run build` failed with
  TS2322. run.mjs runs `tsc -b` and exits non-zero before vite. Every "build green" claim in
  this project is therefore sound. Harmless error: the implementer ran tsc separately anyway.
Task 2: HARDWARE SMOKE TEST OUTSTANDING (per pre-flight ruling, does not block Tasks 3-7).
Task 2: review — spec ✅, Approved with one fix requested. 1 Important, 6 Minor.
Task 2: Ruling: FIX the Important finding (FakeHuionTransport delivers notify before write()
  resolves — inverse of a real radio). This is a PLAN bug, not an implementer bug: I wrote that
  code and its comment, and the comment states the opposite of what the code does. Reviewer
  proved the ordering empirically with a harness. Consequence if left: Task 4's downloadPage
  assigns pageResolve AFTER `await write(...)`, so the handler would read null, the download
  would hang to timeout, and the obvious "fix" would be reordering the driver — the exact
  hardware regression Task 2 exists to prevent. Cost if wrong: a four-line change to a test
  double that the four existing tests are insensitive to either way.
Task 2: minor (deferred): tests leave ~3 pending timers each (10s handshake timeout never
  cleared; battery/device-name writes continue after connect resolves). Harmless now; revisit
  if Tasks 3-5 make the suite noisy.
Task 2: minor (deferred): constructor sits between field declarations in huionBLE.ts.
Task 2: minor (deferred): HUION_BLE_FILTERS/HUION_OPTIONAL_SERVICES are shared module-level
  arrays where the original built fresh literals per call. Safe — requestDevice does not mutate.
Task 2: minor (deferred): `sleep` duplicated between huionBLE.ts and huionTransport.ts.
Task 2: minor (deferred): fixture frames end in a checksum byte where captured command frames
  end in 0xED; handleNotification never checksum-verifies command frames so nothing breaks,
  but the fixture's "as a real device would" comment is imprecise.
Task 2: fix round 1/5 (1 addressed, 0 open; commits 64dc4b3..514f79e). Implementer also added
  src/test/fakeHuionTransport.test.ts unprompted, having noticed the fix would otherwise ship
  with no covering test, and verified the guard is meaningful by stashing the fix and confirming
  the new test fails on the old code. Stash stack verified empty afterwards (it is shared across
  worktrees in this repo). Production code byte-identical to the approved 64dc4b3.
Task 2: re-review — finding ADDRESSED. Reviewer independently traced both orderings and
  confirmed the added test genuinely discriminates them (fails on old code, passes on new)
  rather than being a rubber stamp.
Task 2: minor (deferred): src/test/fakeHuionTransport.ts:6 class-level doc comment still says
  "on a microtask" and now contradicts the corrected method comment three lines below.
  Introduced by the fix. Worth sweeping into the final fix wave — the original finding was
  itself a comment that contradicted its code.
Task 2: complete (commits 4a3ec37..514f79e, review clean after 1 fix round)
Task 3: review — spec ❌ (1 Important), quality Needs fixes.
Task 3: Ruling: the implementer's deviation (nesting the new branch inside the existing
  `data.length >= 5` guard rather than before it) is ACCEPTED and is BETTER than the brief.
  My literal placement would read data[3]/data[4] as undefined on a short frame and
  `(undefined << 8) | undefined` === 0, silently resolving "0 pages" instead of erroring.
  The nesting fails loud via the 5s timeout instead. Another plan defect caught by review.
Task 3: Ruling: FIX the Important finding — the write-rejection path rejects the promise but
  leaves `pageCountResolve` non-null and the timer running for up to 5s. If a downloadPages()
  CURRENT_PAGE reply lands in that window, the stale guard intercepts it and skips
  totalPages/timer-reset/requestPageDownload(0), so a real download returns silently
  incomplete rather than hanging. Cost if wrong: three lines and one test.
Task 3: minor (deferred): two overlapping getStoredPageCount() calls clobber each other's
  resolver; no single-flight guard. Outside realistic Phase 2 usage (one baseline query per
  session start).
Task 3: fix round 1/5 (1 addressed, 0 open; commits c8de9cc..8eef0b7). Implementer rejected my
  suggested test skeleton as non-discriminating (a single-field overwrite masks the bug) and
  wrote a stronger interaction test against downloadPages() with fake timers, verified RED
  then GREEN. Fifth defect caught in controller-authored text this phase.
Task 3: re-review — finding ADDRESSED, all four exit paths verified clean. Reviewer confirmed
  the interaction test genuinely discriminates (traced both paths through the fake's macrotask
  model) and that the implementer's criticism of my suggested skeleton was correct.
Task 3: complete (commits 514f79e..8eef0b7, review clean after 1 fix round)
Task 3→4 watch item from the pre-flight scan is RESOLVED: the CURRENT_PAGE guard is correctly
  scoped to a pending standalone query and falls through to the download path otherwise.
Task 4: review — spec ❌ (3 Important), quality Needs fixes.
Task 4: Ruling: FIX all three.
  (1) The implementer's "device never sends CURRENT_PAGE/ROM_INFO unsolicited" claim rests on
      proving a negative, and this same file documents NEXT_PAGE as "capture-proven: unsolicited"
      on page turn — the exact trigger this feature targets. Overloading `pageResolve` as a
      placeholder means an unsolicited ROM_INFO mid-pull would hijack the download and resolve
      the caller with page 0's data mislabelled as the requested page.
  (2) downloadPage/downloadPages share mutable state with no mutual exclusion. A concurrent bulk
      call orphans the single-page resolver and can hang the bulk caller FOREVER (its timeout
      guard checks `pageResolve`, which the single-page path nulls). Phase 2 polls per-page
      during a live session while TabletPanel's bulk button still exists — this is plausible,
      not contrived.
  (3) Test 3 does not pin what it claims: requestPageDownload() already resets per-key, so
      deleting the entry-reset block would not fail it.
  Cost if wrong: an explicit download-mode field instead of an overloaded resolver — slightly
  more state, but it makes the in-flight condition legible instead of inferred.
Task 4: minor (deferred): stale `totalPages` in the status string during a single-page pull.
Task 4: minor (deferred): pagePackages.clear() vs requestPageDownload's narrower per-key set.
Task 4: fix round 1/5 (3 addressed, 0 open; commits ca1ae59..5358050). Each finding got a
  dedicated test verified RED against pre-fix code then GREEN. Finding 3's entry-reset was
  proven genuinely dead for isolation and two of three lines removed — the implementer took
  the "if it's redundant, delete it" branch rather than keeping an unpinned block.
Task 4: re-review — F1, F2, F3 all ADDRESSED, but NEW Important breakage introduced by the fix.
  Three writes inside handleCommand (huionBLE.ts:671 CURRENT_PAGE query, :706 requestPageDownload(0),
  :497 page-to-page continuation) are bare awaits. A rejection escapes to handleNotification's
  generic swallowing catch, leaving downloadMode stuck at 'bulk' with nothing to reset it — so the
  new entry guards reject EVERY subsequent download until disconnect. Pre-fix this hung one
  download; post-fix it wedges the driver for the session. Exactly the failure mode the re-review
  prompt was told to watch for, and worse than the bug being fixed.
  Per SDD, new Important breakage in a fix diff joins the open findings — proceeding to fix round 2.
Task 4: fix round 2/5 (1 addressed, 0 open; commits 5358050..da706c8). Implementer audited beyond
  the 3 named continuation writes and found 2 more with the same swallowed-rejection pattern
  (handleOfflinePackageResponse and verifyAndRecoverOfflinePage REGET_PACKAGE retries); covered
  all five via two chokepoints rather than per-site patches. Wedge-reproduction test confirmed
  RED then GREEN.
Task 4: re-review round 2 — ADDRESSED. Reviewer independently re-grepped all 12 `await this.write`
  sites and found no sixth gap; abort path verified consistent (no double-settle) and idempotent
  (safe with no download in flight, and when called twice); test confirmed a real guard.
Task 4: minor (deferred): the handleCommand chokepoint is a blanket catch around ALL commands,
  so a future non-download handler that throws mid-download would silently abort that download.
  Safe today (no other handler both awaits a fallible op and can overlap a download) but a wider
  blast radius than the five named sites. Surface to final review.
Task 4: complete (commits 8eef0b7..da706c8, review clean after 2 fix rounds)
Task 5: complete (commits da706c8..b8b3b68, review clean — spec ✅, quality Approved, zero blocking)
Task 5: reviewer independently grepped src/ and confirmed deletePage/clearCache are unreachable
  from any component, hook, provider or App.tsx, and that the download state machine is untouched.
Task 5: minor (deferred): the deletePage test only asserts the low byte (pageNum=4); a regression
  dropping `(pageNum >> 8) & 0xff` would go undetected for small page counts. Gap in my brief's
  test, not an implementer error.
Task 6: complete (commits b8b3b68..1622daf, review clean — spec ✅, quality Approved)
Task 6: REVIEWER FINDING REJECTED (not deferred). The reviewer's Minor claimed the "added during
  emit" test does not discriminate, on the premise that JS Set iteration skips elements added
  after iteration begins. That premise is false. Verified empirically:
    live `for (const v of set)` with an add mid-loop  -> visits [1, 2]
    snapshot `for (const v of [...set])` with the same -> visits [1]
  So the `[...listeners]` snapshot IS load-bearing and the test WOULD fail without it. Recording
  as a correction so the final review does not inherit the false belief that the emitter has a
  redundant snapshot and a weak test.
Task 7: review — spec ✅, quality Approved, 1 Important + 2 Minor.
Task 7: Ruling: FIX the Important finding rather than defer it. The reviewer's own verdict was
  "Approved, no functional impact", which reads like a Minor mislabelled — but downgrading a
  reviewer's severity to avoid work is the exact rationalization SDD warns against, and
  adjudication belongs at the cap, not here. The finding is also in a class that already cost
  this phase a fix round: a comment asserting something factually false about driver behaviour
  (Task 2's fake transport). Cost if wrong: one cheap dispatch.
Task 7: minor (deferred): no test combines "two subscribers, unsubscribe one, verify the other
  still fires" — isolation verified by inspection only, in both controller.test.ts and
  emitter.test.ts.
Task 7: minor (deferred): DeviceState.status is a free-form string inherited from
  HuionNoteBLE's StatusCallback type. Flag for Phase 4.
Task 7: fix round 1/5 (1 addressed, 0 open; commits 1342219..633cba5). Implementer traced the
  driver and confirmed the review's claim: VERIFY_RESPONSE sets authenticated + setStatus at
  huionBLE.ts:682-683, MAX_INFO calls setStatus('Connected') at :703, both strictly before
  connectResolve() at :705. Removed the redundant setState; the toContain(true) assertion still
  passes, which is the proof. Also corrected two report sections repeating the wrong claim.
Task 7: re-review — ADDRESSED. Comment verified factually correct against huionBLE.ts; connect()
  now consistent with its three siblings; tests unchanged and passing.
Task 7: complete (commits 1622daf..633cba5, review clean after 1 fix round)

ALL 7 TASKS COMPLETE. Proceeding to final whole-branch review.

---

## Final whole-branch review (opus, 6228940..633cba5)

Verdict: **Ready to merge — with fixes.** 0 Critical, 7 Important, ~9 Minor. Reviewer walked all
18 steps of the moved connect() against the original and confirmed the refactor faithful.

### Controller rulings on the final review

- Ruling: FIX all seven Importants in one wave. Three of them (#1 close() identity loss,
  #2 onNextPage aborting a download, #3 the downloadMode start-window) are latent traps that
  Phase 2's design specifically triggers — download-on-page-turn, and session finalisation after
  a disconnect. Each is a few lines now versus a debugging session later.
  Cost if wrong: a larger fix wave at the end of a phase that was otherwise clean.
- Ruling: #1 and #5 and #7 are PLAN defects, not implementer defects.
    #1 - my Step 2 skeleton prescribed the close() body that nulls `device`, inside the task I
        labelled "strictly behaviour-preserving".
    #5 - my justification for __emitPenForTest ("needs a valid 11-byte payload") was false;
        withChecksum() already produces exactly that, and the fixtures file exports it. The seam
        put a __-prefixed method on a production interface AND removed the only test that would
        catch the pen wiring being deleted.
    #7 - my hardware smoke-test script exercises Tasks 1-2 only. getStoredPageCount, downloadPage,
        deletePage and clearCache are unreachable from ProbeApp, so "hardware smoke test passed"
        could be ticked with every Phase-2-critical operation unverified on a radio.
  That makes NINE defects caught in controller-authored text across Phases 1A and 1B.
- Ruling: ADD two non-destructive probe buttons (page count, download page N) as part of the fix
  wave. ~20 lines, and it converts the hardware exit criterion from hollow to meaningful.
  Cost if wrong: ProbeApp grows slightly; it is a diagnostic tool, not shipped UI.
- Ruling: ACCEPT the reviewer's triage of the deferred minors verbatim — 6 fix, 7 accept.
Final fix wave: commits 633cba5..ade5bff (8e1b27c, b7676d1, ade5bff). 104 tests (was 93).
  Mutation-verified: deleting `device.onPen = ...` now fails 2 tests; removing the emitter
  membership guard fails 1. Implementer also fixed a defect my prescribed fix did not cover —
  pageCountResolve intercepting a bulk download's CURRENT_PAGE reply, now gated on downloadMode.

### Scoped re-review of the fix wave (633cba5..ade5bff)

Verdict: ALL findings ADDRESSED (I1-I7 + all 9 minors). No new Critical/Important breakage.
Reviewer hand-verified the pen packet decodes to status:1, pressure~0.5 (not vacuous), traced all
15 downloadMode set/clear sites, and confirmed downloadPages()'s contract is preserved against
the pre-fix source.

Three residuals adjudicated (no second fix wave per SDD):

- Task: parked — stale comments at huionBLE.ts:409-410 ("unlike downloadPages(), which assigns
  pageResolve only after awaiting its write") and fakeHuionTransport.ts:55-60 ("enough to strand
  any driver path that assigns its resolver after the write (downloadPages does exactly that)").
  I3's restructure made both false.
  Ruling: park, and open Phase 2 with a comment sweep. Not load-bearing — no later task builds on
  them — and fixing them myself would skip review, which is the rule I have held all phase. Noting
  with some discomfort that this is the THIRD comment-contradicts-code instance this phase, and
  the first two each cost a fix round.
  Cost if wrong: a future reader restructuring downloadPage() is misled about why the fake uses a
  macrotask, and may reintroduce the microtask ordering bug.

- Task: parked — disconnect() settles an in-flight download but not a pending page-count query,
  so the new single-flight guard makes a reconnect-and-requery inside the abandoned query's
  remaining 5s throw "already in progress".
  Ruling: park. Self-heals when the timer fires; requires a disconnect, reconnect and re-query
  inside one 5s window. One settlePageCount() call would close it.
  Cost if wrong: a spurious rejection in a narrow window, recoverable by waiting 5s.

- Task: parked — downloadPages()'s write is no longer inside a try, so a SYNCHRONOUS throw would
  wedge the mutex. Unreachable today: both HuionTransport implementations declare write as async,
  so they return rejected promises rather than throwing.
  Ruling: park. Note for Phase 2 if a non-async transport is ever added.

ALL 7 TASKS COMPLETE. Final review clean after one fix wave.
