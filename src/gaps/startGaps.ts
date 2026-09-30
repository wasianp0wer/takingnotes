import { createGapAnalyzer, type GapAnalyzer } from '@/gaps/analyzer';
import { createOllamaTextGenerator } from '@/llm/ollamaText';
import { getSettingValue } from '@/storage/settingKeys';

/**
 * A gap analyzer wired to the app's settings: the same Ollama host and model as
 * page transcription (A30), and the user's lead/trail margins.
 *
 * Built per run rather than cached: gap analysis is an explicit action a user
 * takes occasionally, and picking up a settings change between two presses is
 * what they expect. Nothing here is exercised by a test - a test injects its own
 * `TextGenerator` instead, so no test can reach Ollama.
 */
export async function createConfiguredGapAnalyzer(): Promise<GapAnalyzer> {
  const [baseUrl, model, leadMs, trailMs] = await Promise.all([
    getSettingValue('ollama.baseUrl'),
    getSettingValue('ollama.model'),
    getSettingValue('gaps.leadMs'),
    getSettingValue('gaps.trailMs'),
  ]);
  return createGapAnalyzer({
    generator: createOllamaTextGenerator({ baseUrl }),
    model,
    leadMs,
    trailMs,
  });
}
