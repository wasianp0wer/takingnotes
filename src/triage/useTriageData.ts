import { useCallback, useEffect, useRef, useState } from 'react';

import { createEvent, deleteEvent, listEvents, updateEvent } from '@/storage/events';
import { createTask, listTasks, updateTask } from '@/storage/tasks';
import type { CreateTaskInput } from '@/storage/tasks';
import type { CalendarEventRecord, TaskRecord } from '@/storage/types';
import type { EventFormValue } from '@/triage/eventForm';
import { syncTasksFromCalendar } from '@/triage/generateTasks';
import { completeTask as completeTaskAction, dismissTask as dismissTaskAction } from '@/triage/taskActions';

export type TaskPatch = Partial<Pick<TaskRecord, 'title' | 'required' | 'estimatedMinutes' | 'dueAt'>>;

export interface TriageData {
  /** Every status; views filter to 'open'. */
  tasks: TaskRecord[];
  /** Earliest first. */
  events: CalendarEventRecord[];
  loaded: boolean;
  error: string | null;
  refresh(): Promise<void>;
  saveEvent(value: EventFormValue, id?: string | null): Promise<void>;
  removeEvent(id: string): Promise<void>;
  /**
   * `opts.rethrow` lets one call site (Scratchpad's promote, which must tell
   * "committed" apart from "failed" so it never deletes text for a task that
   * was never saved) observe the failure; `error` is still set either way,
   * so every other caller's fire-and-forget behavior is unchanged.
   */
  addTask(input: CreateTaskInput, opts?: { rethrow?: boolean }): Promise<void>;
  patchTask(id: string, patch: TaskPatch): Promise<void>;
  completeTask(id: string): Promise<void>;
  dismissTask(id: string): Promise<void>;
}

/**
 * The task list and calendar, synced from the calendar's deadlines. Mount,
 * window focus, an interval and every mutation below all call `refresh`;
 * `syncTasksFromCalendar` itself is serialized (see generateTasks.ts), and a
 * request counter here plus a mounted guard mean only the latest refresh's
 * result is ever applied, so overlapping calls (StrictMode's double mount
 * included) can't apply a stale result over a fresher one.
 */
export function useTriageData(opts?: { syncIntervalMs?: number }): TriageData {
  const syncIntervalMs = opts?.syncIntervalMs ?? 60_000;

  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [events, setEvents] = useState<CalendarEventRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = (requestIdRef.current += 1);
    try {
      await syncTasksFromCalendar();
      const [nextTasks, nextEvents] = await Promise.all([listTasks(), listEvents()]);
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      setTasks(nextTasks);
      setEvents(nextEvents);
      setError(null);
      setLoaded(true);
    } catch (err) {
      console.error('[triage] refresh failed', err);
      if (requestId !== requestIdRef.current || !mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    const id = setInterval(() => void refresh(), syncIntervalMs);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('focus', onFocus);
      clearInterval(id);
    };
  }, [refresh, syncIntervalMs]);

  /**
   * Runs a single storage mutation, then refreshes. `action` failures (a
   * missing id, a closed database, ...) are caught here rather than left to
   * propagate: every mutator below is called straight from a click handler,
   * and an unhandled rejection there is worse than a surfaced `error`. By
   * default this never rethrows, so `void mutator(...)` is always safe;
   * `opts.rethrow` opts one call in, for the rare caller (Scratchpad's
   * promote) that must tell success from failure to avoid destroying data
   * on a failed write - `error` is still set in that case too.
   */
  const runMutation = useCallback(
    async (action: () => Promise<unknown>, opts?: { rethrow?: boolean }): Promise<void> => {
      try {
        await action();
      } catch (err) {
        console.error('[triage] mutation failed', err);
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
        if (opts?.rethrow) throw err;
        return;
      }
      await refresh();
    },
    [refresh],
  );

  const saveEvent = useCallback(
    (value: EventFormValue, id?: string | null): Promise<void> =>
      runMutation(() => (id ? updateEvent(id, value) : createEvent(value))),
    [runMutation],
  );

  const removeEvent = useCallback(
    (id: string): Promise<void> => runMutation(() => deleteEvent(id)),
    [runMutation],
  );

  const addTask = useCallback(
    (input: CreateTaskInput, opts?: { rethrow?: boolean }): Promise<void> =>
      runMutation(() => createTask(input), opts),
    [runMutation],
  );

  const patchTask = useCallback(
    (id: string, patch: TaskPatch): Promise<void> => runMutation(() => updateTask(id, patch)),
    [runMutation],
  );

  const completeTask = useCallback(
    (id: string): Promise<void> => runMutation(() => completeTaskAction(id)),
    [runMutation],
  );

  const dismissTask = useCallback(
    (id: string): Promise<void> => runMutation(() => dismissTaskAction(id)),
    [runMutation],
  );

  return {
    tasks,
    events,
    loaded,
    error,
    refresh,
    saveEvent,
    removeEvent,
    addTask,
    patchTask,
    completeTask,
    dismissTask,
  };
}
