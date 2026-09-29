import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { getSettingValue, setSettingValue } from '@/storage/settingKeys';
import { resetDatabase } from '@/test/resetDb';
import { flush, mount, waitFor } from '@/triage/testing';
import { useScratchpad, type ScratchpadState } from '@/triage/useScratchpad';

beforeEach(resetDatabase);

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
});
