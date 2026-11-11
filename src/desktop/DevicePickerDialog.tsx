import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getDesktopBridge,
  type ChooserDevice,
  type ChooserKind,
  type ChooserMessage,
  type DesktopBridge,
} from '@/desktop/bridge';

const TITLES: Record<ChooserKind, string> = {
  bluetooth: 'Choose a tablet',
  hid: 'Choose a USB device',
};

const DESCRIPTIONS: Record<ChooserKind, string> = {
  bluetooth: 'Tablets in range appear here as they are found. Make sure yours is switched on.',
  hid: 'USB devices connected to this computer.',
};

interface PickerRequest {
  requestId: string;
  kind: ChooserKind;
  devices: ChooserDevice[];
}

export interface DevicePickerDialogProps {
  /** Defaults to the desktop bridge; null (the web build) renders nothing. */
  bridge?: DesktopBridge | null;
}

/**
 * The desktop shell's device picker (spec §5). Electron has no chooser of its
 * own, so `navigator.bluetooth.requestDevice()` / `navigator.hid.requestDevice()`
 * wait until this dialog answers over the bridge.
 *
 * Mount it once, at the app root, for the document's whole life: an `open`
 * that arrives while it is not subscribed is lost, and that `requestDevice()`
 * never settles. In the browser there is no bridge and the browser's own picker
 * is used, so this renders nothing.
 */
export function DevicePickerDialog({ bridge }: DevicePickerDialogProps) {
  const resolved = bridge === undefined ? getDesktopBridge() : bridge;
  const [request, setRequest] = useState<PickerRequest | null>(null);
  /** The request still owed an answer. Cleared by the first answer, so each is answered once. */
  const unansweredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!resolved) return;
    return resolved.devices.onChooser((msg: ChooserMessage) => {
      switch (msg.type) {
        case 'open':
          unansweredRef.current = msg.requestId;
          setRequest({ requestId: msg.requestId, kind: msg.kind, devices: msg.devices });
          break;
        case 'update':
          setRequest((current) =>
            current && current.requestId === msg.requestId ? { ...current, devices: msg.devices } : current,
          );
          break;
        case 'close':
          // Main has already settled it (picked, cancelled or superseded): nothing to send.
          if (unansweredRef.current === msg.requestId) unansweredRef.current = null;
          setRequest((current) => (current && current.requestId === msg.requestId ? null : current));
          break;
      }
    });
  }, [resolved]);

  if (!resolved) return null;

  /** Claims the right to answer `requestId`; false if it was already answered or closed. */
  const claim = (requestId: string): boolean => {
    if (unansweredRef.current !== requestId) return false;
    unansweredRef.current = null;
    return true;
  };

  const choose = (requestId: string, deviceId: string) => {
    if (claim(requestId)) resolved.devices.select(requestId, deviceId);
    setRequest(null);
  };

  // Escape, an outside click and the Cancel button (a DialogClose) all land here.
  const onOpenChange = (open: boolean) => {
    if (open || !request) return;
    if (claim(request.requestId)) resolved.devices.cancel(request.requestId);
    setRequest(null);
  };

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      {request && (
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{TITLES[request.kind]}</DialogTitle>
            <DialogDescription>{DESCRIPTIONS[request.kind]}</DialogDescription>
          </DialogHeader>
          {request.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Searching…
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-auto" aria-label="Devices">
              {request.devices.map((device) => (
                <li key={device.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => choose(request.requestId, device.id)}
                  >
                    {device.name || 'Unnamed device'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
