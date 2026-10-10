import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CreateTaskInput } from '@/storage/tasks';
import type { TaskRecord } from '@/storage/types';
import { cn } from '@/lib/utils';
import { endOfLocalDay, localDateTimeFromInputs } from '@/triage/dates';
import { parseEstimateMinutes } from '@/triage/estimate';
import { formatDue } from '@/triage/format';
import { rankTasks, scoreBand, type ScoreBand } from '@/triage/priority';
import type { TaskPatch } from '@/triage/useTriageData';

/** K22: the score's band gets a text colour; the chip's background stays neutral. */
const BAND_TEXT_CLASS: Record<ScoreBand, string> = {
  red: 'text-red-600',
  orange: 'text-orange-600',
  amber: 'text-amber-600',
  lime: 'text-lime-600',
  green: 'text-green-600',
};

export interface TaskListProps {
  /** Open tasks only; the caller (Task 8's TriageView) filters by status. */
  tasks: TaskRecord[];
  now: number;
  /**
   * Must **reject** if the write failed: the add form is the only copy of what
   * the user typed, so it clears its fields on success only. `TriageView`
   * supplies `useTriageData.addTask(..., { rethrow: true })` for exactly this.
   */
  onAdd(input: CreateTaskInput): Promise<void> | void;
  onPatch(id: string, patch: TaskPatch): Promise<void> | void;
  onComplete(id: string): Promise<void> | void;
  onDismiss(id: string): Promise<void> | void;
}

const SOURCE_HINT: Partial<Record<TaskRecord['source'], string>> = {
  calendar: 'From calendar',
  scratchpad: 'From scratchpad',
};

export function TaskList({ tasks, now, onAdd, onPatch, onComplete, onDismiss }: TaskListProps) {
  const ranked = rankTasks(tasks, now);

  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open tasks.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ranked.map(({ task, score }) => (
            <TaskRow
              key={task.id}
              task={task}
              score={score}
              now={now}
              onPatch={onPatch}
              onComplete={onComplete}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
      )}
      <AddTaskForm onAdd={onAdd} />
    </section>
  );
}

function TaskRow({
  task,
  score,
  now,
  onPatch,
  onComplete,
  onDismiss,
}: {
  task: TaskRecord;
  score: number;
  now: number;
  onPatch: TaskListProps['onPatch'];
  onComplete: TaskListProps['onComplete'];
  onDismiss: TaskListProps['onDismiss'];
}) {
  const [estimateText, setEstimateText] = useState(String(task.estimatedMinutes));
  // The stored value this text was last synced to. Adjusted during render
  // (React's documented pattern for deriving state from a changed prop)
  // rather than in an effect, so a save round-tripping through the parent
  // updates the field in the same render instead of a follow-up one - and
  // only when the stored value actually changed, so a re-render with the
  // same value never clobbers text the user is mid-edit on.
  const [syncedEstimate, setSyncedEstimate] = useState(task.estimatedMinutes);
  if (task.estimatedMinutes !== syncedEstimate) {
    setSyncedEstimate(task.estimatedMinutes);
    setEstimateText(String(task.estimatedMinutes));
  }

  const commitEstimate = () => {
    const n = Number(estimateText);
    if (Number.isFinite(n) && n >= 0) {
      const rounded = Math.round(n);
      if (rounded !== task.estimatedMinutes) {
        onPatch(task.id, { estimatedMinutes: rounded });
      } else {
        setEstimateText(String(task.estimatedMinutes));
      }
    } else {
      setEstimateText(String(task.estimatedMinutes));
    }
  };

  const onEstimateKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEstimate();
    }
  };

  const dueLabel = formatDue(task.dueAt, now);
  // From the data, not from `dueLabel`'s copy: styling must not break the day
  // someone rewords the label.
  const overdue = task.dueAt !== null && task.dueAt < now;
  const sourceHint = SOURCE_HINT[task.source];

  return (
    <li data-task-id={task.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
      <span
        data-testid="task-score"
        title="Priority score"
        className={cn('rounded-md bg-secondary px-1.5 text-xs tabular-nums', BAND_TEXT_CLASS[scoreBand(score)])}
      >
        {score}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
      {sourceHint ? <span className="text-xs text-muted-foreground">{sourceHint}</span> : null}
      <span className={cn('text-xs', overdue ? 'text-destructive' : 'text-muted-foreground')}>{dueLabel}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={task.required}
        aria-label="Required"
        onClick={() => onPatch(task.id, { required: !task.required })}
      >
        {task.required ? 'Required' : 'Optional'}
      </Button>
      <Input
        type="number"
        min={0}
        step={5}
        aria-label="Estimate (minutes)"
        value={estimateText}
        onChange={(e) => setEstimateText(e.target.value)}
        onBlur={commitEstimate}
        onKeyDown={onEstimateKeyDown}
        className="w-20"
      />
      <Button type="button" size="sm" variant="ghost" aria-label={`Done: ${task.title}`} onClick={() => onComplete(task.id)}>
        Done
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`Dismiss: ${task.title}`}
        onClick={() => onDismiss(task.id)}
      >
        Dismiss
      </Button>
    </li>
  );
}

function AddTaskForm({ onAdd }: { onAdd: TaskListProps['onAdd'] }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [estimate, setEstimate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const requiredRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (adding) return;

    const trimmedTitle = title.trim();
    if (trimmedTitle === '') {
      setError('Give the task a title.');
      return;
    }

    let dueAt: number | null = null;
    if (date !== '') {
      if (time === '') {
        const midnight = localDateTimeFromInputs(date, '');
        if (midnight === null) {
          setError('Pick a valid date.');
          return;
        }
        dueAt = endOfLocalDay(midnight);
      } else {
        const timed = localDateTimeFromInputs(date, time);
        if (timed === null) {
          setError('Pick a valid date.');
          return;
        }
        dueAt = timed;
      }
    }

    const estimatedMinutes = parseEstimateMinutes(estimate);
    if (estimatedMinutes === null) {
      setError('Estimate must be a number of minutes.');
      return;
    }

    const required = requiredRef.current?.checked ?? true;

    setError(null);
    setAdding(true);
    try {
      await onAdd({
        title: trimmedTitle,
        dueAt,
        required,
        estimatedMinutes,
        source: 'manual',
      });
    } catch (err) {
      // The task was never saved, so the form holds the only copy of this
      // input: keep every field and say so instead of clearing them.
      console.error('[triage] add task failed', err);
      setError("Couldn't add that task — your text is still here.");
      return;
    } finally {
      setAdding(false);
    }

    setTitle('');
    setDate('');
    setTime('');
    setEstimate('');
    if (requiredRef.current) requiredRef.current.checked = true;
  };

  return (
    <form aria-label="Add task" onSubmit={(e) => void handleSubmit(e)} className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Label htmlFor="task-list-new-title" className="sr-only">
        Task title
      </Label>
      <Input
        id="task-list-new-title"
        aria-label="Task title"
        placeholder="New task"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="min-w-0 flex-1"
      />
      <Input
        type="date"
        aria-label="Due date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="w-auto"
      />
      <Input
        type="time"
        aria-label="Due time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        className="w-auto"
      />
      <Label className="flex items-center gap-1 text-xs text-muted-foreground">
        <input ref={requiredRef} type="checkbox" aria-label="Required" defaultChecked />
        Required
      </Label>
      <Input
        type="number"
        aria-label="New task estimate (minutes)"
        placeholder="60"
        value={estimate}
        onChange={(e) => setEstimate(e.target.value)}
        className="w-20"
      />
      <Button type="submit" size="sm" disabled={adding}>
        Add
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
