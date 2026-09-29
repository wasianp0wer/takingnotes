import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { EventFormState, EventFormValue } from '@/triage/eventForm';
import { eventValueFromForm } from '@/triage/eventForm';

export interface EventDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  initial: EventFormState;
  /** null → creating. */
  eventId: string | null;
  /**
   * Must **reject** if the write failed, so the dialog can stay open and keep
   * the user's typed values instead of closing over a lost save. `TriageView`
   * supplies `useTriageData.saveEvent(..., { rethrow: true })` for that.
   */
  onSave(value: EventFormValue): Promise<void>;
  onDelete?(): Promise<void>;
}

/**
 * Create/edit/delete dialog for a calendar event. The parent (CalendarPanel)
 * remounts this with a fresh `key` every time it opens, so `initial` only
 * needs to seed `useState` - no effect is needed to resync it.
 */
export function EventDialog({ open, onOpenChange, initial, eventId, onSave, onDelete }: EventDialogProps) {
  const [form, setForm] = useState<EventFormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isEditing = eventId !== null;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = eventValueFromForm(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(result.value);
      onOpenChange(false);
    } catch (err) {
      // Nothing was written, and this form is the only copy of the title,
      // date, notes and estimate the user typed: stay open, say why, and let
      // them retry rather than closing and throwing the lot away.
      console.error('[triage] event save failed', err);
      setError("Couldn't save this event — your changes are still here.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setSaving(true);
    try {
      await onDelete();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit event' : 'New event'}</DialogTitle>
          <DialogDescription>
            {isEditing ? 'Update this event.' : 'Add a deadline or event to the calendar.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="event-dialog-title">Title</Label>
            <Input
              id="event-dialog-title"
              aria-label="Title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="event-dialog-kind">Kind</Label>
            <Select
              value={form.kind}
              onValueChange={(value) => setForm((f) => ({ ...f, kind: value as EventFormState['kind'] }))}
            >
              <SelectTrigger id="event-dialog-kind" aria-label="Kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deadline">Deadline — becomes a task</SelectItem>
                <SelectItem value="event">Event</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="event-dialog-date">Date</Label>
              <Input
                id="event-dialog-date"
                type="date"
                aria-label="Date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className="w-auto"
              />
            </div>
            <Label className="flex items-center gap-1 pb-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label="All day"
                checked={form.allDay}
                onChange={(e) => setForm((f) => ({ ...f, allDay: e.target.checked }))}
              />
              All day
            </Label>
            {!form.allDay ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="event-dialog-time">Time</Label>
                <Input
                  id="event-dialog-time"
                  type="time"
                  aria-label="Time"
                  value={form.time}
                  onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                  className="w-auto"
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Label className="flex items-center gap-1 pb-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label="Required"
                checked={form.required}
                onChange={(e) => setForm((f) => ({ ...f, required: e.target.checked }))}
              />
              Required
            </Label>
            <div className="flex flex-col gap-1">
              <Label htmlFor="event-dialog-estimate">Estimate (minutes)</Label>
              <Input
                id="event-dialog-estimate"
                type="number"
                aria-label="Estimate (minutes)"
                value={form.estimatedMinutes}
                onChange={(e) => setForm((f) => ({ ...f, estimatedMinutes: e.target.value }))}
                className="w-24"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Defaults for the generated task</p>

          <div className="flex flex-col gap-1">
            <Label htmlFor="event-dialog-notes">Notes</Label>
            <textarea
              id="event-dialog-notes"
              aria-label="Notes"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className={cn(
                'min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none',
                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              )}
            />
          </div>

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {isEditing && onDelete ? (
              <Button type="button" variant="destructive" disabled={saving} onClick={() => void handleDelete()}>
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
