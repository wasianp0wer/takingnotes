import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TranscriptMarkdown } from './TranscriptMarkdown';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(markdown: string): void {
  act(() => {
    root.render(<TranscriptMarkdown markdown={markdown} />);
  });
}

describe('TranscriptMarkdown', () => {
  it('typesets inline LaTeX maths such as $\\rightarrow$ instead of showing the source', () => {
    render('cause $\\rightarrow$ effect');
    expect(container.querySelector('.katex')).not.toBeNull();
    // KaTeX renders the arrow glyph; the dollar-delimited source is gone.
    expect(container.textContent).toContain('→');
    expect(container.textContent).not.toContain('$\\rightarrow$');
  });

  it('typesets display maths in a $$ block', () => {
    render('$$\n\\frac{a}{b}\n$$');
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('typesets $$…$$ written on one line too (as inline maths)', () => {
    render('so $$\\frac{a}{b}$$ here');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toContain('$$');
  });

  it('renders Markdown structure: headings, lists and emphasis', () => {
    render('# Reconstruction\n\n- Freedmen\n  - Bureau\n\n**1865**');
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('Reconstruction');
    expect(h1?.className).toContain('text-heading');
    expect(container.querySelectorAll('ul').length).toBe(2);
    expect(container.querySelector('strong')?.textContent).toBe('1865');
  });

  it('keeps single line breaks from the page as line breaks', () => {
    render('first line\nsecond line');
    expect(container.querySelector('br')).not.toBeNull();
  });

  it('renders GFM tables', () => {
    render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(container.querySelector('table td')?.textContent).toBe('1');
  });

  it('never renders raw HTML from the model', () => {
    render('<script>alert(1)</script><b>bold</b>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('does not throw on malformed LaTeX', () => {
    expect(() => render('broken $\\frac{a$ maths')).not.toThrow();
    expect(container.textContent).toContain('broken');
  });
});
