# Phase 2 — Session Engine: Design

**Spec:** `docs/superpowers/specs/2026-08-25-note-capture-app.md`
**Roadmap:** `docs/superpowers/plans/2026-08-25-roadmap.md` (Plan 2)
**Covers tasks:** #7, #8, #9, #10, #18
**Depends on:** Phase 1A (storage), Phase 1B (device)
**Status:** design — not yet broken into an executable plan

---

## 1. What changed since the roadmap was written

The roadmap framed Phase 2 around offline capture: write on the pad, download
at the end, reconcile. A week of real use reordered the priorities:

> "More important is A) keeping the connection alive and B) ensuring that
> pressing the page turn button on the pad creates a new page in the app."

These are not two feature requests bolted onto the side of the session engine.
Given finding **C6**, they *are* the session engine:

- The page turn is the **only** signal that commits a page to device memory.
  Miss it and the page is not merely mis-rendered in the UI — it is not
  downloadable, because nothing told the device to write it.
- The link is the only channel that signal travels over. A drop is not a
  degraded experience; it is silent data loss for everything written after it.

So the design below leads with detection and resilience, and treats the
state machine as the thing built on top of them, rather than the reverse.

---

## 2. Settled decisions

From the spec (D1–D8) plus four locked during Phase 2 discussion:

| # | Decision |
|---|---|
| S1 | **Force a page turn when a session ends, with an escape hatch.** C1/C6 mean the in-progress page is not in device memory; forcing a turn is what commits it. The escape hatch covers a pad that is off, out of range, or unresponsive — fall back to the live-captured buffer for that page. |
| S2 | **Sessions are durable, with a 1-hour inactivity timeout.** An idle session notifies the user and shuts itself down. An abandoned session recovers on next load, or completes with whatever it has. |
| S3 | **Orphan pages are ignored.** Pages written to the pad with no session running do not appear as notes. |
| S4 | **Clear the device only after pages are persisted.** "Persisted" (written to IndexedDB), not "rendered" — rendering is a derived artifact and can be redone from stored strokes. Combined with D3, always ask first. |

---

## 3. Constraints from hardware

Carried forward from the spec, because they decide most of the design:

- **C1/C6** — a page commits to ROM on page turn only, streaming or not.
- **C2** — bulk download is ~15 s/page and flaky. Download incrementally.
- **C4** — live and offline points share a normalized 0–1 coordinate space.
- **C5** — offline points have no timestamps, so live and offline data cannot
  be merged *within* a page. Source selection is per-page.

---

## 4. Write pacing: a structural fix, not a local one

The reentrancy bug fixed in `45b0f77` had overlapping recovery passes issuing
~90 writes/sec against a design pace of 25/sec, which overran the controller
and killed the link mid-transfer. That was fixed at the call site.

**Phase 2 should make the whole class impossible.** The transport gains a
single serialized write queue with a floor on inter-write spacing. Every write
in the driver goes through it, so no future code path — however many callers or
timers it has — can saturate the radio.

This matters here specifically because Phase 2 *adds* periodic writes (§5.2's
page-count poll) to a link that already carries downloads and streaming. Adding
concurrent writers to the exact subsystem that just failed from concurrent
writers, without a structural guard, would be repeating the bug on purpose.

Properties:

