import { createOllamaTextGenerator } from '@/llm/ollamaText';
import type { SmartSearchDeps } from '@/search/smartSearch';
import { getSettingValue } from '@/storage/settingKeys';

/**
 * A smart-search generator wired to the app's settings - the same Ollama
 * host and model as everything else (A30/A36). Built per run, not cached,
 * so a settings change between two presses is picked up, following
 * `gaps/startGaps.ts`'s `createConfiguredGapAnalyzer`. Never called by a
 * test - a test injects its own `SmartSearchDeps` instead.
 */
export async function getSmartSearchDeps(): Promise<SmartSearchDeps> {
  const [baseUrl, model] = await Promise.all([
    getSettingValue('ollama.baseUrl'),
    getSettingValue('ollama.model'),
  ]);
  return { generator: createOllamaTextGenerator({ baseUrl }), model };
}
