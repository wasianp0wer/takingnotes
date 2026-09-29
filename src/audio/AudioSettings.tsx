/**
 * Phase 0 placeholder for F2's settings section: the Whisper model (A12: the
 * English-only `Xenova/whisper-base.en` by default). Defaults live in
 * `src/storage/settingKeys.ts`.
 */
export function AudioSettings() {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">Audio</h3>
      <p className="text-sm text-muted-foreground">
        Whisper model selection arrives with F2.
      </p>
    </section>
  );
}
