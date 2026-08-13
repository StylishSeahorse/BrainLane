'use client';

/**
 * A real running timer, not the five-minute nudge.
 *
 * "Just start" (on Today) exists to lower initiation friction — a target
 * small enough that beginning feels easy. This is a different job: once
 * something is actually underway, someone needs to see time passing and log
 * what genuinely happened, not a flat guess. `timerStartedAt` lives on the
 * task row in the database, not in this component's state, so it survives a
 * reload, a tab close, or switching to a different page and back.
 */
import { useEffect, useState, useTransition } from 'react';
import { startTaskTimer, stopTaskTimer } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { TimerIcon } from '@/components/icons';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function TaskTimer({
  taskId,
  taskTitle,
  startedAt,
}: {
  taskId: string;
  taskTitle: string;
  /** Null when no timer is running against this task. */
  startedAt: Date | null;
}) {
  const [pending, startTransition] = useTransition();
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt ? Date.now() - startedAt.getTime() : 0,
  );

  // Re-synced to the real start time whenever it changes — after a revalidate
  // following a start/stop elsewhere, this is what keeps the display honest
  // rather than counting from whatever it happened to be showing before.
  useEffect(() => {
    if (!startedAt) return;
    setElapsedMs(Date.now() - startedAt.getTime());
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt.getTime()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt) {
    return (
      <button
        type="button"
        className="btn btn-error btn-soft btn-xs gap-1.5 rounded-lg font-mono tabular-nums"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const result = await stopTaskTimer(taskId);
            if (result.error) {
              logAction(result.error, 'error');
              return;
            }
            const minutes = result.minutes ?? 0;
            logAction(
              `Logged ${minutes} minute${minutes === 1 ? '' : 's'} on "${taskTitle}".`,
              'success',
            );
          });
        }}
      >
        <span className="bg-error inline-block size-1.5 animate-pulse rounded-full" aria-hidden="true" />
        {formatElapsed(elapsedMs)} · Stop
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-outline btn-xs gap-1.5 rounded-lg"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const result = await startTaskTimer(taskId);
          if (result.error) {
            logAction(result.error, 'error');
            return;
          }
          logAction(
            result.switchedFrom
              ? `Started timing "${taskTitle}" (stopped "${result.switchedFrom}").`
              : `Started timing "${taskTitle}".`,
            'success',
          );
        });
      }}
    >
      <TimerIcon />
      Start timer
    </button>
  );
}
