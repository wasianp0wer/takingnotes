import { Mic } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Phase 0 placeholder for F2's header control: start/stop recording, with the
 * elapsed time while it runs. At record start F2 reads `useCaptureState()` to
 * fill the recording's `sessionId` and `noteId`.
 */
export function RecorderControl() {
  return (
    <Button variant="outline" size="sm" disabled title="Arrives with F2">
      <Mic />
      Record
    </Button>
  );
}
