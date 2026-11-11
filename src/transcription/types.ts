/** What a transcriber returns for one page. Stored with the page transcript. */
export interface TranscriptionResult {
  markdown: string;
  model: string;
  promptVersion: string;
}

/**
 * Architecture §3.2: turns a rendered page image into Markdown. `firstPage`
 * says whether this is the first page of its note: the prompt makes that
 * page's first underlined line the session title (H1) and every other
 * underlined line a section heading (H2).
 */
export interface PageTranscriber {
  transcribePage(
    image: Blob,
    opts: { model: string; firstPage: boolean; signal?: AbortSignal },
  ): Promise<TranscriptionResult>;
}
