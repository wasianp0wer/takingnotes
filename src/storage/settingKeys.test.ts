import { beforeEach, describe, expect, it } from 'vitest';

import {
  getSettingValue,
  MIN_RENDER_LONG_EDGE,
  SETTING_DEFAULTS,
  setSettingValue,
} from '@/storage/settingKeys';
import { setSetting } from '@/storage/settings';
import { resetDatabase } from '@/test/resetDb';

beforeEach(resetDatabase);

describe('setting keys', () => {
  it('documents one default per key', () => {
    expect(SETTING_DEFAULTS).toEqual({
      'ollama.baseUrl': 'http://localhost:11434',
      'ollama.model': 'gemma4:12b',
      'transcription.renderLongEdge': 1024,
      'whisper.model': 'Xenova/whisper-base.en',
      'triage.lookaheadDays': 7,
      'triage.scratchpad': '',
    });
  });

  it('falls back to the default when nothing is stored', async () => {
    expect(await getSettingValue('ollama.model')).toBe('gemma4:12b');
    expect(await getSettingValue('triage.lookaheadDays')).toBe(7);
    expect(await getSettingValue('triage.scratchpad')).toBe('');
  });

  it('round-trips a stored value', async () => {
    await setSettingValue('ollama.baseUrl', 'http://127.0.0.1:11434');
    expect(await getSettingValue('ollama.baseUrl')).toBe('http://127.0.0.1:11434');
  });

  it('raises a render resolution below the floor', async () => {
    // Findings F1-F4: below 768 px the handwriting stops being legible to the
    // model, so a stored value under the floor is not honoured whatever wrote it.
    await setSetting('transcription.renderLongEdge', 320);
    expect(await getSettingValue('transcription.renderLongEdge')).toBe(MIN_RENDER_LONG_EDGE);

    await setSettingValue('transcription.renderLongEdge', 2048);
    expect(await getSettingValue('transcription.renderLongEdge')).toBe(2048);
  });

  it('ignores a stored value of the wrong type', async () => {
    // Anything could have written this key in an earlier build; a string where a
    // number belongs must not reach the rasterizer.
    await setSetting('transcription.renderLongEdge', 'big');
    expect(await getSettingValue('transcription.renderLongEdge')).toBe(1024);
  });
});
