# Phase 2 — Session Engine: Design

**Spec:** `docs/superpowers/specs/2026-08-25-note-capture-app.md`
**Roadmap:** `docs/superpowers/plans/2026-08-25-roadmap.md` (Plan 2)
**Covers tasks:** #7, #8, #9, #10, #18, #20, #21
**Depends on:** Phase 1A (storage), Phase 1B (device)
**Status:** design — not yet broken into an executable plan
**Revised:** 2026-09-17 for D9 (streaming is the source of truth)

---

## 1. What changed since the roadmap was written

The roadmap framed Phase 2 around offline capture: write on the pad, download
at the end, reconcile. Two things from real use overturned that.

**First**, the priorities reordered:

> "More important is A) keeping the connection alive and B) ensuring that
> pressing the page turn button on the pad creates a new page in the app."

**Second**, and more fundamentally, the downloaded data turned out not to be
worth building on (C7, D9). The offline path fabricates timestamps, fragments
strokes whenever a packet is lost, and applies an extra lossy filter. The live
stream is the better record, not the fallback.

So the design inverts. **The live stream is the note. Device memory is a
manual last-resort.** Everything below follows from that.

The honest cost of this inversion, stated up front: *anything written while
disconnected is gone.* There is no longer a backfill. That converts link uptime
from a quality-of-life concern into a data-integrity one, and it makes §9
(telling the user about gaps) non-optional rather than a nicety.

---

## 2. Settled decisions

From the spec (D1–D9) plus those locked during Phase 2 discussion:

| # | Decision | Status |
|---|---|---|
| S1 | ~~Force a page turn when a session ends, with an escape hatch.~~ | **Dropped.** Its purpose was committing the in-progress page to ROM. Under D9 that page is already in the live buffer, so there is nothing to force. This also removes the escape-hatch path and the untested `CMD.NEXT_PAGE` dependency. |
| S2 | **Sessions are durable, with a 1-hour inactivity timeout.** An idle session notifies the user and shuts down; an abandoned session recovers on next load or completes with what it has. | Unchanged, and easier — §8 persists continuously, so "what it has" is already on disk. |
| S3 | **Orphan pages are ignored.** | Unchanged, and now automatic: with no ROM sync, writing outside a session simply produces nothing. |
| S4 | **Clear the device only after pages are persisted**, always asking first (D3). | **More conservative.** Since we no longer download ROM, clearing destroys the only copy of anything the stream missed. Clearing should be rare and never suggested by default. |

---

## 3. Constraints from hardware

- **C1/C6** — a page commits to ROM on page turn only, streaming or not.
- **C2** — bulk download is ~15 s/page and flaky. *Now largely moot.*
- **C4** — live and offline points share a normalized 0–1 coordinate space.
- **C7** — ROM data has fabricated timestamps, fragments strokes on packet
  loss, and is extra-filtered. This is what drives D9.

---

## 4. Write pacing (task #20)

The reentrancy bug fixed in `45b0f77` had overlapping recovery passes issuing
~90 writes/sec against a design pace of 25/sec, overrunning the controller and
killing the link mid-transfer. That was fixed at the call site.

The transport gains a **single serialized write queue** so the class is
structurally impossible: FIFO, one write in flight, a floor on inter-write
spacing, a priority tier so user commands are not stuck behind bulk traffic,
and drain-and-reject on disconnect.

Under D9 the link carries far less traffic, which makes this cheaper — but no
less necessary, because §5 adds a *periodic* writer to the exact subsystem that
just died from concurrent writers.

---

## 5. Page-turn detection (issue B)

### 5.1 D9 makes this more important, not less

It would be easy to read D9 as demoting anything ROM-related. It does the
opposite here, for a reason worth being explicit about:

The **page count** is a 4-byte metadata read. Its reliability has nothing to do
with the reliability of a 1,185-packet bulk transfer, and nothing to do with
C7's quality problems — those concern stroke *data*, which we are no longer
downloading. Reading a counter is not "relying on device memory for sync."

And the consequence of a missed page turn got *worse* under D9. Previously a
merged page could be repaired by downloading it from ROM. Now there is no
repair: two pages of writing land in one live buffer permanently.

**Corrected 2026-09-17.** An earlier draft cited the field log as `page turns:
claimed 4 / detected 0` and inferred the notification was wholly unreliable.
That was a misreading — the owner reports the presses largely did register, and
the apparent misses were mostly an artifact of how that log was captured. The
real figure, from sustained use, is a miss rate of **about 1 in 5**.

That number does not weaken the case for polling; it *is* the case for polling.
At a 20% miss rate, relying on the notification alone merges two pages of
writing on one turn in five, and per the paragraph above there is nothing to
repair it with. The notification is a good fast path and a poor authority.

### 5.2 Design: poll is authoritative, notification is an accelerator

- **Poll** `getStoredPageCount()` on a slow interval (~5 s) while a session is
  active, through the write queue.
- **A count increase is the page-turn event.** Authoritative, because C6
  guarantees the count increments exactly when a page turns.
- **An arriving `0x8A` is a hint** that triggers an immediate poll rather than
  waiting for the interval — the responsiveness of the notification without
  trusting it for correctness.
- **Deduplicate on the count**, which is the state; the notification only
  changes when it is read.

**Tradeoff.** Up to ~5 s of lag on the roughly 1 turn in 5 whose notification is
lost; the other four are detected immediately via the hint. The alternative is
not "faster" — it is "fast four times out of five, silently wrong the fifth
time."

