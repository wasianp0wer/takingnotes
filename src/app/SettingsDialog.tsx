import { Settings } from 'lucide-react';

import { AudioSettings } from '@/audio/AudioSettings';
import { BackupSettings } from '@/backup/BackupSettings';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { TranscriptionSettings } from '@/notes/TranscriptionSettings';
import { ThemeSettings } from '@/themes/ThemeSettings';

/**
 * The single settings surface. Each feature owns one section component and
 * mounts it here, so no feature has to touch the dialog itself.
 */
export function SettingsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      {/* Capped to the viewport; the header stays put and the sections scroll
          beneath it, so the dialog never runs off screen. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Everything runs locally: transcription talks to Ollama on this machine and
            Whisper runs in the browser.
          </DialogDescription>
        </DialogHeader>
        <div data-settings-body className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6">
          <ThemeSettings />
          <Separator />
          <TranscriptionSettings />
          <Separator />
          <AudioSettings />
          <Separator />
          <BackupSettings />
        </div>
      </DialogContent>
    </Dialog>
  );
}
