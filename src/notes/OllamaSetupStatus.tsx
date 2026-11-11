import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getDesktopBridge } from '@/desktop/bridge';
import type { FetchLike } from '@/llm/ollamaClient';
import { checkOllamaSetup, type OllamaSetup } from '@/llm/ollamaSetup';
import { getSettingValue } from '@/storage/settingKeys';

export interface OllamaSetupStatusProps {
  /** Renders nothing once Ollama is ready (used under a failed transcript). */
  compact?: boolean;
  /**
   * Tells "not running" from "running but refusing this origin". Defaults to
   * the desktop bridge's main-process probe; the web build has none, so it
   * shows both possibilities.
   */
  probeReachable?: (baseUrl: string) => Promise<boolean>;
  /** Test seam for the Ollama HTTP calls. */
  fetchImpl?: FetchLike;
}

/** The desktop shell's probe, bound to its bridge; undefined in the web build. */
function desktopProbe(): ((baseUrl: string) => Promise<boolean>) | undefined {
  const bridge = getDesktopBridge();
  return bridge ? (baseUrl) => bridge.probeOllama(baseUrl) : undefined;
}

export function OllamaSetupStatus({ compact, probeReachable = desktopProbe(), fetchImpl }: OllamaSetupStatusProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [result, setResult] = useState<OllamaSetup | null>(null);
  const [checking, setChecking] = useState(false);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const propsRef = useRef({ probeReachable, fetchImpl });
  useEffect(() => {
    propsRef.current = { probeReachable, fetchImpl };
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const id = ++seqRef.current;
    setChecking(true);
    const [url, model] = await Promise.all([getSettingValue('ollama.baseUrl'), getSettingValue('ollama.model')]);
    const next = await checkOllamaSetup({
      baseUrl: url,
      model,
      fetch: propsRef.current.fetchImpl,
      probeReachable: propsRef.current.probeReachable,
    });
    if (!mountedRef.current || seqRef.current !== id) return;
    setBaseUrl(url);
    setResult(next);
    setChecking(false);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  if (!result) return null;
  if (compact && result.state === 'ready') return null;

  const unreachable = (
    <p>
      Ollama isn&apos;t running at {baseUrl}. Install it from https://ollama.com and open it, then check again.
    </p>
  );
  const blocked = (
    <p>
      Ollama is running but refused this app&apos;s requests. Set OLLAMA_ORIGINS to include this app&apos;s address,
      then restart Ollama.
    </p>
  );

  return (
    <div className="space-y-2 text-sm">
      {result.state === 'ready' && <p className="text-muted-foreground">Ollama ready</p>}
      {result.state === 'unreachable' && unreachable}
      {result.state === 'blocked' && blocked}
      {result.state === 'unreachable-or-blocked' && (
        <>
          {unreachable}
          {blocked}
        </>
      )}
      {result.state === 'model-missing' && (
        <>
          <p>The model {result.model} isn&apos;t installed.</p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1">ollama pull {result.model}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(`ollama pull ${result.model}`)}
            >
              Copy
            </Button>
          </div>
        </>
      )}
      <Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => void run()}>
        Check again
      </Button>
    </div>
  );
}
