# Transcription Quality Harness — Findings

**Status:** spike complete. Requirements: `2026-08-27-transcription-harness-requirements.md`
**Date:** 2026-08-27 · **Task:** #1 · **Gates:** Plan 3, and task #10's render resolution
**Setup:** Ollama 0.33.2, `gemma4:12b` / `gemma4:26b` (both `vision`), 7 real samples
(3 pad renders at 1409×1869, 4 captured images at 952×1269)

## Verdict

**Local transcription is viable and should be built.** Output is coherent, structurally
faithful, and correctly marked up. Spec decision D1 (local-only) stands.

## F1 — Disable thinking. This is the finding.

`gemma4` reports a `thinking` capability and Ollama enables it by default.

| `think` | Wall-clock | Output | Notes |
|---|---|---|---|
| `true` (default) | **214.0s** | 424 chars | ~4,500 tokens of reasoning |
| `false` | **6.3s** | 434 chars | |

**34× faster, and more accurate** — the thinking run misread "outlaws Christianity →
persecution" as "prevention". A 20-page session goes from ~70 minutes to under 2.

**Plan 3 must send `think: false` as a hard default, not a setting.**

## F2 — There is a resolution floor, and falling below it is catastrophic

Not a gradient. At 512px on a dense page the model could not read the text and fell into a
degenerate loop emitting `[illegible]` — **78,137 characters, 15 unique lines, 1,369s
(23 minutes)**, terminating only on `done_reason=length`.

| Long edge | Behaviour |
|---|---|
| 512 | **Degenerate.** Unbounded repetition, hit the length cap |
| 768 | Normal (5.4s / 7.2s) |
| 1024 | Normal |
| native (1409/952) | Normal |
| 1536 | Normal (5.5s / 7.6s), no gain over 1024 |

Above ~768 the differences are noise. `prompt_eval` was **378–381 tokens on every run
regardless of input resolution**, which indicates Ollama normalises images internally —
so rendering above ~1024 is wasted work.

**Task #10 should render at 1024 on the long edge.** Plan 3 should treat resolution as a
setting with a floor, not a free dial.

## F3 — Three guards Plan 3 needs, all learned from F2

1. **Cap output tokens** (`num_predict`). A page is 150–250 tokens; the degenerate run
   produced ~20,000. Without a cap one bad page stalls the queue for 23 minutes.
2. **Detect degenerate repetition.** `done_reason=length` plus a unique-line ratio catches
   it. A high character count is a *failure* signal here, not a success signal.
3. **Per-page timeout.** Independent of the token cap.

These make task #13's "sequential, resumable, cancellable" design load-bearing rather than
defensive.

## F4 — Prefer `gemma4:12b`, despite `26b` being faster

| Model | Median/page | Mean chars |
|---|---|---|
| `gemma4:12b` native | 4.7s | 486 |
| `gemma4:26b` native | 4.1s | 439 |

`26b` is faster (30 blocks vs 48 — sparser per token). But on a page with a hand-drawn
branching diagram, `12b` reproduced the diagram in ASCII and preserved indentation, while
`26b` flattened it to plain lines. `26b` also misread "Transhumance / Proof finding" as
"Transhuman / Poor fishing".

For notes, a flattened diagram is a lost idea, not a typo. **Default `12b`.**

## F5 — The Ollama image-token concern does not apply

`prompt_eval` was 378–381 tokens on every run against a 262,144-token context. There is
nothing to work around, and `num_ctx` needs no override. The real constraint was F1
(thinking) and F2 (resolution floor) — both invisible if you only look at context limits.

## F6 — Pad renders vs captured images

No systematic accuracy difference. Both transcribe well. The pad-render pages happened to
be sparser, which shows up as lower character counts, not lower quality.

## Prompt note

The instruction "mark anything you cannot read as `[illegible]`" is correct at usable
resolutions and a repetition sink below them. Keep it, but pair it with the F3 guards
rather than relying on the model's restraint.

## Recommended Plan 3 defaults

| Setting | Value | Source |
|---|---|---|
| Model | `gemma4:12b` | F4 |
| `think` | `false` (hard default) | F1 |
| Render long edge | 1024, floor 768 | F2 |
| `num_predict` | ~2000 | F3 |
| `num_ctx` | leave default | F5 |
| Expected per page | 4–8s | F1/F4 |

## Not established

- **No ground-truth scoring.** No `.txt` ground truth existed, so accuracy is human
  judgement over 7 samples. Enough to choose a default; not enough to claim a rate.
- **One prompt variant only.** D8's assumption that prompts are family-specific is
  untested — both models here are `gemma4`.
- **Single machine.** Timings do not transfer to other hardware.
