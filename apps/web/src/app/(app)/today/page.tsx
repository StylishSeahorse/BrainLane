import Link from 'next/link';
import { expandLabeledRoutines, fromLocal, startOfLocalDay, toLocal } from '@fluid/core';
import {
  acceptPlanAction,
  acknowledgeAvoidance,
  breakdownTask,
  completeTask,
  deferTask,
  rebuildPlan,
  rejectPlanAction,
  uncompleteTask,
  uncompleteTaskAction,
} from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { FocusTimer } from '@/components/focus-card';
import { formatDay, formatDuration, formatTime, relativeDays } from '@/components/format';
import { EnergyBadge } from '@/components/page-header';
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RoutineIcon,
  TimerIcon,
  WandIcon,
} from '@/components/icons';
import { QuickAddTask } from '@/components/quick-add-task';
import { CapacityMeter } from '@/components/capacity-meter';
import { ShutdownCard } from '@/components/shutdown-card';
import { WeekGrid } from '@/components/week-grid';
import { archiveTask } from '@/app/actions';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/** Fallback timeline window; widened below when the day's content spills out. */
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 19;
const HARD_MIN_HOUR = 6;
const HARD_MAX_HOUR = 23;

interface Span {
  startsAt: Date;
  endsAt: Date;
}

/** Same content-fitting logic the week calendar uses, narrowed to one day. */
function visibleHours(spans: Span[], timeZone: string): [number, number] {
  let start = DEFAULT_START_HOUR;
  let end = DEFAULT_END_HOUR;

  for (const span of spans) {
    const from = toLocal(span.startsAt, timeZone);
    const to = toLocal(span.endsAt, timeZone);
    start = Math.min(start, from.hour);
    end = Math.max(end, to.minute > 0 ? to.hour + 1 : to.hour);
  }

  return [Math.max(HARD_MIN_HOUR, start), Math.min(HARD_MAX_HOUR, Math.max(end, start + 4))];
}

