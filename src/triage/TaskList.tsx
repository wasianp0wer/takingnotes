import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CreateTaskInput } from '@/storage/tasks';
import type { TaskRecord } from '@/storage/types';
import { cn } from '@/lib/utils';
import { endOfLocalDay, localDateTimeFromInputs, toDateInputValue, toTimeInputValue } from '@/triage/dates';
import { parseEstimateMinutes } from '@/triage/estimate';
import { formatDue } from '@/triage/format';
import { rankTasks, scoreBand, type ScoreBand } from '@/triage/priority';
import type { TaskPatch } from '@/triage/useTriageData';

/** K22: the score's band gets a text colour; the chip's background stays neutral. */
const BAND_TEXT_CLASS: Record<ScoreBand, string> = {
  red: 'text-score-red',
  orange: 'text-score-orange',
  amber: 'text-score-amber',
  lime: 'text-score-lime',
  green: 'text-score-green',
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
  /**
   * Must **reject** if the write failed: the inline title and date editors
   * stay open on a rejection. `TriageView` passes `patchTask` with
   * `{ rethrow: true }`.
   */
  onPatch(id: string, patch: TaskPatch): Promise<void> | void;
  /** Ids of calendar events imported from a syllabus; their deadlines cannot be cleared. */
  syllabusEventIds?: ReadonlySet<string>;
  onComplete(id: string): Promise<void> | void;
  onDismiss(id: string): Promise<void> | void;
}

/**
 * Where a task came from, when that is worth saying. Read from the linked
 * event, not `source`: every dated typed task is calendar-linked to its own
 * manual deadline, and calling that "From calendar" would be wrong.
 */
function sourceHintFor(
  task: Pick<TaskRecord, 'source' | 'eventId'>,
  syllabusEventIds: ReadonlySet<string> | undefined,
): string | null {
  if (task.source === 'scratchpad') return 'From scratchpad';
  if (task.eventId !== null && syllabusEventIds?.has(task.eventId)) return 'From syllabus';
  return null;
}

