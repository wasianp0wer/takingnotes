import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Scratchpad } from '@/triage/Scratchpad';
import { lineAtCursor, removeLine } from '@/triage/scratchpadLines';
import { click, flush, mount, typeInto } from '@/triage/testing';

function noop() {}

function setCaret(el: HTMLTextAreaElement, pos: number): void {
  act(() => {
    el.setSelectionRange(pos, pos);
  });
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('textarea[aria-label="Scratchpad"]') as HTMLTextAreaElement;
}

function promoteButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === 'Promote line to task')!;
}

describe('Scratchpad', () => {
  it('promoting the line under the caret calls onPromote with the stripped title, removes the line, and restores focus with the caret where the line was', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const text = 'first\n- second\nthird';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const ta = textarea(m.container);
    setCaret(ta, 8);

    await click(promoteButton(m.container));

    expect(onPromote).toHaveBeenCalledWith('second');
    // Derived from the real `removeLine`/`lineAtCursor` behavior (not a
    // hand-guessed offset), so this stays correct if that pure logic changes.
    const range = lineAtCursor(text, 8);
    const { text: expectedText, cursor: expectedCursor } = removeLine(text, range);
    expect(onChange).toHaveBeenCalledWith(expectedText);

    // The caller (TriageView/useScratchpad) round-trips `onChange`'s value
    // back in as `text`; simulate that to exercise the caret-restore effect.
    m.render(<Scratchpad text={expectedText} loaded onChange={onChange} onPromote={onPromote} />);

    expect(document.activeElement).toBe(ta);
    expect(ta.selectionStart).toBe(expectedCursor);
    expect(ta.selectionEnd).toBe(expectedCursor);

    m.unmount();
  });

  it('promoting a blank line does not call onPromote and shows a status message', async () => {
    const onPromote = vi.fn();
    const onChange = vi.fn();
    const text = 'first\n\nthird';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const ta = textarea(m.container);
    setCaret(ta, 6);

    await click(promoteButton(m.container));

    expect(onPromote).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    const status = m.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Put the cursor on a line with text.');

    m.unmount();
  });

  it('typing in the textarea calls onChange with the new value', () => {
    const onChange = vi.fn();
    const m = mount(<Scratchpad text="" loaded onChange={onChange} onPromote={noop} />);
    typeInto(textarea(m.container), 'hello');
    expect(onChange).toHaveBeenCalledWith('hello');
    m.unmount();
  });

  it('typing clears a previous status message', async () => {
    const onPromote = vi.fn();
    const onChange = vi.fn();
    const m = mount(<Scratchpad text="" loaded onChange={onChange} onPromote={onPromote} />);

    await click(promoteButton(m.container));
    expect(m.container.querySelector('[role="status"]')?.textContent).toBe('Put the cursor on a line with text.');

    typeInto(textarea(m.container), 'hello');
    expect(m.container.querySelector('[role="status"]')).toBeNull();

    m.unmount();
  });

  it('shows the Scratchpad heading and the autosave hint', () => {
    const m = mount(<Scratchpad text="" loaded onChange={noop} onPromote={noop} />);
    expect(m.container.textContent).toContain('Scratchpad');
    expect(m.container.textContent).toContain('Saved automatically.');
    m.unmount();
  });

  it('replaces the autosave hint with a save error when the caller reports one', () => {
    const m = mount(
      <Scratchpad text="unsaved work" loaded error="Couldn't save it." onChange={noop} onPromote={noop} />,
    );
    // The hint must not keep claiming a save that did not happen.
    expect(m.container.textContent).not.toContain('Saved automatically.');
    expect(m.container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save it.");
    m.unmount();
  });

  it('disables the textarea until loaded', () => {
    const m = mount(<Scratchpad text="" loaded={false} onChange={noop} onPromote={noop} />);
    expect(textarea(m.container).disabled).toBe(true);
    m.unmount();
  });

  it('Mod+Enter (Ctrl) in the textarea also promotes', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const text = '- buy milk';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const ta = textarea(m.container);
    setCaret(ta, 3);

    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    });

    expect(onPromote).toHaveBeenCalledWith('buy milk');
    expect(onChange).toHaveBeenCalledWith('');

    m.unmount();
  });

  it('Mod+Enter (Cmd/Meta) in the textarea also promotes', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const text = '- buy milk';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    const ta = textarea(m.container);
    setCaret(ta, 3);

    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    });

    expect(onPromote).toHaveBeenCalledWith('buy milk');
    expect(onChange).toHaveBeenCalledWith('');

    m.unmount();
  });

  it('shows the success status after promoting', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const m = mount(<Scratchpad text="buy milk" loaded onChange={onChange} onPromote={onPromote} />);

    setCaret(textarea(m.container), 2);
    await click(promoteButton(m.container));

    const status = m.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Added “buy milk” to tasks.');

    m.unmount();
  });

  it('a rejecting onPromote keeps the text, shows a recoverable status, and never produces an unhandled rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onPromote = vi.fn().mockRejectedValue(new Error('storage full'));
    const onChange = vi.fn();
    const text = 'first\n- second\nthird';
    const m = mount(<Scratchpad text={text} loaded onChange={onChange} onPromote={onPromote} />);

    setCaret(textarea(m.container), 8);

    let unhandled = false;
    const onUnhandledRejection = () => {
      unhandled = true;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    await click(promoteButton(m.container));
    await flush();

    expect(onPromote).toHaveBeenCalledWith('second');
    // The line must survive: it was never actually saved.
    expect(onChange).not.toHaveBeenCalled();
    const status = m.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Couldn't add that task — your text is still here.");
    expect(unhandled).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('[triage] promote failed', expect.any(Error));

    process.off('unhandledRejection', onUnhandledRejection);
    consoleError.mockRestore();
    m.unmount();
  });

  it('does not lose text typed elsewhere in the pad while the promote is still in flight', async () => {
    let resolvePromote: (() => void) | undefined;
    const onPromote = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePromote = resolve;
        }),
    );
    const onChange = vi.fn();
    const initialText = 'first\n- second\nthird';
    const m = mount(<Scratchpad text={initialText} loaded onChange={onChange} onPromote={onPromote} />);

    setCaret(textarea(m.container), 8);
    await click(promoteButton(m.container));
    expect(onPromote).toHaveBeenCalledWith('second');

    // Simulate the round trip through the parent: more text lands on the pad
    // (e.g. the user kept typing) while the save is still pending.
    const updatedText = 'first\n- second\nthird\nfourth';
    m.render(<Scratchpad text={updatedText} loaded onChange={onChange} onPromote={onPromote} />);

    resolvePromote?.();
    await flush();

    // The removed line must come out of the latest text (including
    // "fourth"), not the stale snapshot captured when Promote was clicked.
    expect(onChange).toHaveBeenCalledWith('first\nthird\nfourth');

    m.unmount();
  });

  it('does not steal focus back if something else was focused while the promote was in flight', async () => {
    const onPromote = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const m = mount(<Scratchpad text="buy milk" loaded onChange={onChange} onPromote={onPromote} />);

    setCaret(textarea(m.container), 2);

    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();

    await click(promoteButton(m.container));
    m.render(<Scratchpad text="" loaded onChange={onChange} onPromote={onPromote} />);

    expect(document.activeElement).toBe(other);

    other.remove();
    m.unmount();
  });
});
