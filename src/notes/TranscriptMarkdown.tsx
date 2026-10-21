import 'katex/dist/katex.min.css';

import type { ComponentProps, ElementType } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import Markdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * Renders a page transcript as Markdown with LaTeX maths (owner, 2026-10-20;
 * supersedes F1-A4's plain pre-wrapped text). Gemma writes `$…$` / `$$…$$`
 * maths - e.g. `$\rightarrow$` for an arrow - which KaTeX typesets. The stored
 * transcript is untouched, so search and gap analysis still read the raw text.
 *
 * - Raw HTML is never rendered (react-markdown's default, no rehype-raw): model
 *   output is untrusted.
 * - remark-breaks keeps single newlines, since a handwritten page's line breaks
 *   are part of what was written.
 * - Malformed LaTeX renders as KaTeX's inline error text rather than throwing.
 */
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBreaks];
const REHYPE_PLUGINS: Parameters<typeof Markdown>[0]['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
];

/**
 * An element with fixed classes. react-markdown passes its hast `node` as a prop;
 * it is dropped here so it never reaches the DOM.
 */
type StyledTag = 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'blockquote' | 'code' | 'pre' | 'table' | 'th' | 'td';

function styled<T extends StyledTag>(Tag: T, className: string) {
  return function Styled(props: ComponentProps<T> & ExtraProps) {
    const { node, ...rest } = props;
    void node;
    const Element = Tag as ElementType;
    return <Element className={className} {...rest} />;
  };
}

const COMPONENTS: Components = {
  h1: styled('h1', 'mb-2 mt-3 text-xl font-semibold text-heading first:mt-0'),
  h2: styled('h2', 'mb-2 mt-3 text-lg font-semibold text-heading first:mt-0'),
  h3: styled('h3', 'mb-1 mt-2 font-semibold text-heading first:mt-0'),
  p: styled('p', 'my-2 first:mt-0 last:mb-0'),
  ul: styled('ul', 'my-2 list-disc pl-6'),
  ol: styled('ol', 'my-2 list-decimal pl-6'),
  blockquote: styled('blockquote', 'my-2 border-l-2 border-border pl-3 text-muted-foreground'),
  code: styled('code', 'bg-muted px-1 font-mono text-sm'),
  pre: styled('pre', 'my-2 overflow-auto bg-muted p-2 font-mono text-sm'),
  table: styled('table', 'my-2 border-collapse text-sm'),
  th: styled('th', 'border border-border px-2 py-1 text-left font-semibold'),
  td: styled('td', 'border border-border px-2 py-1'),
  a(props) {
    const { node, ...rest } = props;
    void node;
    return <a className="text-link underline" target="_blank" rel="noreferrer" {...rest} />;
  },
};

export function TranscriptMarkdown({ markdown }: { markdown: string }) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {markdown}
    </Markdown>
  );
}
