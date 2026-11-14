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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TranscriptionSettings } from '@/notes/TranscriptionSettings';
import { ThemeSettings } from '@/themes/ThemeSettings';

const TABS = [
  { value: 'theme', label: 'Theme', Section: ThemeSettings },
  { value: 'transcription', label: 'Transcription', Section: TranscriptionSettings },
  { value: 'audio', label: 'Audio', Section: AudioSettings },
  { value: 'backup', label: 'Backup', Section: BackupSettings },
];

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
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Everything runs locally: transcription talks to Ollama on this machine and
            Whisper runs in the browser.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          defaultValue="theme"
          orientation="vertical"
          className="min-h-0 flex-row gap-6"
        >
          <TabsList className="h-fit w-40 shrink-0 flex-col items-stretch">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="justify-start">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div data-settings-body className="-mr-6 min-h-0 min-w-0 flex-1 overflow-y-auto pr-6">
            {TABS.map(({ value, Section }) => (
              <TabsContent key={value} value={value}>
                <Section />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
