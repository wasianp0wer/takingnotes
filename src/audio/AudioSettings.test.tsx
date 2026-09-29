import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioSettings, WHISPER_MODEL_OPTIONS } from '@/audio/AudioSettings';
import { getSettingValue } from '@/storage/settingKeys';
import { resetDatabase } from '@/test/resetDb';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  await resetDatabase();
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

describe('AudioSettings', () => {
  it('shows the default whisper model', async () => {
    render();
    await flush();
    await flush();

    expect(input().value).toBe('Xenova/whisper-base.en');
  });

  it('persists a typed value on blur', async () => {
    render();
    await flush();

    await typeAndBlur(input(), 'onnx-community/whisper-base');
    await flush();

    expect(await getSettingValue('whisper.model')).toBe('onnx-community/whisper-base');
  });

  it('restores and saves the default when cleared', async () => {
    render();
    await flush();

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
});
