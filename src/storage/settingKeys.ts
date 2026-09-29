import { getSetting, setSetting } from '@/storage/settings';

/**
 * Every key the app stores in the `settings` store, with its type. The
 * `settings` repository is untyped on purpose (it also holds bookkeeping like
 * `legacyMigratedAt`); this is the registry of keys the UI and the features
 * share, so a default lives in exactly one place.
 */
export interface SettingValues {
  /** F1: where Ollama listens. A13: it must accept the app's origin. */
  'ollama.baseUrl': string;
  /** F1: the vision model, picked from the user's installed models (D2). */
  'ollama.model': string;
  /** F1: long edge in px of a page render, floor `MIN_RENDER_LONG_EDGE`. */
  'transcription.renderLongEdge': number;
  /** F2: Whisper model id (A12: English-only default). */
  'whisper.model': string;
  /** F3: how many days ahead deadlines become tasks. */
  'triage.lookaheadDays': number;
  /** F3: the scratchpad is a single setting, not a store. */
  'triage.scratchpad': string;
}

export type SettingKey = keyof SettingValues;

export const SETTING_DEFAULTS: SettingValues = {
  'ollama.baseUrl': 'http://localhost:11434',
  'ollama.model': 'gemma4:12b',
  'transcription.renderLongEdge': 1024,
  'whisper.model': 'Xenova/whisper-base.en',
  'triage.lookaheadDays': 7,
  'triage.scratchpad': '',
};

/** Transcription findings F1-F4: below this the handwriting stops being legible. */
export const MIN_RENDER_LONG_EDGE = 768;

/**
 * Reads a known setting, falling back to its default. A stored value of the
 * wrong type is treated as absent: these keys outlive builds, and a string
 * where a number belongs would otherwise reach the rasterizer or the priority
 * formula as `NaN`.
 */
export async function getSettingValue<K extends SettingKey>(
  key: K,
): Promise<SettingValues[K]> {
  const fallback = SETTING_DEFAULTS[key];
  const stored = await getSetting<unknown>(key, fallback);
  const value = (typeof stored === typeof fallback ? stored : fallback) as SettingValues[K];

  if (key === 'transcription.renderLongEdge') {
    const px = value as number;
    return Math.max(px, MIN_RENDER_LONG_EDGE) as SettingValues[K];
  }
  return value;
}

export function setSettingValue<K extends SettingKey>(
  key: K,
  value: SettingValues[K],
): Promise<void> {
  return setSetting(key, value);
}
