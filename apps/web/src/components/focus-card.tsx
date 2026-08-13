'use client';

/**
 * The one thing to do now.
 *
 * "Just start — 5 minutes" used to quietly add five minutes to a counter
 * nothing on screen displayed, so the biggest button on the page looked
 * broken. It now starts the real timer: the number moves, which is the
 * entire point. Initiation is the barrier, so the offer stays small — five
 * minutes, stop whenever — while what actually happens underneath is an
 * honest recording of however long the person really worked.
 *
 * Once past five minutes the copy changes to say the deal is met. That
 * matters: someone who agreed to five minutes and is still going at twenty
 * should be told they already won, not left feeling they signed up for
 * something open-ended.
 */
import { useEffect, useState, useTransition } from 'react';
import { startTaskTimer, stopTaskTimer } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { TimerIcon } from '@/components/icons';

const FIVE_MINUTES_MS = 5 * 60_000;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function FocusTimer({
  taskId,
  taskTitle,
  startedAt,
}: {
  taskId: string;
  taskTitle: string;
  startedAt: Date | null;
}) {
  const [pending, startTransition] = useTransition();
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt ? Date.now() - startedAt.getTime() : 0,
  );

  useEffect(() => {
    if (!startedAt) return;
    setElapsedMs(Date.now() - startedAt.getTime());
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt.getTime()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) {
    return (
      <button
        type="button"
        className="btn btn-primary w-full gap-2 sm:w-auto"
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
                ? `Started "${taskTitle}" (stopped "${result.switchedFrom}").`
                : `Started "${taskTitle}".`,
              'success',
            );
          });
        }}
      >
        {pending ? <span className="loading loading-dots loading-xs" /> : <TimerIcon />}
        Just start — 5 minutes
      </button>
    );
  }

  const pastTheDeal = elapsedMs >= FIVE_MINUTES_MS;

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="text-primary font-mono text-3xl font-bold tabular-nums"
          role="timer"
          aria-live="off"
        >
          {formatElapsed(elapsedMs)}
        </span>
        <button
          type="button"
          className="btn btn-error btn-soft btn-sm gap-2"
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
          {pending ? (
            <span className="loading loading-dots loading-xs" />
          ) : (
            <span className="bg-error inline-block size-2 animate-pulse rounded-full" aria-hidden="true" />
          )}
          Stop and log it
        </button>
      </div>

      <p className={`text-sm ${pastTheDeal ? 'text-success' : 'text-base-content/55'}`}>
        {pastTheDeal
          ? 'Five minutes done — you kept the deal. Carry on or stop, both count.'
          : 'Five minutes is the whole commitment. Stop whenever you like.'}
      </p>
    </div>
  );
}
