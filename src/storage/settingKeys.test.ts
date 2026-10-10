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
      'triage.agendaDays': 7,
      'triage.scratchpad': '',
      'gaps.leadMs': 60_000,
      'gaps.trailMs': 30_000,
      'syllabus.termStart': null,
    });
  });

  it('falls back to the default when nothing is stored', async () => {
    expect(await getSettingValue('ollama.model')).toBe('gemma4:12b');
    expect(await getSettingValue('triage.lookaheadDays')).toBe(7);
    expect(await getSettingValue('triage.agendaDays')).toBe(7);
    expect(await getSettingValue('triage.scratchpad')).toBe('');
    expect(await getSettingValue('gaps.leadMs')).toBe(60_000);
    expect(await getSettingValue('gaps.trailMs')).toBe(30_000);
    expect(await getSettingValue('syllabus.termStart')).toBeNull();
  });

  it('round-trips triage.agendaDays, including the "All" sentinel (K23)', async () => {
    await setSettingValue('triage.agendaDays', 14);
    expect(await getSettingValue('triage.agendaDays')).toBe(14);

    // Infinity is the sentinel for the "All" preset; typeof Infinity is
    // 'number', same as the default, so it must round-trip with no special case.
    await setSettingValue('triage.agendaDays', Number.POSITIVE_INFINITY);
    expect(await getSettingValue('triage.agendaDays')).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not let a change to triage.agendaDays affect triage.lookaheadDays (K24)', async () => {
    // The two keys must stay fully independent: S2 must never read or write
    // triage.lookaheadDays.
    await setSettingValue('triage.agendaDays', 30);
    expect(await getSettingValue('triage.lookaheadDays')).toBe(7);
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
  it('round-trips a nullable key both ways', async () => {
    // `syllabus.termStart` defaults to null, so `typeof default` says nothing
    // about what a real value looks like - a stored number must still read back.
    await setSettingValue('syllabus.termStart', 1_757_000_000_000);
    expect(await getSettingValue('syllabus.termStart')).toBe(1_757_000_000_000);

    await setSettingValue('syllabus.termStart', null);
    expect(await getSettingValue('syllabus.termStart')).toBeNull();
  });

  it('ignores a nullable key stored with the wrong type', async () => {
    await setSetting('syllabus.termStart', 'September');
    expect(await getSettingValue('syllabus.termStart')).toBeNull();
  });

  it('ignores a gap margin stored with the wrong type', async () => {
    await setSetting('gaps.leadMs', '60s');
    expect(await getSettingValue('gaps.leadMs')).toBe(60_000);
  });
});
