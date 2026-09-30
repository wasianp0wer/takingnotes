/**
 * Phase 2 placeholder for P2: take a syllabus as a PDF or pasted text, extract
 * its assignment deadlines, and show them in an editable review table. Nothing
 * reaches the calendar until the user confirms (A25), and a re-import updates
 * matching events rather than duplicating them.
 *
 * It lives in the triage view because it feeds the calendar, whose events F3's
 * task sync already turns into tasks.
 *
 * P2 replaces the body and keeps the name. The `aria-label` is the mount point
 * the triage view asserts on, so it stays too.
 */
export function SyllabusImport() {
  return (
    <section aria-label="Syllabus" className="rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">Syllabus</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Importing a syllabus into assignment deadlines arrives with P2.
      </p>
    </section>
  );
}
