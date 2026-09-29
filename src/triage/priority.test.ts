import { describe, expect, it } from 'vitest';

import type { TaskRecord } from '@/storage/types';
import { effectiveEstimateMinutes, priorityScore, rankTasks } from '@/triage/priority';

const NOW = new Date(2026, 8, 28, 9).getTime();
const HOUR = 3_600_000;

const score = (required: boolean, hoursUntilDue: number | null, estimateHours: number) =>
  priorityScore(
    {
      required,
      dueAt: hoursUntilDue === null ? null : NOW + hoursUntilDue * HOUR,
      estimatedMinutes: estimateHours * 60,
    },
    NOW,
  );

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    title: overrides.id,
    required: true,
    estimatedMinutes: 60,
    dueAt: null,
    status: 'open',
    source: 'manual',
    eventId: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

describe('priorityScore - spec reference values (I7)', () => {
  it('required, due in 48 h, 2 h estimate → 34', () => expect(score(true, 48, 2)).toBe(34));
  it('required, due in 12 h, 8 h estimate → 86', () => expect(score(true, 12, 8)).toBe(86));
  it('optional, due in 12 h, 1 h estimate → 34', () => expect(score(false, 12, 1)).toBe(34));
  it('required, due in 2 h, 4 h estimate → 108', () => expect(score(true, 2, 4)).toBe(108));
});

describe('priorityScore - boundaries', () => {
  it('zero slack is full urgency', () => {
    expect(score(true, 3, 3)).toBe(100);
    expect(score(false, 3, 3)).toBe(50);
  });
  it('slack of exactly -24 h doubles the score', () => expect(score(true, 1, 25)).toBe(200));
  it('the overdue boost is capped at 2', () => {
    expect(score(true, -47, 1)).toBe(200);
    expect(score(true, -1000, 0)).toBe(200);
    expect(score(false, -1000, 0)).toBe(100);
  });
  it('slack of -23 h is just under the cap', () => expect(score(true, 1, 24)).toBe(196));
  it('an overdue task with no estimate still gets the boost', () =>
    expect(score(true, -12, 0)).toBe(150));
  it('no due date means urgency 0.1', () => {
    expect(score(true, null, 1)).toBe(10);
    expect(score(false, null, 1)).toBe(5);
  });
});

describe('estimates', () => {
  it('falls back to 60 minutes for unusable estimates', () => {
    expect(effectiveEstimateMinutes(Number.NaN)).toBe(60);
    expect(effectiveEstimateMinutes(-5)).toBe(60);
    expect(effectiveEstimateMinutes(Number.POSITIVE_INFINITY)).toBe(60);
    expect(effectiveEstimateMinutes(0)).toBe(0);
    expect(effectiveEstimateMinutes(90)).toBe(90);
  });
  it('scores a NaN estimate like a 60-minute one', () => {
    const t = { required: true, dueAt: NOW + 48 * HOUR };
    expect(priorityScore({ ...t, estimatedMinutes: Number.NaN }, NOW)).toBe(
      priorityScore({ ...t, estimatedMinutes: 60 }, NOW),
    );
  });
});

describe('rankTasks', () => {
  it('sorts by score, then due date (none last), then createdAt, then id', () => {
    const tasks = [
      task({ id: 'no-due-old', createdAt: 1 }),
      task({ id: 'urgent', dueAt: NOW + 2 * HOUR }),
      task({ id: 'tie-later-due', dueAt: NOW + 49 * HOUR, estimatedMinutes: 180 }),
      task({ id: 'tie-earlier-due', dueAt: NOW + 48 * HOUR, estimatedMinutes: 120 }),
      task({ id: 'no-due-b', createdAt: 2 }),
      task({ id: 'no-due-a', createdAt: 2 }),
    ];
    const ranked = rankTasks(tasks, NOW);
    expect(ranked.map((r) => r.task.id)).toEqual([
      'urgent',
      'tie-earlier-due',
      'tie-later-due',
      'no-due-old',
      'no-due-a',
      'no-due-b',
    ]);
    expect(ranked[1].score).toBe(ranked[2].score);
    expect(tasks[0].id).toBe('no-due-old'); // input untouched
  });
});
