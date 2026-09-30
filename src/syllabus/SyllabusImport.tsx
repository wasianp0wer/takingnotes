import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { pdfSupportProbe } from '@/syllabus/pdfjs';

/**
 * Phase 2 placeholder for P2: take a syllabus as a PDF or pasted text, extract
 * its assignment deadlines, and show them in an editable review table. Nothing
 * reaches the calendar until the user confirms (A25), and a re-import updates
 * matching events rather than duplicating them.
 *
 * It lives in the triage view because it feeds the calendar, whose events F3's
 * task sync already turns into tasks.
 *
 * Until then it carries one real affordance: "Check PDF support" opens an
 * in-memory PDF through the bundled pdf.js worker. That is deliberate - it is
 * what proves the worker is bundled locally and works offline (A29), here rather
 * than deep inside P2's extraction path.
 *
 * P2 replaces the body and keeps the name. The `aria-label` is the mount point
 * the triage view asserts on, so it stays too.
 */
export function SyllabusImport() {
  const [status, setStatus] = useState<string | null>(null);

  async function check() {
    setStatus('Checking…');
    try {
      const { version, pages } = await pdfSupportProbe();
      setStatus(`PDF support ready — pdf.js ${version} read ${pages} page.`);
    } catch (error: unknown) {
      setStatus(`PDF support failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <section aria-label="Syllabus" className="rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">Syllabus</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Importing a syllabus into assignment deadlines arrives with P2.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void check()}>
          Check PDF support
        </Button>
        {status !== null && <span className="text-xs text-muted-foreground">{status}</span>}
      </div>
    </section>
  );
}
