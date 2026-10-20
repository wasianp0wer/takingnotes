import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegexRunner, RegexRunResult } from '@/search/regexRunner';
import { buildSessionCatalog } from '@/sessions/catalog';
import { EMPTY_SIDEBAR_FILTER } from '@/sessions/filter';
import type { AdvancedFilter, EntryText, RegexOutcome } from '@/sessions/filter';
import { useRegexFilter } from '@/sessions/useRegexFilter';
import type { NoteRecord } from '@/storage/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function note(id: string, title: string, startedAt: number): NoteRecord {
  return {
    id,
    title,
    status: 'complete',
    deviceId: 'd',
    deviceType: 'huion',
    deviceName: null,
    startedAt,
    endedAt: null,
    pageBaseline: 0,
    pageWidth: null,
    pageHeight: null,
    summary: null,
    summaryModel: null,
    legacy: false,
    legacySourceId: null,
  };
}

// Newest first: n2, n1.
const catalog = buildSessionCatalog([note('1', 'Alpha', 1), note('2', 'Beta', 2)], []);
const textByKey = new Map<string, EntryText>([
  ['note:1', { text: 'one', hasTypedPage: false }],
  ['note:2', { text: 'two', hasTypedPage: false }],
]);

interface Deferred {
  pattern: string;
  texts: readonly string[];
  resolve(r: RegexRunResult): void;
}

function fakeRunner() {
  const calls: Deferred[] = [];
  const runner: RegexRunner = {
    run: (pattern, texts) =>
      new Promise((resolve) => {
        calls.push({ pattern, texts, resolve });
      }),
    dispose: vi.fn(),
  };
  return { runner, calls };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: RegexOutcome | null | undefined;

function Host(props: {
  advanced: AdvancedFilter;
  text: ReadonlyMap<string, EntryText> | null;
  runner: RegexRunner;
}) {
  const outcome = useRegexFilter(props.advanced, catalog, props.text, props.runner);
  useEffect(() => {
    latest = outcome;
  });
  return null;
}

function render(advanced: Partial<AdvancedFilter>, text = textByKey, runner: RegexRunner) {
  act(() => {
    root.render(
      <Host advanced={{ ...EMPTY_SIDEBAR_FILTER.advanced, ...advanced }} text={text} runner={runner} />,
    );
  });
}

async function settle(d: Deferred, r: RegexRunResult) {
  await act(async () => {
    d.resolve(r);
    await Promise.resolve();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useRegexFilter', () => {
  it('is null when regex is off or both fields are blank', () => {
    const { runner, calls } = fakeRunner();
    render({ title: 'a', regex: false }, textByKey, runner);
    expect(latest).toBeNull();
    render({ title: ' ', text: '', regex: true }, textByKey, runner);
    expect(latest).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is pending while running, then maps matches to entry keys', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: '^B', regex: true }, textByKey, runner);
    expect(latest).toMatchObject({ pending: true, error: null, titleKeys: null });
    expect(calls[0].pattern).toBe('^B');
    expect(calls[0].texts).toEqual(['Beta', 'Alpha']);
    await settle(calls[0], { ok: true, matches: [{ index: 0, length: 1 }, null] });
    expect(latest?.pending).toBe(false);
    expect([...(latest?.titleKeys ?? [])]).toEqual(['note:2']);
    expect(latest?.textKeys).toBeNull();
  });

  it('runs the text pattern over entry texts after the title', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: 'a', text: 'on', regex: true }, textByKey, runner);
    await settle(calls[0], { ok: true, matches: [null, null] });
    expect(latest?.pending).toBe(true);
    expect(calls[1].texts).toEqual(['two', 'one']);
    await settle(calls[1], { ok: true, matches: [null, { index: 0, length: 2 }] });
    expect(latest?.pending).toBe(false);
    expect([...(latest?.textKeys ?? [])]).toEqual(['note:1']);
  });

  it('stays pending for a text pattern until the text index loads', async () => {
    const { runner, calls } = fakeRunner();
    render({ text: 'on', regex: true }, null as never, runner);
    expect(latest?.pending).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('passes a runner error through', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: '[', regex: true }, textByKey, runner);
    await settle(calls[0], { ok: false, error: 'Invalid pattern: x' });
    expect(latest).toEqual({
      pending: false,
      error: 'Invalid pattern: x',
      titleKeys: null,
      textKeys: null,
    });
  });

  it('ignores a superseded result', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: 'a', regex: true }, textByKey, runner);
    render({ title: 'b', regex: true }, textByKey, runner);
    await settle(calls[0], { ok: false, error: 'superseded' });
    expect(latest?.pending).toBe(true);
    expect(latest?.error).toBeNull();
    await settle(calls[1], { ok: true, matches: [null, { index: 0, length: 1 }] });
    expect(latest?.pending).toBe(false);
    expect([...(latest?.titleKeys ?? [])]).toEqual(['note:1']);
  });

  it('discards a late result from stale inputs', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: 'a', regex: true }, textByKey, runner);
    render({ title: 'b', regex: true }, textByKey, runner);
    await settle(calls[0], { ok: true, matches: [{ index: 0, length: 1 }, null] });
    expect(latest?.pending).toBe(true);
    expect(latest?.titleKeys).toBeNull();
  });

  it('ignores a superseded result even when inputs did not change', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: 'a', regex: true }, textByKey, runner);
    await settle(calls[0], { ok: false, error: 'superseded' });
    expect(latest).toMatchObject({ pending: true, error: null, titleKeys: null });
  });

  it('is pending again as soon as the inputs change after a settled run', async () => {
    const { runner, calls } = fakeRunner();
    render({ title: 'a', regex: true }, textByKey, runner);
    await settle(calls[0], { ok: true, matches: [null, { index: 0, length: 1 }] });
    expect(latest?.pending).toBe(false);
    render({ title: 'b', regex: true }, textByKey, runner);
    expect(latest).toMatchObject({ pending: true, titleKeys: null });
  });
});
