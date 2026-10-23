import type { GapKind, GapSuggestionRecord } from '@/storage/types';

/** Readable labels for `GapKind`, shared with the tests that assert against them. */
export const GAP_KIND_LABELS: Record<GapKind, string> = {
  claim: 'Claim',
  definition: 'Definition',
  'name-or-date': 'Name or date',
  example: 'Example',
  'argument-step': 'Argument step',
  other: 'Other',
};

/** A single suggestion's text, kind badge and verbatim speech. */
export function SuggestionQuote({ suggestion }: { suggestion: GapSuggestionRecord }) {
  return (
    <>
      <p className="text-sm">{suggestion.text}</p>
      <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
        {GAP_KIND_LABELS[suggestion.kind]}
      </span>
      {suggestion.summarized && (
        // A per-item marker, not the full lossy-source sentence (that only
        // belongs on the panel's status line, and only for the analysis that
        // actually produced it).
        <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Summarized
        </span>
      )}
      <blockquote aria-label="From the recording" className="mt-1 border-l-2 pl-2 text-sm italic text-muted-foreground">
        {suggestion.sourceQuote}
      </blockquote>
    </>
  );
}