/**
 * The planner: one screen that is both the day's list and the day's shape.
 *
 * Sunsama's layout, Motion's engine. The left pane is the day as a list —
 * every scheduled session, meeting, and routine in time order, completable in
 * place, with capture at the bottom. The right pane is the same day as a
 * timeline, where the AI's plan is visible and directly adjustable (drag to
 * move, edges to resize). One glance answers both "what am I doing?" and
 * "when am I doing it?" — previously those were two different pages.
 */
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireUser();
  const caller = await getCaller();
  const timeZone = user.timeZone;

  const now = new Date();
  const todayStart = startOfLocalDay(now, timeZone);

  // The visible day comes from ?date=YYYY-MM-DD so every day is a link — the
  // browser back button undoes navigation, and a refresh stays put. Noon as
  // the probe instant sidesteps DST edges when resolving the local date.
  const dateParam = (await searchParams).date;
  let dayStart = todayStart;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const [year, month, day] = dateParam.split('-').map(Number);
    dayStart = startOfLocalDay(
      fromLocal({ year: year!, month: month!, day: day!, hour: 12, minute: 0, second: 0 }, timeZone),
      timeZone,
    );
  }
  const dayEnd = startOfLocalDay(dayStart, timeZone, 1);
  const isToday = dayStart.getTime() === todayStart.getTime();

  const dateOf = (date: Date): string => {
    const local = toLocal(date, timeZone);
    return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  };
  const prevHref = `/today?date=${dateOf(startOfLocalDay(dayStart, timeZone, -1))}`;
  const nextHref = `/today?date=${dateOf(startOfLocalDay(dayStart, timeZone, 1))}`;

  const [
    { blocks, events },
    pending,
    runway,
    avoidance,
    routines,
    shape,
    dayLog,
    loose,
    stale,
    unplaced,
    highlights,
  ] =
    await Promise.all([
      caller.plan.blocks({ from: dayStart, to: dayEnd }),
      caller.plan.pending(),
      caller.plan.runway(),
      caller.task.avoidance(),
      caller.routine.list(),
      caller.day.shape({ day: dayStart }),
      caller.day.log({ day: dayStart }),
      caller.day.loose({ day: dayStart }),
      caller.task.stale(),
      caller.day.unplaced({ day: dayStart }),
      caller.day.highlights({ day: dayStart }),
    ]);

  // Same expansion the scheduler uses, narrowed to this day.
  const dayRoutines = expandLabeledRoutines(
    routines.flatMap((routine) =>
      (routine.days ?? [null]).map((dayOfWeek) => ({
        kind: 'ROUTINE' as const,
        label: routine.label,
        dayOfWeek,
        startTime: routine.startTime,
        endTime: routine.endTime,
      })),
    ),
    { start: dayStart, end: dayEnd },
    timeZone,
  );

  const doneBlocks = blocks.filter((block) => block.state === 'COMPLETED');
  const plannedMinutes = blocks.reduce(
    (sum, block) => sum + (block.endsAt.getTime() - block.startsAt.getTime()) / 60_000,
    0,
  );
  const doneMinutes = doneBlocks.reduce(
    (sum, block) => sum + (block.endsAt.getTime() - block.startsAt.getTime()) / 60_000,
    0,
  );

  // The one to point at: the session under the cursor of "now", else the next
  // one coming. Only meaningful when looking at the actual today.
  const live = blocks.filter((block) => block.state !== 'COMPLETED');
  const focus = isToday
    ? (live.find((block) => block.startsAt <= now && block.endsAt > now) ??
      live.find((block) => block.startsAt > now))
    : undefined;

  // Motion's posture: a deadline in danger is said out loud, not discovered
  // later. Only genuinely short items make the cut — a healthy runway is
  // silence, and the strip only exists on today, where action can happen.
  const atRisk = isToday
    ? runway.filter((item) => item.shortfallMinutes > 0 || item.sessionsBeforeDeadline === 0)
    : [];

  // The whole day as one time-ordered list: sessions to do, meetings to be
  // at, routines that shape the rest. One sequence, not three lists to
  // mentally interleave.
  const entries = [
    ...blocks.map((block) => ({ kind: 'block' as const, at: block.startsAt, block })),
    ...events.map((event) => ({ kind: 'event' as const, at: event.startsAt, event })),
    ...dayRoutines.map((routine) => ({ kind: 'routine' as const, at: routine.start, routine })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const [startHour, endHour] = visibleHours(
    [
      ...blocks,
      ...events,
      ...dayRoutines.map((routine) => ({ startsAt: routine.start, endsAt: routine.end })),
    ],
    timeZone,
  );
  const totalHours = endHour - startHour;

  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(dayStart);

  return (
    <>
      {/* --- Day header: where you are in the week, and the AI lever --------- */}
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {/*
            "Planner" was this page's eyebrow back when it was the only
            planning surface. That job now belongs to Week; this is the doing
            surface, and the eyebrow should say so.
          */}
          <p className="text-base-content/40 mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
            Your day
          </p>
          <div className="flex items-center gap-1.5">
            <Link href={prevHref} className="btn btn-ghost btn-sm btn-square rounded-lg" aria-label="Previous day">
              <ChevronLeftIcon />
            </Link>
            <h1 className="text-[1.7rem] font-extrabold leading-none tracking-tight sm:text-[2.1rem]">
              {isToday ? 'Today' : weekday}
            </h1>
            <Link href={nextHref} className="btn btn-ghost btn-sm btn-square rounded-lg" aria-label="Next day">
              <ChevronRightIcon />
            </Link>
            {!isToday ? (
              <Link href="/today" className="btn btn-ghost btn-xs rounded-lg">
                Back to today
              </Link>
            ) : null}
          </div>
          <p className="text-base-content/55 mt-1.5 text-sm">
            {formatDay(dayStart, timeZone)}
            {blocks.length > 0
              ? ` · ${doneBlocks.length} of ${blocks.length} session${blocks.length === 1 ? '' : 's'} done · ${formatDuration(plannedMinutes)} planned`
              : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            Only on today, and only when there is something to focus on.
            Offering "one thing at a time" for a day with nothing in it is a
            dead end dressed up as a feature.
          */}
          {isToday && blocks.some((block) => block.task.status !== 'DONE') ? (
            <Link href="/focus" className="btn btn-outline btn-sm gap-1.5 rounded-xl">
              <TimerIcon />
              Focus
            </Link>
          ) : null}

          <LoggedActionButton
            action={rebuildPlan}
            fields={{}}
            successMessage="Re-planned your schedule."
            pendingLabel="Planning…"
            className="btn btn-primary btn-sm gap-1.5 rounded-xl"
          >
            <WandIcon />
            Plan my day
          </LoggedActionButton>
        </div>
      </header>

      {/*
        --- The day has not been planned yet --------------------------------
        Offered once, at the top, and only on today. It disappears the moment
        the ritual is done rather than nagging afterwards — a prompt that
        stays put after you have complied is one you learn to scroll past,
        taking everything near it along too.
      */}
      {isToday && !dayLog?.plannedAt && !dayLog?.shutdownAt ? (
        <Link
          href="/plan-day"
          className="border-primary/35 bg-primary/6 hover:bg-primary/10 mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-3.5 transition-colors"
        >
          <span className="text-primary shrink-0" aria-hidden="true">
            <WandIcon />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Plan today first</span>
            <span className="text-base-content/60 block text-xs">
              Close off yesterday, choose what today is for, and check it fits. About five minutes.
            </span>
          </span>
          <span className="btn btn-primary btn-xs ml-auto shrink-0 rounded-lg">Start</span>
        </Link>
      ) : null}

      {/* --- A plan is waiting on a decision ------------------------------- */}
      {pending ? (
        <section className="card bg-base-100 border-primary/40 mb-5 border shadow-sm">
          <div className="card-body gap-3 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="card-title text-base">Your schedule changed</h2>
              <span className={`badge badge-sm ${pending.usedAi ? 'badge-secondary' : 'badge-ghost'}`}>
                {pending.usedAi ? 'with AI' : 'no AI'}
              </span>
            </div>

            <ul className="space-y-1.5">
              {pending.changes
                .filter((change) => change.kind !== 'UNCHANGED')
                .slice(0, 6)
                .map((change) => (
                  <li key={change.id} className="flex items-start gap-2 text-sm">
                    <span
                      className={`badge badge-xs badge-soft mt-1 shrink-0 ${
                        change.kind === 'REMOVED' ? 'badge-error' : 'badge-warning'
                      }`}
                    >
                      {change.kind.toLowerCase()}
                    </span>
                    <span className="text-base-content/80">{change.reason}</span>
                  </li>
                ))}
            </ul>

            <div className="card-actions">
              <LoggedActionButton
                action={acceptPlanAction}
                fields={{ planVersionId: pending.id }}
                successMessage="Accepted the new plan."
                pendingLabel="Accepting…"
                className="btn btn-primary btn-sm rounded-xl"
              >
                Accept
              </LoggedActionButton>
              <LoggedActionButton
                action={rejectPlanAction}
                fields={{ planVersionId: pending.id }}
                successMessage="Kept the plan you already had."
                pendingLabel="Keeping…"
                className="btn btn-ghost btn-sm"
              >
                Keep what I had
              </LoggedActionButton>
            </div>
          </div>
        </section>
      ) : null}

      {/* --- Does today actually fit? --------------------------------------- */}
      <div className="mb-5">
        <CapacityMeter
          capacity={shape.capacity}
          verdict={shape.verdict}
          isNonWorkingDay={shape.isNonWorkingDay}
          hasWorkingHours={shape.hasWorkingHours}
        />
      </div>

      {/* --- Deadlines in danger, said out loud ----------------------------- */}
      {atRisk.length > 0 ? (
        <div className="border-error/25 bg-error/6 mb-5 rounded-2xl border px-4 py-3">
          <p className="text-sm font-semibold">
            {atRisk.length === 1 ? 'One deadline is at risk' : `${atRisk.length} deadlines are at risk`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {atRisk.slice(0, 4).map((item) => (
              <li key={item.taskId} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{item.title}</span>
                <span className="text-base-content/60">
                  {item.sessionsBeforeDeadline === 0
                    ? `nothing booked, due ${relativeDays(item.deadline)}`
                    : `${formatDuration(item.shortfallMinutes)} still unbooked, due ${relativeDays(item.deadline)}`}
                </span>
              </li>
            ))}
          </ul>
          {/*
            The remedy is stated once, not once per row. Repeating the same
            sentence three times is how a warning becomes wallpaper.
          */}
          <p className="text-base-content/60 mt-1.5 text-xs">
            {atRisk.length > 4 ? `…and ${atRisk.length - 4} more. ` : ''}
            &ldquo;Plan my day&rdquo; will look for slots.
          </p>
        </div>
      ) : null}

      {/* --- The split: the day as a list, the day as a timeline ------------ */}
      {/*
        The list keeps a fixed, readable width and the timeline takes whatever
        is left — the reverse (both flexible) shrinks the timeline to a sliver
        on a laptop, which is the pane that most needs the room.
      */}
      <div className="grid items-start gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        {/* Left: the day's plan as a completable list. */}
        <section className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body gap-0 p-0">
            <h2 className="border-base-200 flex items-center justify-between border-b px-4 py-3 text-sm font-semibold">
              {isToday ? 'Your day' : weekday}
              {plannedMinutes > 0 ? (
                <span className="text-base-content/45 text-xs font-normal">
                  {doneMinutes > 0 ? `${formatDuration(doneMinutes)} done · ` : ''}
                  {formatDuration(plannedMinutes)} planned
                </span>
              ) : null}
            </h2>

            {entries.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="font-medium">Nothing scheduled.</p>
                <p className="text-base-content/50 mt-1 text-sm">
                  Add a task below, then press “Plan my day” to let the AI place it.
                </p>
              </div>
            ) : (
              <ul className="divide-base-200 divide-y">
                {entries.map((entry) => {
                  if (entry.kind === 'routine') {
                    return (
                      <li
                        key={`routine-${entry.routine.label}-${entry.at.toISOString()}`}
                        className="flex items-center gap-3 px-4 py-2"
                      >
                        <span className="text-base-content/40 w-11 shrink-0 font-mono text-[0.7rem]">
                          {formatTime(entry.at, timeZone)}
                        </span>
                        <span className="text-base-content/35 shrink-0" aria-hidden="true">
                          <RoutineIcon className="size-3.5" />
                        </span>
                        <span className="text-base-content/50 min-w-0 grow truncate text-sm">
                          {entry.routine.label}
                        </span>
                      </li>
                    );
                  }

                  if (entry.kind === 'event') {
                    return (
                      <li key={entry.event.id} className="flex items-center gap-3 px-4 py-2.5">
                        <span className="text-base-content/40 w-11 shrink-0 font-mono text-[0.7rem]">
                          {formatTime(entry.at, timeZone)}
                        </span>
                        <span className="text-base-content/35 shrink-0" aria-hidden="true">
                          <CalendarIcon className="size-3.5" />
                        </span>
                        <span className="text-base-content/75 min-w-0 grow truncate text-sm font-medium">
                          {entry.event.title}
                        </span>
                        <span className="badge badge-xs badge-ghost shrink-0">meeting</span>
                      </li>
                    );
                  }

                  const block = entry.block;
                  // The task's status, not the block's — see the `status`
                  // select in plan.blocks for why those two can disagree.
                  const completed = block.task.status === 'DONE';
                  const isFocus = focus?.id === block.id;
                  const minutes = (block.endsAt.getTime() - block.startsAt.getTime()) / 60_000;

                  return (
                    <li
                      key={block.id}
                      className={`px-4 py-3 ${isFocus ? 'bg-primary/4 border-primary border-l-[3px]' : ''} ${
                        completed ? 'opacity-55' : ''
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="pt-0.5">
                          {completed ? (
                            <LoggedActionButton
                              action={uncompleteTaskAction}
                              fields={{ id: block.task.id }}
                              successMessage={`Brought "${block.task.title}" back.`}
                              className="bg-primary border-primary grid size-5 place-items-center rounded-full border-2 text-white"
                            >
                              <CheckIcon className="size-3" />
                              <span className="sr-only">Undo finishing “{block.task.title}”</span>
                            </LoggedActionButton>
                          ) : (
                            <LoggedActionButton
                              action={completeTask}
                              fields={{ id: block.task.id }}
                              successMessage={`Finished "${block.task.title}".`}
                              undo={{ action: uncompleteTask, arg: block.task.id, label: 'Undo' }}
                              className="border-base-300 hover:border-primary hover:bg-primary/10 block size-5 rounded-full border-2 transition-colors"
                            >
                              <span className="sr-only">Mark “{block.task.title}” done</span>
                            </LoggedActionButton>
                          )}
                        </div>

                        <div className="min-w-0 grow">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className={`text-sm font-medium ${completed ? 'line-through' : ''}`}>
                              {block.task.title}
                            </span>
                            {block.state === 'PROPOSED' ? (
                              <span className="badge badge-xs badge-soft badge-warning shrink-0">proposed</span>
                            ) : null}
                          </div>
                          <p className="text-base-content/50 mt-0.5 text-xs">
                            {formatTime(block.startsAt, timeZone)}–{formatTime(block.endsAt, timeZone)}
                            {' · '}
                            {formatDuration(minutes)}
                            {block.task.project ? ` · ${block.task.project.name}` : ''}
                          </p>

                          {/*
                            The focus session carries the working surface: the
                            starter step and the five-minute timer live on the
                            row itself, so "what now?" and "start it" are the
                            same place on screen.
                          */}
                          {isFocus ? (
                            <div className="mt-2.5 space-y-2.5">
                              {block.task.starterStep ? (
                                <div className="bg-accent/8 border-accent rounded-r-lg border-l-[3px] px-3 py-1.5 text-sm">
                                  <span className="font-semibold">Start here:</span> {block.task.starterStep}
                                </div>
                              ) : null}

                              <FocusTimer
                                taskId={block.task.id}
                                taskTitle={block.task.title}
                                startedAt={block.task.timerStartedAt}
                              />

                              <div className="flex flex-wrap gap-1.5">
                                <EnergyBadge energy={block.task.energy} />
                                <LoggedActionButton
                                  action={breakdownTask}
                                  fields={{ id: block.task.id, granularity: 'tiny' }}
                                  successMessage={`Broke "${block.task.title}" into smaller steps.`}
                                  pendingLabel="Thinking…"
                                  className="btn btn-outline btn-xs rounded-lg"
                                >
                                  Too big — break it down
                                </LoggedActionButton>
                                <LoggedActionButton
                                  action={deferTask}
                                  fields={{ id: block.task.id, days: '1' }}
                                  successMessage={`Moved "${block.task.title}" to tomorrow.`}
                                  pendingLabel="Deferring…"
                                  className="btn btn-ghost btn-xs rounded-lg"
                                >
                                  Not today
                                </LoggedActionButton>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/*
              --- Committed, but not yet placed ---------------------------
              Work dragged onto this day on the board that the scheduler has
              not given a time to. Shown as its own group rather than mixed
              into the timeline, because "I decided to do this" and "it happens
              at 10:15" are different states and the difference is the thing
              the user is being asked to resolve.
            */}
            {unplaced.length > 0 ? (
              <div className="border-base-200 border-t">
                <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
                  <h3 className="text-[0.78rem] font-semibold">Committed, no time yet</h3>
                  <span className="text-base-content/40 text-xs">
                    {formatDuration(
                      unplaced.reduce((sum, task) => sum + task.estimateMinutes, 0),
                    )}
                  </span>
                </div>
                <ul className="divide-base-200 divide-y">
                  {unplaced.map((task) => (
                    <li key={task.id} className="flex items-start gap-3 px-4 py-2.5">
                      <div className="pt-0.5">
                        <LoggedActionButton
                          action={completeTask}
                          fields={{ id: task.id }}
                          successMessage={`Finished "${task.title}".`}
                          undo={{ action: uncompleteTask, arg: task.id, label: 'Undo' }}
                          className="border-base-300 hover:border-primary hover:bg-primary/10 block size-5 rounded-full border-2 transition-colors"
                        >
                          <span className="sr-only">Mark “{task.title}” done</span>
                        </LoggedActionButton>
                      </div>
                      <div className="min-w-0 grow">
                        <p className="text-sm font-medium">{task.title}</p>
                        <p className="text-base-content/50 mt-0.5 text-xs">
                          {formatDuration(task.estimateMinutes)}
                          {task.project ? ` · ${task.project.name}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-base-content/45 px-4 pb-3 pt-2 text-xs">
                  “Plan my day” will find room for these around your meetings.
                </p>
              </div>
            ) : null}

            <QuickAddTask />
          </div>
        </section>

        {/* Right: the same day as a timeline — the AI's plan, adjustable. */}
        <div className="min-w-0">
          <WeekGrid
            days={[dayStart]}
            blocks={blocks}
            events={events}
            routines={dayRoutines}
            timeZone={timeZone}
            startHour={startHour}
            totalHours={totalHours}
            hideDayHeader
          />
        </div>
      </div>

      {/* --- The day has an ending ------------------------------------------ */}
      {isToday ? (
        <ShutdownCard
          day={dayStart.toISOString()}
          completedCount={doneBlocks.length}
          focusedMinutes={Math.round(shape.capacity.completedMinutes)}
          meetingMinutes={Math.round(shape.capacity.meetingMinutes)}
          loose={loose.map((task) => ({ id: task.id, title: task.title }))}
          shutdownAt={dayLog?.shutdownAt ?? null}
          reflection={dayLog?.reflection ?? null}
          highlights={highlights}
        />
      ) : null}

      {/*
        --- Work that keeps being pushed ------------------------------------
        Asked, never done automatically. "You have moved this eight times" is a
        fact worth showing; deciding on someone's behalf that it no longer
        matters is not the tool's call to make.
      */}
      {isToday && stale.length > 0 ? (
        <div className="border-base-200 bg-base-100 mt-6 rounded-2xl border px-4 py-3.5">
          <p className="text-sm font-semibold">Still not happening</p>
          <ul className="mt-2 space-y-2.5">
            {stale.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">{task.title}</span>
                <span className="text-base-content/55">
                  moved {task.rescheduleCount} times — it may not belong in a day at all.
                </span>
                <LoggedActionButton
                  action={archiveTask}
                  fields={{ id: task.id }}
                  successMessage={`Moved "${task.title}" to the backlog.`}
                  pendingLabel="Moving…"
                  className="btn btn-outline btn-xs ml-auto rounded-lg"
                >
                  Move to backlog
                </LoggedActionButton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* --- Gentle check-in, out of the way -------------------------------- */}
      {isToday && avoidance.length > 0 ? (
        <details className="border-base-200 bg-base-100 mt-6 rounded-2xl border shadow-sm">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
            Worth a look
            <span className="text-base-content/45 ml-2 font-normal">
              {avoidance.length} task{avoidance.length === 1 ? '' : 's'} that keep{avoidance.length === 1 ? 's' : ''} moving
            </span>
          </summary>
          <div className="divide-base-200 border-base-200 divide-y border-t">
            {avoidance.map((task) => (
              <div key={task.id} className="px-4 py-3">
                <h3 className="text-sm font-semibold">{task.title}</h3>
                <p className="text-base-content/70 mt-0.5 text-sm">
                  {task.rescheduleCount >= 3
                    ? `This has moved ${task.rescheduleCount} times. That usually means it is too big or too vague — rarely that it is unimportant.`
                    : `This has not been touched since ${relativeDays(task.lastTouchedAt)}.`}
                </p>
                <div className="mt-2 flex gap-1.5">
                  <LoggedActionButton
                    action={breakdownTask}
                    fields={{ id: task.id, granularity: 'tiny' }}
                    successMessage={`Broke "${task.title}" into smaller steps.`}
                    pendingLabel="Thinking…"
                    className="btn btn-outline btn-xs rounded-lg"
                  >
                    Shrink it
                  </LoggedActionButton>
                  <LoggedActionButton
                    action={acknowledgeAvoidance}
                    fields={{ id: task.id }}
                    successMessage={`Left "${task.title}" for now.`}
                    className="btn btn-ghost btn-xs rounded-lg"
                  >
                    Leave it for now
                  </LoggedActionButton>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
