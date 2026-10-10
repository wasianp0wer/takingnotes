import type { TaskRecord } from '@/storage/types';

/** A14: an unset estimate counts as an hour. */
export const DEFAULT_ESTIMATE_MINUTES = 60;
/** A14: undated tasks sit below anything with a real deadline. */
export const NO_DUE_DATE_URGENCY = 0.1;

const HOUR_MS = 3_600_000;

export type PriorityInput = Pick<TaskRecord, 'required' | 'estimatedMinutes' | 'dueAt'>;

export function effectiveEstimateMinutes(minutes: number): number {
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_ESTIMATE_MINUTES;
}

/**
 * Spec I7, exactly. Slack is the time left once the work itself is done; the
 * less of it, the more urgent. Once slack is negative the task is effectively
 * late and gets a boost that grows over a day and caps at 2.
 */
export function priorityScore(task: PriorityInput, now: number): number {
  let urgency = NO_DUE_DATE_URGENCY;
  if (task.dueAt !== null && task.dueAt !== undefined) {
    const h = (task.dueAt - now) / HOUR_MS;
    const d = effectiveEstimateMinutes(task.estimatedMinutes) / 60;
    const slack = h - d;
    urgency = slack >= 0 ? 1 / (1 + slack / 24) : 1 + Math.min(-slack / 24, 1);
  }
  const weight = task.required ? 1.0 : 0.5;
  return Math.round(100 * weight * urgency);
}

export type ScoreBand = 'red' | 'orange' | 'amber' | 'lime' | 'green';

/**
 * K22: colour bands on the *printed* score, absolute thresholds (not
 * urgency-only). Scores run 0-200 (urgency to 2.0, weight 1.0 required / 0.5
 * optional), so an optional task's score is capped at 100 and can reach
 * amber/lime/green but never orange or red, however overdue - a deliberate
 * choice: colour answers "how much does this matter right now", the weighted
 * question, not "how urgent is this on its own".
 */
export function scoreBand(score: number): ScoreBand {
  if (score >= 140) return 'red';
  if (score >= 100) return 'orange';
  if (score >= 60) return 'amber';
  if (score >= 30) return 'lime';
  return 'green';
}

export interface RankedTask {
  task: TaskRecord;
  score: number;
}

/** A total order, so the list never reshuffles between renders with equal scores. */
export function rankTasks(tasks: readonly TaskRecord[], now: number): RankedTask[] {
  return tasks
    .map((task) => ({ task, score: priorityScore(task, now) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ad = a.task.dueAt ?? Number.POSITIVE_INFINITY;
      const bd = b.task.dueAt ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad < bd ? -1 : 1;
      if (a.task.createdAt !== b.task.createdAt) return a.task.createdAt - b.task.createdAt;
      return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
    });
}
