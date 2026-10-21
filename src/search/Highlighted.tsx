import { Fragment } from 'react';
import type { ReactNode } from 'react';

/** The snippet with each case-insensitive occurrence of `query` highlighted. */
export function Highlighted(props: { text: string; query: string }) {
  const { text, query } = props;
  const needle = query.trim().toLowerCase();
  if (needle === '') return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="bg-search-highlight text-inherit">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}
