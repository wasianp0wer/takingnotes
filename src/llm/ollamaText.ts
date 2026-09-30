import {
  createOllamaClient,
  DegenerateOutputError,
  isDegenerateOutput,
  stripCodeFence,
  type FetchLike,
} from '@/llm/ollamaClient';

/**
 * Output token cap for a text call. Same reasoning as transcription's cap
 * (finding F3): a gap analysis or a syllabus extraction is a few hundred tokens,
 * and a degenerate run produced ~20,000.
 */
export const DEFAULT_TEXT_NUM_PREDICT = 2000;

export interface TextGenerateOptions {
  model: string;
  system?: string;
  numPredict?: number;
  signal?: AbortSignal;
}

export interface TextGenerateJsonOptions<T> extends TextGenerateOptions {
  /**
   * Turns the parsed JSON into the shape the caller wants, throwing when it
   * cannot. Mandatory: a model's JSON is untrusted input, so every caller states
   * what it expects and either drops the bad rows or fails - nothing is cast.
   */
  validate: (value: unknown) => T;
}

export interface TextGenerator {
  /**
   * One completion. Applies `think: false`, a `num_predict` cap, a timeout and
   * degenerate-output rejection, and unwraps a fenced answer.
   */
  generate(prompt: string, opts: TextGenerateOptions): Promise<string>;
  /** As `generate`, but parses JSON, with one repair attempt before failing. */
  generateJson<T>(prompt: string, opts: TextGenerateJsonOptions<T>): Promise<T>;
}

export interface OllamaTextGeneratorOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Tolerates a model that wraps its JSON in prose ("Sure! Here are the points:").
 * Deliberately crude - the outermost bracket pair - and tried before spending a
 * whole model call on a repair; anything it gets wrong still falls through to
 * that repair.
 */
function sliceJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (end <= start) return null;
  const slice = text.slice(start, end + 1);
  return slice === text ? null : slice;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = [text];
  const salvaged = sliceJson(text);
  if (salvaged !== null) candidates.push(salvaged);

  let message = 'empty response';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: message };
}

const repairPrompt = (bad: string): string =>
  `The text below was supposed to be a single JSON value, but it could not be parsed.

Return the same data as valid JSON. Output JSON only: no commentary, no explanation, no code fences. Do not invent data that is not there; if there is none, return an empty JSON array.

${bad}`;

/**
 * Text generation against Ollama, sharing every guard with handwriting
 * transcription through `createOllamaClient` (docs/architecture.md §6.4). P1's
 * gap analysis and P2's syllabus extraction both go through this.
 */
export function createOllamaTextGenerator(
  opts: OllamaTextGeneratorOptions,
): TextGenerator {
  const client = createOllamaClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    label: 'Generation',
  });

  async function generate(prompt: string, o: TextGenerateOptions): Promise<string> {
    client.throwIfAborted(o.signal);
    const data = await client.generate(
      {
        model: o.model,
        prompt,
        system: o.system,
        options: { num_predict: o.numPredict ?? DEFAULT_TEXT_NUM_PREDICT, temperature: 0 },
      },
      o.signal,
    );

    const text = stripCodeFence(data.response ?? '');
    if (isDegenerateOutput(text, data.done_reason)) {
      throw new DegenerateOutputError('Degenerate output: the model repeated itself');
    }
    return text;
  }

  return {
    generate,

    async generateJson<T>(prompt: string, o: TextGenerateJsonOptions<T>): Promise<T> {
      const first = await generate(prompt, o);
      let parsed = parseJson(first);

      if (!parsed.ok) {
        // One repair attempt, then give up with a readable error rather than
        // inventing a result (spec-phase2, P1 "Comparison output").
        client.throwIfAborted(o.signal);
        const repaired = await generate(repairPrompt(first), o);
        parsed = parseJson(repaired);
        if (!parsed.ok) {
          throw new Error(
            `The model did not return valid JSON, even after one repair attempt: ${parsed.error}`,
          );
        }
      }

      // A `validate` failure is not retried: the JSON parsed, so the shape was
      // wrong rather than the syntax, and asking the model to repair its JSON
      // would spend another call on the wrong remedy. The caller's own
      // `validate` decides whether to drop bad rows or throw.
      return o.validate(parsed.value);
    },
  };
}
