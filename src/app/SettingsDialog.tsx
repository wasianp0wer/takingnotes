import { Settings } from 'lucide-react';

import { AudioSettings } from '@/audio/AudioSettings';
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Everything runs locally: transcription talks to Ollama on this machine and
            Whisper runs in the browser.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ThemeSettings />
          <Separator />
          <TranscriptionSettings />
          <Separator />
          <AudioSettings />
        </div>
      </DialogContent>
    </Dialog>
  );
}
