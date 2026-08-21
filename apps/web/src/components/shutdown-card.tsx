'use client';

import { useState, useTransition } from 'react';
import { reopenDay, shutdownDay } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { formatDuration } from '@/components/format';
import { CheckIcon } from '@/components/icons';
import { Highlights, type HighlightGroup } from '@/components/highlights';

/**
 * The end of the workday, made explicit.
 *
 * Without a deliberate close, work has no edge: there is always one more thing
 * on the list, so "am I finished?" is a question the screen can never answer
 * and the honest answer is always no. This gives the day a door.
 *
 * The summary leads with what happened, not what did not. Unfinished work is
 * presented as a decision to take rather than a failure to explain — the
 * phrasing here is doing real work for someone who ends most days feeling
 * behind.
 */

export interface LooseTask {
  id: string;
  title: string;
}

export function ShutdownCard({
  day,
  completedCount,
  focusedMinutes,
  meetingMinutes,
  loose,
  shutdownAt,
  reflection,
  highlights,
}: {
  /** ISO date of the day being closed. */
  day: string;
  completedCount: number;
  focusedMinutes: number;
  meetingMinutes: number;
  loose: LooseTask[];
  shutdownAt: Date | null;
  reflection: string | null;
  highlights: { groups: HighlightGroup[]; totalMinutes: number; taskCount: number };
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  if (shutdownAt) {
    return (
      <section className="border-success/30 bg-success/6 mt-6 rounded-2xl border px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-success" aria-hidden="true">
            <CheckIcon />
          </span>
          <span className="font-semibold">Done for today.</span>
          <span className="text-base-content/55 text-sm">
            {completedCount} finished
            {focusedMinutes > 0 ? ` · ${formatDuration(focusedMinutes)} focused` : ''}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs ml-auto rounded-lg"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await reopenDay(day);
                logAction(result.error ?? 'Day reopened.', result.error ? 'error' : 'success');
              });
            }}
          >
            Not done after all
          </button>
        </div>
        {reflection ? (
          <p className="text-base-content/70 mt-2 whitespace-pre-line text-sm">{reflection}</p>
        ) : null}
      </section>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-outline mt-6 w-full rounded-2xl"
        onClick={() => setOpen(true)}
      >
        Finish the day
      </button>
    );
  }

  return (
    <section className="card bg-base-100 border-base-200 mt-6 border shadow-sm">
      <div className="card-body gap-4">
        <div>
          <h2 className="card-title text-base">Today&rsquo;s work</h2>
          {meetingMinutes > 0 ? (
            <p className="text-base-content/60 mt-1 text-sm">
              {formatDuration(meetingMinutes)} of today went to meetings.
            </p>
          ) : null}
        </div>

        {/*
          The highlights replace what used to be a one-line tally. "Seven tasks,
          five hours" is a number; the grouped version is something a person can
          actually recognise as their day, which is the difference between a
          ritual that sticks and one that gets skipped.
        */}
        <Highlights
          groups={highlights.groups}
          totalMinutes={highlights.totalMinutes}
          taskCount={highlights.taskCount}
        />

        {loose.length > 0 ? (
          <div>
            <p className="text-base-content/50 text-xs font-semibold uppercase tracking-[0.12em]">
              Still open
            </p>
            <ul className="mt-2 space-y-1.5">
              {loose.map((task) => (
                <li key={task.id} className="text-base-content/75 text-sm">
                  {task.title}
                </li>
              ))}
            </ul>
            {/*
              No per-task triage here on purpose. Asking someone to make five
              decisions at the moment they are trying to stop is how a
              two-minute ritual becomes one nobody performs. Re-planning
              tomorrow picks these up anyway.
            */}
            <p className="text-base-content/45 mt-2 text-xs">
              These stay on the list. Tomorrow&rsquo;s plan will find them a slot.
            </p>
          </div>
        ) : null}

        <label className="block">
          <span className="text-base-content/50 text-xs font-semibold uppercase tracking-[0.12em]">
            Anything worth remembering?
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Optional. Nobody reads this but you."
            className="textarea mt-1.5 w-full text-sm"
          />
        </label>

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await shutdownDay({ day, reflection: note });
                if (result.error) {
                  logAction(result.error, 'error');
                  return;
                }
                logAction('Day closed. See you tomorrow.', 'success');
                setOpen(false);
              });
            }}
          >
            {pending ? <span className="loading loading-dots loading-xs" /> : null}
            Done for today
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
            Not yet
          </button>
        </div>
      </div>
    </section>
  );
}
