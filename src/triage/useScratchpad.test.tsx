import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSettingValue, setSettingValue } from '@/storage/settingKeys';
import { resetDatabase } from '@/test/resetDb';
import { flush, mount, waitFor } from '@/triage/testing';
import { useScratchpad, type ScratchpadState } from '@/triage/useScratchpad';

/**
 * `getSettingValue`/`setSettingValue` delegate to the real repository unless
 * a test overrides one once, which is how the load-failure and save-failure
 * cases below are provoked (mirrors generateTasks.sync.test.ts).
 */
vi.mock('@/storage/settingKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/settingKeys')>();
  return {
    ...actual,
    getSettingValue: vi.fn(actual.getSettingValue),
    setSettingValue: vi.fn(actual.setSettingValue),
  };
});

beforeEach(resetDatabase);

/** The message the hook surfaces when a write rejects. */
const SAVE_FAILED = "Couldn't save the scratchpad — copy your text somewhere safe.";

let latest: ScratchpadState;

function Probe({ debounceMs }: { debounceMs?: number }) {
  // eslint-disable-next-line react-hooks/globals -- test probe: exposes hook state for assertions outside render.
  latest = useScratchpad({ debounceMs });
  return <pre data-testid="text">{latest.text}</pre>;
}

/** Polls storage directly, since `waitFor`'s check must be synchronous. */
async function waitForStoredValue(expected: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const stored = await getSettingValue('triage.scratchpad');
    if (stored === expected) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`expected stored value ${JSON.stringify(expected)}, got ${JSON.stringify(stored)}`);
    }
    await flush(1);
  }
}

describe('useScratchpad', () => {
  it('loads the value already in storage', async () => {
    await setSettingValue('triage.scratchpad', 'hello');

    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    expect(latest.text).toBe('hello');

    m.unmount();
    await flush();
  });

  it('collapses rapid typing into a single stored write of the final text', async () => {
    const m = mount(<Probe debounceMs={30} />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    act(() => latest.setText('a'));
    act(() => latest.setText('ab'));
    act(() => latest.setText('abc'));

    // Immediately after the last keystroke nothing has been written yet.
    expect(await getSettingValue('triage.scratchpad')).toBe('');

    await waitForStoredValue('abc');
    // Still 'abc' well after the debounce fired once - a second, delayed
    // write from an earlier keystroke would show up as flicker here.
    await flush(3);
    expect(await getSettingValue('triage.scratchpad')).toBe('abc');

    m.unmount();
    await flush();
  });

  it('writes pending text immediately on unmount', async () => {
    const m = mount(<Probe debounceMs={10_000} />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    act(() => latest.setText('unsaved'));
    m.unmount();
    await flush();

    expect(await getSettingValue('triage.scratchpad')).toBe('unsaved');
  });

  it('does not let a stored value overwrite text typed before the load resolves', async () => {
    await setSettingValue('triage.scratchpad', 'stored');

    const m = mount(<Probe />);
    // Type before the initial `getSettingValue` read has resolved.
    act(() => latest.setText('typed first'));
    await waitFor(() => expect(latest.loaded).toBe(true));

    expect(latest.text).toBe('typed first');

    m.unmount();
    await flush();
  });

  it('flush() writes pending text now', async () => {
    const m = mount(<Probe debounceMs={10_000} />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    act(() => latest.setText('flushed'));
    await act(async () => {
      await latest.flush();
    });

    expect(await getSettingValue('triage.scratchpad')).toBe('flushed');

    m.unmount();
    await flush();
  });

  it('survives StrictMode double mount/unmount/mount without losing pending text', async () => {
    const { StrictMode, createElement } = await import('react');
    const m = mount(createElement(StrictMode, null, createElement(Probe, { debounceMs: 10_000 })));
    await waitFor(() => expect(latest.loaded).toBe(true));

    act(() => latest.setText('strict text'));
    expect(latest.text).toBe('strict text');

    m.unmount();
    await flush();

    expect(await getSettingValue('triage.scratchpad')).toBe('strict text');
  });

  it('marks loaded and logs it, even when the initial read fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getSettingValue).mockRejectedValueOnce(new Error('db closed'));

    const m = mount(<Probe />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    expect(consoleError).toHaveBeenCalledWith('[triage] scratchpad load failed', expect.any(Error));
    expect(latest.text).toBe('');

    consoleError.mockRestore();
    m.unmount();
    await flush();
  });

  it('retries and logs a save that failed, instead of losing the text', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = mount(<Probe debounceMs={20} />);
    await waitFor(() => expect(latest.loaded).toBe(true));

    vi.mocked(setSettingValue).mockRejectedValueOnce(new Error('disk full'));
    act(() => latest.setText('resilient'));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[triage] scratchpad save failed', expect.any(Error)),
    );
    // The failed attempt never landed.
    expect(await getSettingValue('triage.scratchpad')).toBe('');

    // A later flush retries the same text and this time it succeeds.
    await act(async () => {
      await latest.flush();
    });
    expect(await getSettingValue('triage.scratchpad')).toBe('resilient');

    consoleError.mockRestore();
    m.unmount();
    await flush();
  });

  it('surfaces a failed save as an error, and clears it once a later write succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = mount(<Probe debounceMs={20} />);
    await waitFor(() => expect(latest.loaded).toBe(true));
    expect(latest.error).toBeNull();

    vi.mocked(setSettingValue).mockRejectedValueOnce(new Error('disk full'));
    act(() => latest.setText('visible failure'));

    // Silence here is the bug: the UI claims "Saved automatically."
    await waitFor(() => expect(latest.error).toBe(SAVE_FAILED));

    await act(async () => {
      await latest.flush();
    });
    await waitFor(() => expect(latest.error).toBeNull());
    expect(await getSettingValue('triage.scratchpad')).toBe('visible failure');

    consoleError.mockRestore();
    m.unmount();
    await flush();
  });
});
