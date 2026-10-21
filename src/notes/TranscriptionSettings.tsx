import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  MIN_RENDER_LONG_EDGE,
  SETTING_DEFAULTS,
  getSettingValue,
  setSettingValue,
} from '@/storage/settingKeys';
import { listOllamaModels, type FetchLike } from '@/transcription/ollama';

/** A13: the address is reachable but the browser origin isn't allow-listed. */
const OLLAMA_HINT = 'Is Ollama running, and does OLLAMA_ORIGINS allow this page?';

/**
 * F1's settings section: the Ollama base URL, a vision model picked from
 * what's actually installed there (D2), and the page render resolution.
 * Defaults live in `src/storage/settingKeys.ts`. `fetchImpl` only exists so
 * tests can stub the Ollama HTTP calls - `SettingsDialog` mounts this with no
 * props, which uses the real `fetch`.
 */
export function TranscriptionSettings(props?: { fetchImpl?: FetchLike }) {
  // A ref, not a dependency: swapping this on every render would otherwise
  // re-trigger the mount effect below.
  const fetchImplRef = useRef(props?.fetchImpl);
  useEffect(() => {
    fetchImplRef.current = props?.fetchImpl;
  });

  const [baseUrl, setBaseUrl] = useState(SETTING_DEFAULTS['ollama.baseUrl']);
  const [model, setModel] = useState(SETTING_DEFAULTS['ollama.model']);
  const [renderSizeText, setRenderSizeText] = useState(
    String(SETTING_DEFAULTS['transcription.renderLongEdge']),
  );
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-armed on mount, not just cleared on unmount: StrictMode mounts, runs
  // cleanup, then mounts again on the same instance, so a flag that is only
  // ever cleared stays false for the life of the component and silently
  // discards every async result - which disables the model list entirely.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Guards a slow fetch for a URL the user has since changed away from
  // overwriting the result of a newer one.
  const requestSeqRef = useRef(0);

  const refreshModels = useCallback((url: string) => {
    const requestId = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    listOllamaModels(url, fetchImplRef.current)
      .then((names) => {
        if (!mountedRef.current || requestSeqRef.current !== requestId) return;
        setModels(names);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || requestSeqRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : String(err));
        setModels([]);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [url, savedModel, longEdge] = await Promise.all([
        getSettingValue('ollama.baseUrl'),
        getSettingValue('ollama.model'),
        getSettingValue('transcription.renderLongEdge'),
      ]);
      if (cancelled || !mountedRef.current) return;
      setBaseUrl(url);
      setModel(savedModel);
      setRenderSizeText(String(longEdge));
      refreshModels(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshModels]);

  function handleAddressBlur(event: React.FocusEvent<HTMLInputElement>) {
    const url = event.target.value;
    void setSettingValue('ollama.baseUrl', url);
    refreshModels(url);
  }

  function handleModelChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    setModel(next);
    void setSettingValue('ollama.model', next);
  }

  function handleRenderSizeBlur(event: React.FocusEvent<HTMLInputElement>) {
    const parsed = Number(event.target.value);
    const clamped = Number.isFinite(parsed)
      ? Math.max(MIN_RENDER_LONG_EDGE, Math.round(parsed))
      : SETTING_DEFAULTS['transcription.renderLongEdge'];
    setRenderSizeText(String(clamped));
    void setSettingValue('transcription.renderLongEdge', clamped);
  }

  // The saved model stays selectable even when it isn't one of the models
  // Ollama currently reports (uninstalled, or the list hasn't loaded yet).
  const modelOptions = model && !models.includes(model) ? [...models, model] : models;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Handwriting transcription</h3>

      <div className="space-y-1">
        <Label htmlFor="ollama-base-url">Ollama address</Label>
        <Input
          id="ollama-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          onBlur={handleAddressBlur}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="ollama-model">Model</Label>
        <div className="flex items-center gap-2">
          <select
            id="ollama-model"
            className="h-9 w-full min-w-0 rounded bg-muted px-3 py-2 text-sm outline-none"
            value={model}
            onChange={handleModelChange}
          >
            {modelOptions.map((name) => (
              <option key={name} value={name}>
                {models.includes(name) ? name : `${name} (not installed)`}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => refreshModels(baseUrl)}
          >
            Refresh
          </Button>
        </div>
        {loading && <p className="text-sm text-muted-foreground">Loading models…</p>}
        {error && (
          <p className="text-sm text-destructive">
            {error} {OLLAMA_HINT}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="ollama-render-long-edge">Render size (long edge, px)</Label>
        <Input
          id="ollama-render-long-edge"
          type="number"
          min={MIN_RENDER_LONG_EDGE}
          step={64}
          value={renderSizeText}
          onChange={(event) => setRenderSizeText(event.target.value)}
          onBlur={handleRenderSizeBlur}
        />
      </div>
    </section>
  );
}
