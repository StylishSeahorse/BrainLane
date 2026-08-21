'use client';

/**
 * The morning ritual.
 *
 * Sunsama's most-copied idea and the hardest one to get right: a short guided
 * flow that ends with a day someone has actually agreed to, rather than a list
 * that accumulated overnight.
 *
 * Three steps, and the order is the argument:
 *
 *   1. Yesterday, closed off. Unfinished work is decided on deliberately —
 *      moved, shelved, or dropped — instead of silently reappearing.
 *   2. Today, chosen. Pick from the backlog with the capacity meter running
 *      live, so overcommitment is visible *while* deciding, not at 6pm.
 *   3. Confirmed, then handed to the scheduler for times.
 *
 * The friction is deliberate and it is placed precisely here. Every other
 * surface in this app tries to get out of the way; this one asks the user to
 * make a decision, because a plan nobody chose is one nobody follows.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  commitTaskToDay,
  completeTask,
  markDayPlanned,
  rebuildPlan,
} from '@/app/actions';
import { formatDuration, formatTime, relativeDays } from '@/components/format';
import { CheckIcon, WandIcon } from '@/components/icons';

export interface PlanTask {
  id: string;
  title: string;
  estimateMinutes: number;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  deadline: Date | null;
  rolloverCount: number;
  project: { name: string; color: string | null } | null;
}

export interface PlanMeeting {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
}

const STEPS = ['Yesterday', "Today's work", 'Ready'] as const;

export function DailyPlan({
  dayKey,
  yesterdayKey,
  yesterday,
  completedYesterday,
  today: initialToday,
  backlog: initialBacklog,
  meetings,
  capacityMinutes,
  hasWorkingHours,
  isNonWorkingDay,
  timeZone,
}: {
  dayKey: string;
  yesterdayKey: string;
  yesterday: PlanTask[];
  completedYesterday: number;
  today: PlanTask[];
  backlog: PlanTask[];
  meetings: PlanMeeting[];
  capacityMinutes: number;
  hasWorkingHours: boolean;
  isNonWorkingDay: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [leftovers, setLeftovers] = useState(yesterday);
  const [today, setToday] = useState(initialToday);
  const [backlog, setBacklog] = useState(initialBacklog);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const plannedMinutes = useMemo(
    () => today.reduce((sum, task) => sum + task.estimateMinutes, 0),
    [today],
  );
  const over = hasWorkingHours && plannedMinutes > capacityMinutes;
  const remaining = capacityMinutes - plannedMinutes;

  const run = (work: () => Promise<{ error?: string } | void>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result && 'error' in result && result.error) {
        setError(result.error);
        return;
      }
      onDone?.();
    });
  };

  /** Take a task off yesterday's pile, whichever way the user chose. */
  const settle = (task: PlanTask, how: 'today' | 'backlog' | 'done') => {
    setLeftovers((current) => current.filter((row) => row.id !== task.id));
    if (how === 'today') setToday((current) => [...current, task]);

    run(() => {
      if (how === 'today') return commitTaskToDay({ taskId: task.id, day: dayKey });
      if (how === 'backlog') return commitTaskToDay({ taskId: task.id, day: null });
      const data = new FormData();
      data.set('id', task.id);
      return completeTask(data).then(() => ({}));
    });
  };

  const addToToday = (task: PlanTask) => {
    setBacklog((current) => current.filter((row) => row.id !== task.id));
    setToday((current) => [...current, task]);
    run(() => commitTaskToDay({ taskId: task.id, day: dayKey }));
  };

  const removeFromToday = (task: PlanTask) => {
    setToday((current) => current.filter((row) => row.id !== task.id));
    setBacklog((current) => [task, ...current]);
    run(() => commitTaskToDay({ taskId: task.id, day: null }));
  };

  const finish = () => {
    run(
      async () => {
        const marked = await markDayPlanned(dayKey);
        if (marked.error) return marked;
        // The scheduler runs last, once the day's contents are settled, so it
        // solves the problem the user actually just described.
        await rebuildPlan();
        return {};
      },
      () => router.push('/today'),
    );
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* --- Where you are ------------------------------------------------ */}
      <ol className="mb-6 flex items-center gap-2" aria-label="Planning steps">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={index === step ? 'step' : undefined}
              className={`grid size-6 place-items-center rounded-full text-xs font-semibold ${
                index < step
                  ? 'bg-primary/15 text-primary'
                  : index === step
                    ? 'bg-primary text-primary-content'
                    : 'bg-base-200 text-base-content/40'
              }`}
            >
              {index < step ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              className={`text-sm ${index === step ? 'font-semibold' : 'text-base-content/45'}`}
            >
              {label}
            </span>
            {index < STEPS.length - 1 ? (
              <span className="bg-base-200 mx-1 h-px w-4" aria-hidden="true" />
            ) : null}
          </li>
        ))}
      </ol>

      {error ? (
        <div role="alert" className="border-error/30 bg-error/8 text-error mb-4 rounded-xl border px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      {/* =================================================================
          Step 1 — Yesterday
          ================================================================= */}
      {step === 0 ? (
        <section className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body gap-4">
            <div>
              <h2 className="card-title text-lg">How yesterday went</h2>
              <p className="text-base-content/55 mt-0.5 text-sm">
                {completedYesterday > 0
                  ? `You finished ${completedYesterday} thing${completedYesterday === 1 ? '' : 's'}.`
                  : 'Nothing was ticked off — some days are like that.'}
                {leftovers.length > 0
                  ? ` ${leftovers.length} didn’t happen. Decide on each one now, and it stops following you around.`
                  : ' Nothing is left hanging.'}
              </p>
            </div>

            {leftovers.length > 0 ? (
              <ul className="divide-base-200 divide-y">
                {leftovers.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                    <div className="min-w-0 grow">
                      <p className="text-sm font-medium">{task.title}</p>
                      <p className="text-base-content/45 text-xs">
                        {formatDuration(task.estimateMinutes)}
                        {task.rolloverCount >= 3
                          ? ` · carried forward ${task.rolloverCount} times`
                          : ''}
                        {task.deadline ? ` · due ${relativeDays(task.deadline)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => settle(task, 'today')}
                        className="btn btn-outline btn-xs rounded-lg"
                      >
                        Today
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => settle(task, 'backlog')}
                        className="btn btn-ghost btn-xs rounded-lg"
                      >
                        Later
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => settle(task, 'done')}
                        className="btn btn-ghost btn-xs rounded-lg"
                      >
                        Already done
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="card-actions justify-end">
              <button type="button" onClick={() => setStep(1)} className="btn btn-primary btn-sm rounded-xl">
                {leftovers.length > 0 ? 'Leave the rest for now' : 'Next'}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* =================================================================
          Step 2 — Choosing today
          ================================================================= */}
      {step === 1 ? (
        <section className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body gap-4">
            <div>
              <h2 className="card-title text-lg">What are you actually doing today?</h2>
              <p className="text-base-content/55 mt-0.5 text-sm">
                {isNonWorkingDay
                  ? 'Today is not a working day. Anything you pick is extra, not expected.'
                  : hasWorkingHours
                    ? `${formatDuration(capacityMinutes)} of real working time, once meetings and routines are out.`
                    : 'Set working hours in Settings and this becomes a real capacity check.'}
              </p>
            </div>

            {/* --- The immovable part of the day --------------------------- */}
            {meetings.length > 0 ? (
              <div className="bg-base-200/50 rounded-xl px-3 py-2.5">
                <p className="text-base-content/50 text-[0.7rem] font-semibold uppercase tracking-wide">
                  Already booked
                </p>
                <ul className="mt-1 space-y-0.5">
                  {meetings.map((meeting) => (
                    <li key={meeting.id} className="flex items-baseline gap-2 text-sm">
                      <span className="text-base-content/45 shrink-0 font-mono text-xs">
                        {formatTime(meeting.startsAt, timeZone)}
                      </span>
                      <span className="truncate">{meeting.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* --- The live verdict ---------------------------------------- */}
            <Load
              plannedMinutes={plannedMinutes}
              capacityMinutes={capacityMinutes}
              hasWorkingHours={hasWorkingHours}
              over={over}
              remaining={remaining}
              count={today.length}
            />

            {/* --- Chosen --------------------------------------------------- */}
            <div>
              <h3 className="text-sm font-semibold">Today ({today.length})</h3>
              {today.length === 0 ? (
                <p className="text-base-content/40 py-3 text-sm">
                  Nothing chosen yet. Pick from below — three real things beats twelve hopeful ones.
                </p>
              ) : (
                <ul className="divide-base-200 mt-1 divide-y">
                  {today.map((task) => (
                    <li key={task.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 grow">
                        <p className="text-sm font-medium">{task.title}</p>
                        <p className="text-base-content/45 text-xs">
                          {formatDuration(task.estimateMinutes)}
                          {task.project ? ` · ${task.project.name}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => removeFromToday(task)}
                        className="btn btn-ghost btn-xs shrink-0 rounded-lg"
                      >
                        Not today
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* --- The pool ------------------------------------------------- */}
            <div>
              <h3 className="text-sm font-semibold">From your backlog</h3>
              {backlog.length === 0 ? (
                <p className="text-base-content/40 py-3 text-sm">Nothing waiting.</p>
              ) : (
                <ul className="divide-base-200 mt-1 max-h-72 divide-y overflow-y-auto">
                  {backlog.map((task) => (
                    <li key={task.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 grow">
                        <p className="text-sm">{task.title}</p>
                        <p className="text-base-content/45 text-xs">
                          {formatDuration(task.estimateMinutes)}
                          {task.deadline ? ` · due ${relativeDays(task.deadline)}` : ''}
                          {task.project ? ` · ${task.project.name}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => addToToday(task)}
                        className="btn btn-outline btn-xs shrink-0 rounded-lg"
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card-actions justify-between">
              <button type="button" onClick={() => setStep(0)} className="btn btn-ghost btn-sm rounded-xl">
                Back
              </button>
              <button type="button" onClick={() => setStep(2)} className="btn btn-primary btn-sm rounded-xl">
                Next
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* =================================================================
          Step 3 — Commit
          ================================================================= */}
      {step === 2 ? (
        <section className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body gap-4">
            <div>
              <h2 className="card-title text-lg">
                {today.length === 0
                  ? 'An empty day'
                  : `${today.length} thing${today.length === 1 ? '' : 's'}, ${formatDuration(plannedMinutes)}`}
              </h2>
              <p className="text-base-content/55 mt-0.5 text-sm">
                {over
                  ? `That is ${formatDuration(plannedMinutes - capacityMinutes)} more than today holds. You can still start — but the last thing on the list is the one that will not happen.`
                  : today.length === 0
                    ? 'Nothing is committed. That is a legitimate plan, not a failure.'
                    : 'This fits. The scheduler will find times around your meetings.'}
              </p>
            </div>

            <Load
              plannedMinutes={plannedMinutes}
              capacityMinutes={capacityMinutes}
              hasWorkingHours={hasWorkingHours}
              over={over}
              remaining={remaining}
              count={today.length}
            />

            {today.length > 0 ? (
              <ol className="divide-base-200 divide-y">
                {today.map((task, index) => (
                  <li key={task.id} className="flex items-baseline gap-3 py-2">
                    <span className="text-base-content/35 w-4 shrink-0 text-xs tabular-nums">
                      {index + 1}
                    </span>
                    <span className="min-w-0 grow text-sm font-medium">{task.title}</span>
                    <span className="text-base-content/45 shrink-0 text-xs">
                      {formatDuration(task.estimateMinutes)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}

            <div className="card-actions justify-between">
              <button type="button" onClick={() => setStep(1)} className="btn btn-ghost btn-sm rounded-xl">
                Back
              </button>
              <button
                type="button"
                onClick={finish}
                disabled={busy}
                className="btn btn-primary btn-sm gap-1.5 rounded-xl"
              >
                <WandIcon />
                {busy ? 'Setting up…' : 'Start the day'}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <p className="text-base-content/35 mt-4 text-center text-xs">
        Yesterday{' '}
        <a href={`/today?date=${yesterdayKey}`} className="link">
          is still there
        </a>{' '}
        if you want to look.
      </p>
    </div>
  );
}

/** The running verdict. The number that should change someone's mind. */
function Load({
  plannedMinutes,
  capacityMinutes,
  hasWorkingHours,
  over,
  remaining,
  count,
}: {
  plannedMinutes: number;
  capacityMinutes: number;
  hasWorkingHours: boolean;
  over: boolean;
  remaining: number;
  count: number;
}) {
  if (!hasWorkingHours) return null;

  const fill = capacityMinutes > 0 ? Math.min(100, (plannedMinutes / capacityMinutes) * 100) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className={over ? 'text-error font-semibold' : 'font-semibold'}>
          {over
            ? `Over by ${formatDuration(plannedMinutes - capacityMinutes)}`
            : count === 0
              ? 'Nothing planned yet'
              : `${formatDuration(remaining)} still free`}
        </span>
        <span className="text-base-content/50 text-xs tabular-nums">
          {formatDuration(plannedMinutes)} of {formatDuration(capacityMinutes)}
        </span>
      </div>
      <div
        className="bg-base-200 mt-1.5 flex h-2 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`${formatDuration(plannedMinutes)} planned of ${formatDuration(capacityMinutes)} available`}
      >
        <span className={`h-full ${over ? 'bg-error' : 'bg-primary'}`} style={{ width: `${fill}%` }} />
      </div>
    </div>
  );
}