- FIFO, one write in flight at a time.
- Minimum gap between writes (start at the driver's current 40 ms).
- Priority tier so a user-initiated command is not stuck behind a thousand
  queued re-requests.
- Queue drains and rejects on disconnect, so nothing writes into dead GATT.

This is testable without hardware against `FakeHuionTransport`, using the
`writtenAt` timestamps added for the reentrancy tests.

---

## 5. Page-turn detection (issue B)

### 5.1 Why the notification alone is not enough

The field log recorded `page turns: claimed 4 / detected 0`. Whether the cause
is the frame never arriving or the driver not dispatching it is being measured
by the pending probe re-run. **The design should not depend on the answer.**

A signal that (a) is the sole commit trigger for all page data and (b) has been
observed failing in the field is not a signal to build a pipeline on
unprotected, regardless of which layer turns out to be at fault.

### 5.2 Design: poll is authoritative, notification is an accelerator

`getStoredPageCount()` (Phase 1B) reads the count from ROM. That count is
ground truth: it increments exactly when a page commits, which by C6 is exactly
when a page turn happens.

- **Poll** the stored page count on a slow interval while a session is active
  (~5 s), through the write queue, suspended during downloads.
- **Treat a count increase as the page-turn event.** This is the authoritative
  path — it works whether or not `0x8A` arrives.
- **Treat an arriving `0x8A` as a hint** that triggers an immediate poll rather
  than waiting for the next interval. This preserves the responsiveness of the
  notification without trusting it for correctness.
- **Deduplicate**: the count is the state; the notification only changes *when*
  it is read. A page turn detected by both paths is one event.

This subsumes task #9 (ROM-authoritative reconciliation) rather than sitting
beside it — the same count that detects turns reconciles the page list.

**Cost.** One extra frame every ~5 s, which is roughly 0.5% of the write budget
that caused the overrun. The write queue bounds it regardless.

**Tradeoff being made deliberately.** Polling detects a page turn up to 5 s
late when the notification is lost. For the UI that is a visible lag. The
alternative — trusting the notification — is not "faster", it is "fast when it
works and silently wrong when it doesn't", and the field log says it doesn't.
If the probe shows `0x8A` is reliable post-fix, the poll interval can be
lengthened to a safety net rather than removed; removing it puts data
correctness back on a signal we have watched fail.

---

## 6. Connection resilience (issue A)

### 6.1 Reconnect

Web Bluetooth requires a user gesture for `requestDevice()`, but **not** for
`gatt.connect()` on an already-permitted device. Automatic reconnect is
therefore possible without prompting, as long as the device was paired in this
origin.

- On unexpected disconnect during an active session: reconnect with backoff
  (1 s, 2 s, 4 s, 8 s, capped ~30 s), indefinitely while the session is active.
- The session stays `active` across the gap. A drop is not a session end.
- On reconnect, re-run the page-count poll immediately and reconcile: any pages
  committed while the link was down are discovered by the count, not lost.

This last point is the payoff of §5.2. Because detection is poll-based rather
than event-based, **a page turn that happens while disconnected is still found
on reconnect.** An event-based design loses it permanently.

### 6.2 Liveness

A GATT connection can be nominally open while nothing flows. The probe already
tracks "last inbound frame". The device controller should carry the same:

- Track time since last inbound frame.
- While a session is active and no download is in flight, if that exceeds a
  threshold (~15 s), issue a cheap read as a ping. Failure means the link is
  dead regardless of what `gatt.connected` claims — force a disconnect and
  enter the reconnect path.

### 6.3 Tab throttling

Chrome throttles timers in hidden tabs, which would stall both the poll and the
liveness check. Detect `visibilitychange`, and warn the user that capture is
unreliable in a background tab. Recording an accurate `hidden` interval on the
session is more honest than pretending the gap did not happen.

---

## 7. Session state machine (task #7)

```
   idle
     │ start
     ▼
   active ──────── drop ────────► reconnecting ──┐
     │  ▲                              │         │
     │  └──────── reconnected ─────────┘         │
     │                                  session stays active
     │ end (user)            inactivity 1h
     ▼                              │
  finalizing ◄──────────────────────┘
     │  force page turn (S1), download outstanding pages,
     │  persist, render
     ▼
  completed
```

- **`active`** — capturing live points, polling page count, downloading each
  page as it commits.
- **`reconnecting`** — a substate of active, not a separate lifecycle. The
  session does not end because the radio blinked.
- **`finalizing`** — forces the page turn (S1), waits for the count to
  increment, downloads what is outstanding, persists, renders. The escape hatch
  fires if the pad does not respond within a timeout: fall back to the live
  buffer for the in-progress page and complete.
- **`completed`** — every page persisted. Only now is clearing the device
  offered (S4 + D3).

Abandoned sessions (S2) are recovered on load: a session found `active` or
`finalizing` with no live device re-enters `finalizing` and completes with what
it has. Nothing is silently discarded.

---

## 8. Per-page source selection (task #9)

Per C5, no merging within a page. For each page, in order:

1. **Downloaded ROM data** if the download succeeded — full fidelity, complete.
2. **Live-captured buffer** if the download failed or the page never committed
   (the final page under the S1 escape hatch).
3. **Mark the page degraded** if neither exists, and surface it. A note that
   admits a missing page is worth more than one that quietly renumbers.

Record on each page which source produced it. Phase 3 transcription quality and
any later re-download both depend on knowing.

---

## 9. Rendering (task #10)

Strokes → PNG, per D7 stored as `ArrayBuffer` + `renderType`, never `Blob`.
Renders are derived and reproducible from stored strokes, which is exactly why
S4 gates clearing on *persisted* rather than *rendered*: losing a render costs
CPU, losing strokes costs the note.

Resolution is a user setting, not a constant (D8c) — Phase 3's transcription
reads these images and the useful resolution depends on the chosen model.

---

## 10. Clearing the device (task #18)

Gated on: session `completed`, every page either persisted or explicitly
acknowledged as degraded. Always a confirmation dialog (D3), every time, naming
the page count. Never automatic, never remembered.

---

## 11. Open questions

1. **Does `0x8A` arrive at all?** Pending probe re-run. Does not block this
   design — it decides the poll interval, not the architecture.
2. **Does the pad accept a programmatic page turn (`CMD.NEXT_PAGE`)?**
   S1 assumes it does. Untested against hardware. If it does not, the escape
   hatch becomes the primary path and finalizing must prompt the user to press
   the button physically.
3. **Poll during an active download?** Currently specified as suspended, to
   keep the write budget clear. If downloads prove long enough that page turns
   are missed during them, this needs revisiting.
4. **Reconnect while a download is mid-transfer** — resume the page or restart
   it? Restarting is simpler and C2 says a page is ~15 s. Probably restart.

---

## 12. Exit criteria

Unchanged from the roadmap, plus the two priorities that prompted this design:

- start → write → interrupt → resume → complete produces a correct multi-page
  note with rendered images;
- a page turn produces a new page in the app **even if the `0x8A` notification
  is never delivered**;
- a mid-session disconnect does not end the session, does not lose pages
  committed while disconnected, and does not require re-pairing.