**Do not lengthen the poll interval to save traffic.** An earlier draft of this
document suggested exactly that, should `0x8A` prove reliable. At a 1-in-5 miss
rate the interval is not slack — it is the detection latency for a fifth of all
page turns.

**Note:** the poll no longer needs suspending during downloads, since routine
downloads are gone.

---

## 6. Connection resilience (issue A)

Under D9 this is the whole ballgame: uptime *is* data integrity.

**Reconnect.** Web Bluetooth requires a user gesture for `requestDevice()` but
**not** for `gatt.connect()` on an already-permitted device, so reconnect is
automatic and silent. Backoff 1/2/4/8 s capped ~30 s, indefinitely while a
session is active. The session stays `active` across the gap — a drop is not a
session end.

**Liveness.** A GATT connection can be nominally open with nothing flowing.
Track time since last inbound frame; if it exceeds ~15 s during an active
session, ping with a cheap read. Failure means the link is dead regardless of
what `gatt.connected` reports — force disconnect and enter reconnect.

**Tab throttling.** Chrome throttles timers in hidden tabs, stalling both poll
and watchdog. Warn on `visibilitychange`, and record the hidden interval as a
gap (§9) rather than pretending it did not happen.

---

## 7. Session state machine (task #7)

```
   idle
     │ start
     ▼
   active ──────── drop ────────► reconnecting
     │  ▲                              │
     │  └──────── reconnected ─────────┘
     │                          (still active; gap recorded)
     │ end (user)   |   inactivity 1h
     ▼              ▼
  finalizing
     │  flush live buffer, render, summarize gaps
     ▼
  completed
```

`finalizing` is now cheap: no forced page turn, no downloads, no reconciliation
merge. The buffer is already on disk (§8); finalizing renders and closes.

Sessions found `active` or `finalizing` on load re-enter `finalizing` and
complete with what was persisted.

---

## 8. Live buffer durability — newly critical

**This is the largest new requirement, and it exists because D9 removed the
safety net.** Previously the in-memory live buffer could afford to be lossy:
ROM was the durable copy. Now the live buffer *is* the record, so holding a
session in memory until completion means a tab crash, reload, or OOM destroys
the entire note.

- Persist strokes to IndexedDB **incrementally during the session**, not at the
  end.
- Flush on **stroke end (pen up)** — a natural, bounded boundary — plus a
  time-based flush so a single very long stroke cannot sit unsaved.
- Writes must be **idempotent and ordered**, so resume after an interruption
  neither duplicates nor reorders strokes.
- Page boundaries come from §5, and the current page index is part of the
  persisted session state.

Practically: the worst case for any crash should be losing the stroke in
progress, not the session.

---

## 9. Gap accounting — newly required

With no backfill, the only honest alternative to silent loss is to say where
the holes are.

- Record every interval the session was not receiving: disconnects, failed
  reconnects, and hidden-tab periods.
- Store them on the session and surface them on the note — e.g. *"2m14s
  disconnected; writing during this period was not captured."*
- Attach gaps to the page that was active at the time, so Phase 3
  transcription and the Phase 4 viewer can both flag affected pages.

A note that admits a hole is worth considerably more than one that quietly
presents itself as complete.

---

## 10. Manual recovery from device memory (task #9, reframed)

Task #9 was "ROM-authoritative reconciliation." Under D9 that name is wrong:
ROM is not authoritative for data, and the page *count* is authoritative only
for detecting page turns (§5).

What remains is a **manual, opt-in recovery action**: "try to recover pages
from the pad." Recommended to keep, because `downloadPage()` already exists
from Phase 1B, so demoting it to manual costs nothing, and it is the only
option after a long disconnect.

Constraints if kept:

- Never automatic, never on the session-completion path.
- Recovered pages are **marked degraded** in storage and in the UI, carrying
  the C7 caveats.
- Recovered points must not claim trustworthy timestamps — either null them or
  flag them, rather than passing off decode-time `Date.now()` as real.

Easy to drop entirely if it proves not worth the UI surface; nothing else
depends on it.

---

## 11. Rendering (task #10)

Strokes → PNG, stored as `ArrayBuffer` + `renderType` per D7, never `Blob`.
Renders are derived and reproducible from stored strokes — which is exactly why
S4 gates clearing on *persisted* rather than *rendered*.

Resolution is a user setting, not a constant (D8c).

---

## 12. Open questions

1. ~~Does `0x8A` arrive at all?~~ **Answered:** yes, roughly 4 times in 5; the
   poll covers the remainder. A probe run would refine the figure but no longer
   gates anything.
2. ~~Does the pad accept a programmatic page turn?~~ **Moot** — S1 dropped.
3. ~~Poll during an active download?~~ **Moot** — routine downloads gone.
4. **Flush granularity in §8** — per-stroke may be too chatty for IndexedDB
   during fast writing. May need batching with a short debounce; measure before
   choosing.
5. **What does the UI do during a gap?** A disconnected session still shows a
   canvas. It must be unmistakable that strokes are not being captured, without
   being so intrusive it disrupts a meeting.

---

## 13. Exit criteria

- start → write → interrupt → resume → complete produces a correct multi-page
  note with rendered images;
- a page turn produces a new page **even if the `0x8A` notification is never
  delivered**;
- a mid-session disconnect does not end the session and does not require
  re-pairing;
- **killing the tab mid-session loses at most the stroke in progress**;
- **any period where capture was not running is visible on the finished note.**
