import { listOllamaModels, type FetchLike } from '@/llm/ollamaClient';

export type OllamaSetup =
  | { state: 'ready' }
  | { state: 'unreachable' }
  | { state: 'blocked' }
  | { state: 'unreachable-or-blocked' }
  | { state: 'model-missing'; model: string };

export interface CheckOllamaSetupOptions {
  baseUrl: string;
  model: string;
  fetch?: FetchLike;
  /** Asks the desktop bridge whether Ollama answers outside the renderer's CORS rules. */
  probeReachable?: (baseUrl: string) => Promise<boolean>;
}

const hasTag = (name: string): boolean => name.includes(':');

/** Checks that Ollama answers, then that the chosen model is installed. */
export async function checkOllamaSetup(opts: CheckOllamaSetupOptions): Promise<OllamaSetup> {
  let names: string[];
  try {
    names = await listOllamaModels(opts.baseUrl, opts.fetch);
  } catch {
    if (!opts.probeReachable) return { state: 'unreachable-or-blocked' };
    let reachable = false;
    try {
      reachable = await opts.probeReachable(opts.baseUrl);
    } catch {
      reachable = false;
    }
    return { state: reachable ? 'blocked' : 'unreachable' };
  }
  const wanted = hasTag(opts.model) ? opts.model : `${opts.model}:latest`;
  if (names.includes(opts.model) || names.includes(wanted)) return { state: 'ready' };
  return { state: 'model-missing', model: opts.model };
}
