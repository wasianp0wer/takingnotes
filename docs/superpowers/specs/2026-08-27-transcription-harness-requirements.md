# Transcription Quality Harness — Requirements

**Status:** spike (throwaway; the deliverable is an answer, not code we keep)
**Date:** 2026-08-27
**Task:** #1
**Gates:** Plan 3 (inference) entirely, and Phase 2's stroke→PNG renderer (task #10)

## The decision this exists to inform

Whether local handwriting transcription is good enough to build steps 4–5 of the
workflow on, and if so: **which model, at what image resolution, with what
prompt, and how long does a page take.**

Spec decision D2 already makes the model a runtime choice, so this is not about
picking a single winner forever. It is about choosing a sensible default and
learning how *sensitive* the result is to each knob — because D8 binds Plan 3 to
a prompt registry and a resolution setting, and those are only worth their
complexity if the knobs actually matter.

A secondary and equally real outcome: **finding out that it does not work well
enough.** That is a legitimate result. It would put spec decision D1
(local-only inference) back on the table rather than quietly shipping a
transcription feature that produces confident nonsense.

## Inputs

`samples/handwriting/` — gitignored, personal. Currently 7 images in two groups:

- `samplenote{1,2,3}.png` — 1409×1869, exactly the Huion A5 logical page size
  (`HUION_DEFAULT_PAGE_WIDTH_A5`/`HEIGHT_A5`), so these are pad-derived renders.
- `125notes{1,2,3,4}.webp` — 952×1269, same aspect ratio, captured images.

That split is a natural experiment worth reporting separately: pad renders are
clean synthetic strokes on white; captured images carry real paper, lighting and
camera noise. If accuracy differs sharply between them, the renderer's output
(task #10) is doing more work than the model, and Phase 2's renderer settings
matter more than the model choice.

Optional ground truth: `<basename>.txt` beside an image. None present today, so
the first run is scored by human reading.

## What the harness varies

| Knob | Values | Why |
|---|---|---|
| Model | `gemma4:12b`, `gemma4:26b` | The two vision models pulled locally. 26b is ~2.4× the weights; the question is whether it is ~2.4× the wall-clock for a worthwhile accuracy gain. |
| Image resolution | native, plus at least two downscales | Trades directly against speed and is a Plan 3 setting per D8. Also determines what task #10 should render at. |
| `num_ctx` | Ollama default, and an explicit large value | **Primary hypothesis for the reported image-token problem.** Ollama's default context is far below these models' 262144, and an image plus prompt can exceed it. Truncation here is silent — it degrades output rather than erroring — so a run that does not control for it can blame the model for a configuration fault. |
| Prompt | one baseline, at least one variant | D8 assumes prompts are model-family-specific and do not transfer. This is where that assumption gets its first evidence. |

## What it measures, per run

- **Wall-clock seconds per page.** First-class, not a footnote: it sets the
  design of Plan 3's queue UX. A 20-page session at 30s/page is ten minutes.
- **Output token count and whether generation hit a stop/length limit.**
- **Whether the response looks truncated** — the signature of the `num_ctx` fault.
- **The transcript itself**, written to disk for side-by-side reading.
- **Accuracy**, scored against `.txt` ground truth where present; otherwise
  presented for human judgement. Explicitly not an automated metric this round —
  with 7 samples and no ground truth, a similarity score would be false rigour.

## Outputs

- `samples/handwriting/results/<timestamp>/` — gitignored, containing:
  - one markdown file per (model, resolution, num_ctx, prompt) combination, with
    the transcript and its timing
  - `summary.md` — a table of every combination with timing and a truncation flag,
    plus a recommendation
- A short verbal recommendation: default model, default resolution, whether
  prompts proved family-sensitive, and realistic per-page timing for Plan 3.

## Non-goals

- Not a scoring framework. No BLEU/CER/edit-distance pipeline for 7 samples.
- Not a browser harness. A Node script talks to `http://localhost:11434`
  directly, avoiding CORS, `OLLAMA_ORIGINS`, and the whole sandbox networking
  question that is Plan 3's problem, not this spike's.
- Not reusable. Anything built here is labelled throwaway. Plan 3 writes the
  real client against D8's constraints.
- Not summarisation. Transcription only; summarisation is a text-only step whose
  quality depends on transcription succeeding first.

## Prerequisites

- Ollama reachable at `http://localhost:11434` (verified: v0.33.2).
- `gemma4:12b` and `gemma4:26b` pulled, both reporting the `vision` capability
  (verified).
- No `OLLAMA_ORIGINS` needed — this is server-to-server, not browser-origin.

## Success criteria

The spike is done when it can answer, with evidence:

1. Is local transcription of *this* handwriting good enough to build on?
2. Which model and resolution is the right default, and what does a page cost in
   wall-clock seconds?
3. Was the image-token problem a `num_ctx` configuration fault or a real model
   limit — and if real, what is the workaround?
4. Do pad renders transcribe materially better or worse than captured images?
