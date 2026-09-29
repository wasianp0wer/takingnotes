import { useMemo } from 'react';

import { CalendarPanel } from '@/triage/CalendarPanel';
import { Scratchpad } from '@/triage/Scratchpad';
import { TaskList } from '@/triage/TaskList';
import { useNow } from '@/triage/useNow';
import { useScratchpad } from '@/triage/useScratchpad';
import { useTriageData } from '@/triage/useTriageData';

/**
 * F3's triage center: the task list (ranked by priority score, synced from
 * calendar deadlines), the calendar (month grid plus a 7-day agenda) and an
 * autosaved scratchpad whose lines can be promoted into tasks. On narrow
 * screens the three panels stack (tasks, then calendar, then scratchpad);
 * `lg` and up shows tasks beside a calendar+scratchpad column.
 */
export function TriageView() {
  const now = useNow();
  const data = useTriageData();
  const pad = useScratchpad();
  const openTasks = useMemo(() => data.tasks.filter((t) => t.status === 'open'), [data.tasks]);

  return (
    <div className="grid min-h-0 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {data.error && (
        <p role="alert" className="text-sm text-destructive lg:col-span-2">
          {data.error}
        </p>
      )}
      <section aria-label="Tasks" className="min-w-0 rounded-lg border border-border p-4">
        <TaskList
          tasks={openTasks}
          now={now}
          onAdd={data.addTask}
          onPatch={data.patchTask}
          onComplete={data.completeTask}
          onDismiss={data.dismissTask}
        />
      </section>
      <div className="flex min-w-0 flex-col gap-4">
        <section aria-label="Calendar" className="rounded-lg border border-border p-4">
          <CalendarPanel events={data.events} now={now} onSaveEvent={data.saveEvent} onDeleteEvent={data.removeEvent} />
        </section>
        <section aria-label="Scratchpad" className="rounded-lg border border-border p-4">
          <Scratchpad
            text={pad.text}
            loaded={pad.loaded}
            onChange={pad.setText}
            onPromote={(title) => data.addTask({ title, source: 'scratchpad' })}
          />
        </section>
      </div>
    </div>
  );
}
