import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRegexRunner, REGEX_TIME_BUDGET_MS, type RegexExecutor } from '@/search/regexRunner';

function fakeExecutor(run: RegexExecutor['run']): RegexExecutor & { terminate: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(run), terminate: vi.fn() };
}

describe('createRegexRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the executor matches in order', async () => {
    const exec = fakeExecutor(async () => [{ index: 1, length: 2 }, null]);
    const runner = createRegexRunner({ createExecutor: () => exec });
    await expect(runner.run('ab', ['xab', 'zzz'])).resolves.toEqual({
      ok: true,
      matches: [{ index: 1, length: 2 }, null],
    });
    expect(exec.run).toHaveBeenCalledWith('ab', ['xab', 'zzz']);
  });

  it('returns the compile error without calling the executor', async () => {
    const create = vi.fn();
    const runner = createRegexRunner({ createExecutor: create });
    const r = await runner.run('[', ['a']);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/^Invalid pattern/);
    expect(create).not.toHaveBeenCalled();
  });

  it('times out a never-resolving executor and terminates it', async () => {
    const hung = fakeExecutor(() => new Promise(() => {}));
    const runner = createRegexRunner({ createExecutor: () => hung });
    const p = runner.run('a', ['a']);
    await vi.advanceTimersByTimeAsync(REGEX_TIME_BUDGET_MS);
    await expect(p).resolves.toEqual({ ok: false, error: 'This pattern took too long to run' });
    expect(hung.terminate).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh executor for the run after a timeout', async () => {
    const hung = fakeExecutor(() => new Promise(() => {}));
    const good = fakeExecutor(async () => [null]);
    const made = [hung, good];
    const create = vi.fn(() => made.shift() as RegexExecutor);
    const runner = createRegexRunner({ createExecutor: create });
    const first = runner.run('a', ['a']);
    await vi.advanceTimersByTimeAsync(REGEX_TIME_BUDGET_MS);
    await first;
    await expect(runner.run('a', ['b'])).resolves.toEqual({ ok: true, matches: [null] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(good.run).toHaveBeenCalledTimes(1);
  });

  it('a newer run supersedes an older one', async () => {
    const hung = fakeExecutor(() => new Promise(() => {}));
    const good = fakeExecutor(async () => [{ index: 0, length: 1 }]);
    const made = [hung, good];
    const runner = createRegexRunner({ createExecutor: () => made.shift() as RegexExecutor });
    const older = runner.run('a', ['a']);
    const newer = runner.run('a', ['a']);
    await expect(older).resolves.toEqual({ ok: false, error: 'superseded' });
    await expect(newer).resolves.toEqual({ ok: true, matches: [{ index: 0, length: 1 }] });
    expect(hung.terminate).toHaveBeenCalled();
  });

  it('works through the in-thread fallback when Worker is unavailable', async () => {
    vi.useRealTimers();
    const runner = createRegexRunner();
    await expect(runner.run('b+', ['abbc'])).resolves.toEqual({ ok: true, matches: [{ index: 1, length: 2 }] });
    runner.dispose();
  });
});
