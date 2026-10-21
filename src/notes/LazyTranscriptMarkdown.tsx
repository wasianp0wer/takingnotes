import { lazy, Suspense } from 'react';

/**
 * `TranscriptMarkdown` pulls in react-markdown, its plugins and KaTeX (about
 * 440 kB), so it loads on first use rather than in the app's startup bundle.
 * Until it arrives the transcript shows as plain pre-wrapped text, which is
 * what it is underneath.
 */
const TranscriptMarkdown = lazy(() =>
  import('@/notes/TranscriptMarkdown').then((m) => ({ default: m.TranscriptMarkdown })),
);

export function LazyTranscriptMarkdown({ markdown }: { markdown: string }) {
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{markdown}</span>}>
      <TranscriptMarkdown markdown={markdown} />
    </Suspense>
  );
}
