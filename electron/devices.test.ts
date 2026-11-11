import { describe, expect, it, vi } from 'vitest';
import { createDeviceChooser } from './devices';
import type { ChooserDevice, ChooserMessage } from './types';

const huion: ChooserDevice = { id: 'aa:bb', name: 'Huion Note X10' };
const wacom: ChooserDevice = { id: 'cc:dd', name: 'Wacom Intuos' };

function setup() {
  const sent: ChooserMessage[] = [];
  const chooser = createDeviceChooser((msg) => sent.push(msg));
  return { sent, chooser };
}

function openedId(sent: ChooserMessage[], index = 0): string {
  const opens = sent.filter((m) => m.type === 'open');
  return opens[index].requestId;
}

describe('createDeviceChooser', () => {
  it('opens on first bluetooth event, updates on later ones', () => {
    const { sent, chooser } = setup();
    const callback = vi.fn();
    chooser.offer('bluetooth', [], callback);
    chooser.offer('bluetooth', [huion], callback);
    chooser.offer('bluetooth', [huion, wacom], callback);

    const requestId = openedId(sent);
    expect(sent).toEqual([
      { type: 'open', requestId, kind: 'bluetooth', devices: [] },
      { type: 'update', requestId, devices: [huion] },
      { type: 'update', requestId, devices: [huion, wacom] },
    ]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('select calls back with the device id', () => {
    const { sent, chooser } = setup();
    const callback = vi.fn();
    chooser.open('hid', [huion, wacom], callback);
    const requestId = openedId(sent);

    chooser.select(requestId, wacom.id);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(wacom.id);
    expect(sent.at(-1)).toEqual({ type: 'close', requestId });
    expect(chooser.pendingKind()).toBeNull();
  });

  it('select uses the newest callback Electron handed over', () => {
    const { sent, chooser } = setup();
    const first = vi.fn();
    const latest = vi.fn();
    chooser.offer('bluetooth', [], first);
    chooser.offer('bluetooth', [huion], latest);
    chooser.select(openedId(sent), huion.id);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(huion.id);
  });

  it('ignores a select for a device that was never listed', () => {
    const { sent, chooser } = setup();
    const callback = vi.fn();
    chooser.open('bluetooth', [huion], callback);
    chooser.select(openedId(sent), 'not-a-device');
    expect(callback).not.toHaveBeenCalled();
    expect(chooser.pendingKind()).toBe('bluetooth');
  });

  it('cancel then re-request', () => {
    const { sent, chooser } = setup();
    const first = vi.fn();
    chooser.offer('bluetooth', [huion], first);
    const firstId = openedId(sent);

    chooser.cancel(firstId);
    expect(first).toHaveBeenCalledWith('');
    expect(sent.at(-1)).toEqual({ type: 'close', requestId: firstId });

    const second = vi.fn();
    chooser.offer('bluetooth', [wacom], second);
    const secondId = openedId(sent, 1);
    expect(secondId).not.toBe(firstId);
    expect(sent.at(-1)).toEqual({ type: 'open', requestId: secondId, kind: 'bluetooth', devices: [wacom] });

    chooser.select(secondId, wacom.id);
    expect(second).toHaveBeenCalledWith(wacom.id);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('new open cancels a pending one', () => {
    const { sent, chooser } = setup();
    const oldCallback = vi.fn();
    chooser.open('bluetooth', [huion], oldCallback);
    const oldId = openedId(sent);

    const newCallback = vi.fn();
    chooser.open('hid', [wacom], newCallback);
    const newId = openedId(sent, 1);

    expect(oldCallback).toHaveBeenCalledWith('');
    expect(sent).toEqual([
      { type: 'open', requestId: oldId, kind: 'bluetooth', devices: [huion] },
      { type: 'close', requestId: oldId },
      { type: 'open', requestId: newId, kind: 'hid', devices: [wacom] },
    ]);
    expect(newCallback).not.toHaveBeenCalled();
    expect(chooser.pendingKind()).toBe('hid');
  });

  it('a bluetooth event while a hid chooser is open starts a new request', () => {
    const { sent, chooser } = setup();
    const hidCallback = vi.fn();
    chooser.open('hid', [wacom], hidCallback);
    chooser.offer('bluetooth', [huion], vi.fn());
    expect(hidCallback).toHaveBeenCalledWith('');
    expect(sent.at(-1)).toMatchObject({ type: 'open', kind: 'bluetooth' });
  });

  it('ignores select and cancel for a stale request id', () => {
    const { sent, chooser } = setup();
    const callback = vi.fn();
    chooser.open('bluetooth', [huion], callback);
    const requestId = openedId(sent);
    chooser.select(requestId, huion.id);

    chooser.cancel(requestId);
    chooser.select(requestId, huion.id);
    chooser.cancel('never-issued');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.type === 'close')).toHaveLength(1);
  });

  it('update with nothing pending sends nothing', () => {
    const { sent, chooser } = setup();
    chooser.update([huion]);
    expect(sent).toEqual([]);
  });

  it('cancelPending cancels whatever is open, and is a no-op otherwise', () => {
    const { sent, chooser } = setup();
    chooser.cancelPending();
    expect(sent).toEqual([]);
    const callback = vi.fn();
    chooser.open('hid', [huion], callback);
    chooser.cancelPending();
    expect(callback).toHaveBeenCalledWith('');
    expect(sent.at(-1)).toEqual({ type: 'close', requestId: openedId(sent) });
  });

  it('copies device lists so later mutation by the caller does not leak', () => {
    const { sent, chooser } = setup();
    const list = [huion];
    chooser.open('bluetooth', list, vi.fn());
    list.push(wacom);
    expect(sent[0]).toMatchObject({ devices: [huion] });
  });
});
