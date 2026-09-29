import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioSettings, WHISPER_MODEL_OPTIONS } from '@/audio/AudioSettings';
import { getSettingValue, setSettingValue } from '@/storage/settingKeys';
import { resetDatabase } from '@/test/resetDb';

// Wraps (rather than replaces) both functions so every test still reads and
// writes the real store by default; only the two load-race tests below
// override `getSettingValue`'s next call to control when it resolves, and
// assert on `setSettingValue`'s calls.
vi.mock('@/storage/settingKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/settingKeys')>();
  return {
    ...actual,
    getSettingValue: vi.fn(actual.getSettingValue),
    setSettingValue: vi.fn(actual.setSettingValue),
  };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(getSettingValue).mockClear();
  vi.mocked(setSettingValue).mockClear();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function render() {
  act(() => {
    root.render(<AudioSettings />);
  });
}

function input(): HTMLInputElement {
  const found = container.querySelector('#whisper-model');
  if (!found) throw new Error('no whisper-model input rendered');
  return found as HTMLInputElement;
}

/**
 * Waits for the component's initial `getSettingValue` read to land (it now
 * gates `commit()` - see Finding 2). `fake-indexeddb`'s resolution takes a
 * variable number of event-loop turns (its own `open` can need an
 * `onupgradeneeded` hop that a plain fixed count of `flush()` calls cannot
 * reliably predict), so this polls instead of guessing a tick count. The
 * field is empty only until the load lands, since the load always produces
 * a non-empty model id (a real value or the default).
 */
async function waitForLoad(tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (input().value !== '') return;
    await flush();
  }
  throw new Error('AudioSettings: initial load did not land in time');
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

async function typeAndBlur(el: HTMLInputElement, value: string) {
  await act(async () => {
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

async function typeOnly(el: HTMLInputElement, value: string) {
  await act(async () => {
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blurOnly(el: HTMLInputElement) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/** A `getSettingValue` result the test controls the resolution of. */
function deferGetSettingValue() {
  let resolve: (value: string) => void = () => {};
  vi.mocked(getSettingValue).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r as (value: string) => void;
      }),
  );
  return (value: string) => resolve(value);
}

describe('AudioSettings', () => {
  it('shows the default whisper model', async () => {
    render();
    await waitForLoad();

    expect(input().value).toBe('Xenova/whisper-base.en');
  });

  it('persists a typed value on blur', async () => {
    render();
    await waitForLoad();

    await typeAndBlur(input(), 'onnx-community/whisper-base');
    await flush();

    expect(await getSettingValue('whisper.model')).toBe('onnx-community/whisper-base');
  });

  it('restores and saves the default when cleared', async () => {
    render();
    await waitForLoad();

    await typeAndBlur(input(), 'onnx-community/whisper-base');
    await flush();
    await typeAndBlur(input(), '   ');
    await flush();

    expect(input().value).toBe('Xenova/whisper-base.en');
    expect(await getSettingValue('whisper.model')).toBe('Xenova/whisper-base.en');
  });

  it('lists all whisper model options in the datalist', async () => {
    render();
    await flush();

    const options = [...container.querySelectorAll('#whisper-models option')];
    expect(options).toHaveLength(4);
    expect(options.map((o) => o.getAttribute('value'))).toEqual(
      WHISPER_MODEL_OPTIONS.map((o) => o.id),
    );
  });

  it('does not let a late-resolving load clobber a typed edit', async () => {
    await setSettingValue('whisper.model', 'onnx-community/whisper-base');
    const resolveLoad = deferGetSettingValue();

    render();
    await flush();

    await typeOnly(input(), 'Xenova/whisper-small.en');

    // The stored value (different from what the user just typed) lands only
    // now - it must not overwrite the in-progress edit.
    await act(async () => {
      resolveLoad('onnx-community/whisper-base');
    });
    await flush();
    await flush();

    expect(input().value).toBe('Xenova/whisper-small.en');
  });

  it('does not write anything if blurred before the load lands', async () => {
    await setSettingValue('whisper.model', 'onnx-community/whisper-base');
    vi.mocked(setSettingValue).mockClear();
    const resolveLoad = deferGetSettingValue();

    render();
    await flush();

    // Blurs (with the field still at its unloaded, empty initial value)
    // before the pending load has resolved.
    await blurOnly(input());
    await flush();

    expect(setSettingValue).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad('onnx-community/whisper-base');
    });
    await flush();
    await flush();

    expect(input().value).toBe('onnx-community/whisper-base');
    expect(setSettingValue).not.toHaveBeenCalled();
  });
});
