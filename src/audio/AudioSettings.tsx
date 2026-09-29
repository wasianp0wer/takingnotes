import { useEffect, useRef, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getSettingValue, setSettingValue, SETTING_DEFAULTS } from '@/storage/settingKeys';

/** Offered in the datalist beside the free-text model id input. */
export const WHISPER_MODEL_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'Xenova/whisper-tiny.en', label: 'Tiny, English, fastest' },
  { id: 'Xenova/whisper-base.en', label: 'Base, English, default' },
  { id: 'Xenova/whisper-small.en', label: 'Small, English, most accurate, slow' },
  { id: 'onnx-community/whisper-base', label: 'Base, multilingual' },
];

const SAVED_FLASH_MS = 1500;

/**
 * F2's settings section: the Whisper model id (A12: the English-only
 * `Xenova/whisper-base.en` by default). Saves on blur/Enter rather than every
 * keystroke - the value only matters at the start of the next transcription.
 */
export function AudioSettings() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const mountedRef = useRef(true);
  // Whether the initial `getSettingValue` read has landed yet. The DB's
  // first open runs migrations and is not instant, so a blur can easily
  // happen before it does.
  const loadedRef = useRef(false);
  // Whether the user has started editing. A load that lands after that must
  // not clobber their in-progress edit.
  const dirtyRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    void getSettingValue('whisper.model').then((stored) => {
      if (!mountedRef.current) return;
      loadedRef.current = true;
      if (!dirtyRef.current) setValue(stored);
    });
    return () => {
      mountedRef.current = false;
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  function commit() {
    // Nothing has been read from storage yet: saving now would persist the
    // input's current (possibly still-default/empty) value over whatever
    // model is actually stored, once the pending load lands.
    if (!loadedRef.current) return;
    const trimmed = value.trim();
    const next = trimmed || SETTING_DEFAULTS['whisper.model'];
    setValue(next);
    void setSettingValue('whisper.model', next).then(() => {
      if (!mountedRef.current) return;
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => {
        if (mountedRef.current) setSaved(false);
      }, SAVED_FLASH_MS);
    });
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Audio</h3>
      <div className="space-y-1">
        <Label htmlFor="whisper-model">Whisper model</Label>
        <Input
          id="whisper-model"
          list="whisper-models"
          value={value}
          onChange={(event) => {
            dirtyRef.current = true;
            setValue(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
        <datalist id="whisper-models">
          {WHISPER_MODEL_OPTIONS.map((option) => (
            <option key={option.id} value={option.id} label={option.label} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          Downloaded once, then cached by the browser. Applies to the next transcription.
        </p>
        {saved && (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        )}
      </div>
    </section>
  );
}
