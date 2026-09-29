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
  addTask(input: CreateTaskInput): Promise<void>;
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

  const saveEvent = useCallback(
    async (value: EventFormValue, id?: string | null): Promise<void> => {
      if (id) {
        await updateEvent(id, value);
      } else {
        await createEvent(value);
      }
      await refresh();
    },
    [refresh],
  );

  const removeEvent = useCallback(
    async (id: string): Promise<void> => {
      await deleteEvent(id);
      await refresh();
    },
    [refresh],
  );

  const addTask = useCallback(
    async (input: CreateTaskInput): Promise<void> => {
      await createTask(input);
      await refresh();
    },
    [refresh],
  );

  const patchTask = useCallback(
    async (id: string, patch: TaskPatch): Promise<void> => {
      await updateTask(id, patch);
      await refresh();
    },
    [refresh],
  );

  const completeTask = useCallback(
    async (id: string): Promise<void> => {
      await completeTaskAction(id);
      await refresh();
    },
    [refresh],
  );

  const dismissTask = useCallback(
    async (id: string): Promise<void> => {
      await dismissTaskAction(id);
      await refresh();
    },
    [refresh],
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
