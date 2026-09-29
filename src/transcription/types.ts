/** What a transcriber returns for one page. Stored with the page transcript. */
export interface TranscriptionResult {
  markdown: string;
  model: string;
  promptVersion: string;
}

/** Architecture §3.2: turns a rendered page image into Markdown. */
export interface PageTranscriber {
  transcribePage(
    image: Blob,
    opts: { model: string; signal?: AbortSignal },
  ): Promise<TranscriptionResult>;
}
