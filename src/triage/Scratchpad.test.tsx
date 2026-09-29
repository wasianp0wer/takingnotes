import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Scratchpad } from '@/triage/Scratchpad';
import { click, mount, typeInto } from '@/triage/testing';

function noop() {}

function setCaret(el: HTMLTextAreaElement, pos: number): void {
  act(() => {
    el.setSelectionRange(pos, pos);
  });
}

describe('Scratchpad', () => {
  it('promoting the line under the caret calls onPromote with the stripped title and removes the line', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const text = 'first\n- second\nthird';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const textarea = m.container.querySelector('[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    setCaret(textarea, 8);

    const button = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Promote line to task')!;
    await click(button);

    expect(onPromote).toHaveBeenCalledWith('second');
    expect(onChange).toHaveBeenCalledWith('first\nthird');

    m.unmount();
  });

  it('promoting a blank line does not call onPromote and shows a status message', async () => {
    const onPromote = vi.fn();
    const onChange = vi.fn();
    const text = 'first\n\nthird';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const textarea = m.container.querySelector('[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    setCaret(textarea, 6);

    const button = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Promote line to task')!;
    await click(button);

    expect(onPromote).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    const status = m.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Put the cursor on a line with text.');

    m.unmount();
  });

  it('typing in the textarea calls onChange with the new value', () => {
    const onChange = vi.fn();
    const m = mount(<Scratchpad text="" loaded onChange={onChange} onPromote={noop} />);
    const textarea = m.container.querySelector('[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    typeInto(textarea, 'hello');
    expect(onChange).toHaveBeenCalledWith('hello');
    m.unmount();
  });

  it('shows the Scratchpad heading and the autosave hint', () => {
    const m = mount(<Scratchpad text="" loaded onChange={noop} onPromote={noop} />);
    expect(m.container.textContent).toContain('Scratchpad');
    expect(m.container.textContent).toContain('Saved automatically.');
    m.unmount();
  });

  it('disables the textarea until loaded', () => {
    const m = mount(<Scratchpad text="" loaded={false} onChange={noop} onPromote={noop} />);
    const textarea = m.container.querySelector('[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    m.unmount();
  });

  it('Mod+Enter in the textarea also promotes', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const text = '- buy milk';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const textarea = m.container.querySelector('[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    setCaret(textarea, 3);

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(onPromote).toHaveBeenCalledWith('buy milk');
    expect(onChange).toHaveBeenCalledWith('');

    m.unmount();
  });

  it('shows the success status after promoting', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const m = mount(<Scratchpad text="buy milk" loaded onChange={onChange} onPromote={onPromote} />);

    const textarea = m.container.querySelector('[aria-label="Scratchpad"]') as HTMLTextAreaElement;
    setCaret(textarea, 2);
    const button = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Promote line to task')!;
    await click(button);

    const status = m.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Added “buy milk” to tasks.');

    m.unmount();
  });
});
