/**
 * Phase 0 placeholder for F1's settings section: Ollama base URL, the model
 * picked from the user's installed models (D2), and the render resolution.
 * Defaults live in `src/storage/settingKeys.ts`.
 */
export function TranscriptionSettings() {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">Handwriting transcription</h3>
      <p className="text-sm text-muted-foreground">
        Ollama address, model and page render resolution arrive with F1.
      </p>
    </section>
  );
}
