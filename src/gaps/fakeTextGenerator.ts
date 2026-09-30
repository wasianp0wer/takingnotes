import type {
  TextGenerateJsonOptions,
  TextGenerateOptions,
  TextGenerator,
} from '@/llm/ollamaText';

export interface FakeGeneratorCall {
  prompt: string;
  system?: string;
  model: string;
  json: boolean;
}

export interface FakeTextGenerator extends TextGenerator {
  readonly calls: FakeGeneratorCall[];
  /** Replies handed out in order; the last one repeats once they run out. */
  replies: string[];
  /** When set, every call rejects with it. */
  failWith: Error | null;
  /** Runs before each reply - a hook for asserting state mid-flight. */
  onGenerate: ((call: FakeGeneratorCall) => Promise<void> | void) | null;
}

/**
 * A scripted `TextGenerator`. P1's tests never reach Ollama: the real generator's
 * guards are `src/llm`'s to test, and a gap analysis test is about what the
 * analyzer does with an answer, not about how the answer arrived.
 *
 * `generateJson` runs the caller's own `validate`, because dropping bad rows is
 * part of what these tests are checking.
 */
export function createFakeTextGenerator(replies: string[] = []): FakeTextGenerator {
  const calls: FakeGeneratorCall[] = [];
  const fake: FakeTextGenerator = {
    calls,
    replies: [...replies],
    failWith: null,
    onGenerate: null,

    async generate(prompt: string, opts: TextGenerateOptions): Promise<string> {
      return run(prompt, opts, false);
    },

    async generateJson<T>(prompt: string, opts: TextGenerateJsonOptions<T>): Promise<T> {
      const text = await run(prompt, opts, true);
      return opts.validate(JSON.parse(text) as unknown);
    },
  };

  async function run(prompt: string, opts: TextGenerateOptions, json: boolean): Promise<string> {
    const call: FakeGeneratorCall = { prompt, system: opts.system, model: opts.model, json };
    calls.push(call);
    if (opts.signal?.aborted === true) throw new Error('Generation aborted');
    await fake.onGenerate?.(call);
    if (fake.failWith) throw fake.failWith;
    const reply = fake.replies.length > 1 ? fake.replies.shift() : fake.replies[0];
    return reply ?? '[]';
  }

  return fake;
}
