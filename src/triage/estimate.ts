import { DEFAULT_ESTIMATE_MINUTES } from '@/triage/priority';

/**
 * Reads the minutes out of an estimate text field, the same way for the
 * add-task form and the event dialog: blank means the default, anything else
 * must be a non-negative finite number and is rounded to whole minutes.
 * `null` means "not a usable estimate" - the caller shows its own error.
 */
export function parseEstimateMinutes(text: string): number | null {
  const trimmed = text.trim();
  const minutes = trimmed === '' ? DEFAULT_ESTIMATE_MINUTES : Number(trimmed);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return Math.round(minutes);
}