export function TaskList({
  tasks,
  now,
  onAdd,
  onPatch,
  syllabusEventIds,
  onComplete,
  onDismiss,
}: TaskListProps) {
  const ranked = rankTasks(tasks, now);

  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="text-sm font-semibold text-heading">Tasks</h2>
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
              syllabusEventIds={syllabusEventIds}
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
  syllabusEventIds,
  onComplete,
  onDismiss,
}: {
  task: TaskRecord;
  score: number;
  now: number;
  onPatch: TaskListProps['onPatch'];
  syllabusEventIds: TaskListProps['syllabusEventIds'];
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
        fireAndForget(onPatch(task.id, { estimatedMinutes: rounded }));
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

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState(task.title);
  const [editingDue, setEditingDue] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set once the title editor has been settled (saved or cancelled), so the
  // blur that follows - or that a browser fires as Escape unmounts the focused
  // input - cannot save stale text or submit twice.
  const titleSettledRef = useRef(false);

  const closeEditors = () => {
    setEditingTitle(false);
    setEditingDue(false);
    setEditError(null);
  };

  /** Runs a save; on rejection the editor stays open, holding the only copy of the input. */
  const save = async (patch: TaskPatch) => {
    if (saving) return;
    setSaving(true);
    try {
      await onPatch(task.id, patch);
    } catch (err) {
      console.error('[triage] edit task failed', err);
      titleSettledRef.current = false;
      setEditError("Couldn't save that change — your text is still here.");
      return;
    } finally {
      setSaving(false);
    }
    closeEditors();
  };

  const startTitleEdit = () => {
    titleSettledRef.current = false;
    setTitleText(task.title);
    setEditError(null);
    setEditingTitle(true);
  };

  const commitTitle = () => {
    if (titleSettledRef.current) return;
    titleSettledRef.current = true;
    const trimmed = titleText.trim();
    if (trimmed === '' || trimmed === task.title) {
      closeEditors();
      return;
    }
    void save({ title: trimmed });
  };

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      titleSettledRef.current = true;
      closeEditors();
    }
  };

  const startDueEdit = () => {
    if (task.dueAt === null) {
      setDueDate('');
      setDueTime('');
    } else {
      setDueDate(toDateInputValue(task.dueAt));
      // An end-of-day deadline is how "no time" is stored; show it as blank.
      setDueTime(task.dueAt === endOfLocalDay(task.dueAt) ? '' : toTimeInputValue(task.dueAt));
    }
    setEditError(null);
    setEditingDue(true);
  };

  const commitDue = () => {
    const dueAt = dueAtFromInputs(dueDate, dueTime);
    if (dueAt === 'invalid' || dueAt === null) {
      setEditError('Pick a valid date.');
      return;
    }
    void save({ dueAt });
  };

  const onDueKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDue();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeEditors();
    }
  };

  const canClearDue =
    task.dueAt !== null && !(task.eventId !== null && syllabusEventIds?.has(task.eventId));

  const dueLabel = formatDue(task.dueAt, now);
  // From the data, not from `dueLabel`'s copy: styling must not break the day
  // someone rewords the label.
  const overdue = task.dueAt !== null && task.dueAt < now;
  const sourceHint = sourceHintFor(task, syllabusEventIds);

  return (
    <li data-task-id={task.id} className="flex flex-wrap items-center gap-2 bg-muted p-2">
      <span
        data-testid="task-score"
        title="Priority score"
        className={cn('bg-secondary px-1.5 text-xs tabular-nums', BAND_TEXT_CLASS[scoreBand(score)])}
      >
        {score}
      </span>
      {editingTitle ? (
        <Input
          autoFocus
          aria-label="Task title"
          value={titleText}
          onChange={(e) => setTitleText(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={onTitleKeyDown}
          className="min-w-0 flex-1"
        />
      ) : (
        <button
          type="button"
          data-testid="task-title"
          title="Edit title"
          onClick={startTitleEdit}
          className="min-w-0 flex-1 truncate text-left text-sm hover:outline hover:outline-1 hover:outline-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {task.title}
        </button>
      )}
      {sourceHint ? <span className="text-xs text-muted-foreground">{sourceHint}</span> : null}
      {editingDue ? (
        <>
          <Input
            autoFocus
            type="date"
            aria-label="Due date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            onKeyDown={onDueKeyDown}
            className="w-auto"
          />
          <Input
            type="time"
            aria-label="Due time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            onKeyDown={onDueKeyDown}
            className="w-auto"
          />
          <Button type="button" size="sm" disabled={saving} aria-label="Save due date" onClick={commitDue}>
            Save
          </Button>
          {canClearDue ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              aria-label="Clear due date"
              onClick={() => void save({ dueAt: null })}
            >
              Clear
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" aria-label="Cancel due date" onClick={closeEditors}>
            Cancel
          </Button>
        </>
      ) : task.dueAt === null ? (
        <Button type="button" size="sm" variant="ghost" aria-label="Add due date" onClick={startDueEdit}>
          Add due date
        </Button>
      ) : (
        <button
          type="button"
          data-testid="task-due"
          title="Edit due date"
          onClick={startDueEdit}
          className={cn(
            'text-xs hover:outline hover:outline-1 hover:outline-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            overdue ? 'text-destructive' : 'text-date',
          )}
        >
          {dueLabel}
        </button>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={task.required}
        aria-label="Required"
        onClick={() => fireAndForget(onPatch(task.id, { required: !task.required }))}
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
      {editError ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {editError}
        </p>
      ) : null}
    </li>
  );
}

/** Swallows a rejected patch: for edits that have no error UI of their own (`patchTask` records it). */
function fireAndForget(result: Promise<void> | void): void {
  void Promise.resolve(result).catch(() => {});
}

/**
 * The due time a date/time input pair means: `null` for no date, the end of
 * the day when only a date is given, else that moment; `'invalid'` if either
 * input does not parse.
 */
function dueAtFromInputs(date: string, time: string): number | null | 'invalid' {
  if (date === '') return null;
  const parsed = localDateTimeFromInputs(date, time);
  if (parsed === null) return 'invalid';
  return time === '' ? endOfLocalDay(parsed) : parsed;
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

    const dueAt = dueAtFromInputs(date, time);
    if (dueAt === 'invalid') {
      setError('Pick a valid date.');
      return;
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
    <form aria-label="Add task" onSubmit={(e) => void handleSubmit(e)} className="flex flex-wrap items-center gap-2 pt-3">
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
