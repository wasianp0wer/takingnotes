import { useEffect, useState } from 'react';

/** A ticking clock for priority scores and countdowns; re-renders every `intervalMs`. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
