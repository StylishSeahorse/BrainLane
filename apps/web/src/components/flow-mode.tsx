'use client';

/**
 * Doing mode.
 *
 * Planning and doing want opposite interfaces, so this is the one screen in
 * the app that shows almost nothing: the thing you are on, and the thing after
 * it. Everything that helps you decide is a distraction once you have decided.
 *
 * The times are projected, not planned. When a task runs long the rest of the
 * day is recomputed from the clock rather than left showing hours that stopped
 * being true twenty minutes ago — a schedule that silently disagrees with the
 * room is one people stop believing, and the whole value here is being
 * believable enough to lean on.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { projectFlow, totalDrift, type FlowItem } from '@fluid/core';
import { BreakPrompt } from '@/components/break-prompt';
import { FocusTimer } from '@/components/focus-card';
import { formatDuration, formatTime } from '@/components/format';
import { LoggedActionButton } from '@/components/action-log';
import { completeTask, uncompleteTask } from '@/app/actions';
import { CheckIcon } from '@/components/icons';

export interface FlowEntry {
  id: string;
  taskId: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  isMeeting: boolean;
  isDone: boolean;
  startedAt: Date | null;
  starterStep: string | null;
  projectName: string | null;
}

export function FlowMode({
  entries,
  bufferMinutes,
  timeZone,
  rhythm,
}: {
  entries: FlowEntry[];
  bufferMinutes: number;
  timeZone: string;
  rhythm: { enabled: boolean; workMinutes: number; breakMinutes: number };
}) {
  // The clock is the input this screen is about, so it has to tick. A minute
  // is the right grain: seconds would re-render constantly to move nothing a
  // person can read, and anything slower lets "now" visibly drift.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Until the first client tick, render from the planned times. Deriving the
  // projection from a server-side clock would produce different markup on
  // each side of hydration and React would discard the whole tree.
  const reference = now ?? entries.find((entry) => !entry.isDone)?.startsAt ?? new Date(0);

  const items: FlowItem[] = entries.map((entry) => ({
    id: entry.id,
    plannedStart: entry.startsAt,
    plannedEnd: entry.endsAt,
    isFixed: entry.isMeeting,
    isDone: entry.isDone,
    startedAt: entry.startedAt,
  }));

  const projected = projectFlow(items, { now: reference, bufferMinutes });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const drift = totalDrift(projected);

  const upcoming = projected.filter((item) => !item.isDone);
  const current = upcoming.find((item) => item.isCurrent) ?? upcoming[0];
  const rest = upcoming.filter((item) => item.id !== current?.id);
  const currentEntry = current ? byId.get(current.id) : undefined;

  const doneCount = entries.filter((entry) => entry.isDone).length;

  if (!currentEntry || !current) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <p className="text-2xl font-bold">Nothing left today.</p>
        <p className="text-base-content/55 mt-2">
          {doneCount > 0
            ? `${doneCount} session${doneCount === 1 ? '' : 's'} done. That is the whole list.`
            : 'Nothing is scheduled. That is allowed.'}
        </p>
        <Link href="/today" className="btn btn-primary btn-sm mt-6 rounded-xl">
          Back to today
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      {/* --- Are we behind? ------------------------------------------------ */}
      {drift > 0 ? (
        <p className="text-warning mb-4 text-center text-sm">
          Running about {formatDuration(drift)} behind. The times below already account for it.
        </p>
      ) : null}

      {/* --- The one thing ------------------------------------------------- */}
      <section className="card bg-base-100 border-base-200 border shadow-sm">
        <div className="card-body items-center gap-4 text-center">
          <p className="text-base-content/40 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
            {currentEntry.isMeeting ? 'Now — meeting' : 'Now'}
          </p>

          <h1 className="text-2xl font-extrabold leading-tight tracking-tight">
            {currentEntry.title}
          </h1>

          <p className="text-base-content/50 text-sm">
            {formatTime(current.projectedStart, timeZone)}–{formatTime(current.projectedEnd, timeZone)}
            {currentEntry.projectName ? ` · ${currentEntry.projectName}` : ''}
          </p>

          {currentEntry.starterStep ? (
            <div className="bg-accent/8 border-accent w-full rounded-r-lg border-l-[3px] px-3 py-2 text-left text-sm">
              <span className="font-semibold">Start here:</span> {currentEntry.starterStep}
            </div>
          ) : null}

          {!currentEntry.isMeeting && currentEntry.taskId ? (
            <>
              <FocusTimer
                taskId={currentEntry.taskId}
                taskTitle={currentEntry.title}
                startedAt={currentEntry.startedAt}
              />

              <BreakPrompt
                taskId={currentEntry.taskId}
                taskTitle={currentEntry.title}
                startedAt={currentEntry.startedAt}
                enabled={rhythm.enabled}
                workMinutes={rhythm.workMinutes}
                breakMinutes={rhythm.breakMinutes}
              />

              <LoggedActionButton
                action={completeTask}
                fields={{ id: currentEntry.taskId }}
                successMessage={`Finished "${currentEntry.title}".`}
                undo={{ action: uncompleteTask, arg: currentEntry.taskId, label: 'Undo' }}
                className="btn btn-outline btn-sm gap-1.5 rounded-xl"
              >
                <CheckIcon className="size-4" />
                Done — next
              </LoggedActionButton>
            </>
          ) : null}
        </div>
      </section>

      {/* --- What follows -------------------------------------------------- */}
      {rest.length > 0 ? (
        <section className="mt-5">
          <h2 className="text-base-content/40 mb-2 px-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
            Then
          </h2>
          <ol className="card bg-base-100 border-base-200 divide-base-200 divide-y border shadow-sm">
            {rest.slice(0, 6).map((item) => {
              const entry = byId.get(item.id)!;
              return (
                <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-base-content/40 w-11 shrink-0 font-mono text-[0.72rem] tabular-nums">
                    {formatTime(item.projectedStart, timeZone)}
                  </span>
                  <span className="min-w-0 grow truncate text-sm">{entry.title}</span>
                  {entry.isMeeting ? (
                    <span className="badge badge-xs badge-ghost shrink-0">meeting</span>
                  ) : item.driftMinutes > 0 ? (
                    <span className="text-warning shrink-0 text-[0.7rem]">
                      +{formatDuration(item.driftMinutes)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        <p className="text-base-content/45 mt-5 text-center text-sm">
          Last one. After this the day is yours.
        </p>
      )}

      <p className="mt-6 text-center">
        <Link href="/today" className="link text-base-content/45 text-xs">
          Leave focus mode
        </Link>
      </p>
    </div>
  );
}
