/**
 * Phase 2 placeholder for P3: start a session (one note plus one recording,
 * started together), show its elapsed time and whether audio is recording, and
 * end it. The engine never touches the recorder, so this component calls
 * `engine.startSession()` and then the recorder, reporting an audio failure
 * without unwinding the session (A28: writing is never blocked).
 *
 * P3 replaces the body and keeps the name. The `aria-label` is the mount point
 * the app shell asserts on, so it stays too.
 */
export function SessionControls() {
  return (
    <span aria-label="Session" className="text-xs text-muted-foreground">
      Sessions arrive with P3
    </span>
  );
}
