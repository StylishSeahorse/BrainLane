import Link from 'next/link';
import {
  expandLabeledRoutines,
  fromLocal,
  localDayOfWeek,
  startOfLocalDay,
  toLocal,
} from '@fluid/core';
import { rebuildPlan, rolloverDay } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { WeekBoard, type BoardColumn } from '@/components/board';
import { formatTime } from '@/components/format';
import { Banner, EmptyState, SegmentedNav } from '@/components/page-header';
import {
  BoardIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ColumnsIcon,
  ListIcon,
  RefreshIcon,
  WandIcon,
} from '@/components/icons';
import { WeekGrid } from '@/components/week-grid';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The week, through whichever lens answers the question you have.
 *
 * Board, Calendar and Agenda were three separate destinations showing the same
 * seven days. That is one week of data wearing three hats in the sidebar, and
 * it made the app feel larger than it is — the specific complaint this page
 * exists to answer.
 *
 * They are lenses, not places:
 *
 *   - **Board** — which day work belongs to. The planning decision.
 *   - **Calendar** — where it actually sits against meetings. The consequence.
 *   - **Agenda** — the same thing as a list, which is the accessible reading of
 *     the grid and the better one on a phone.
 *
 * Each is a real link carrying the week it is looking at, so the browser's back
 * button behaves and a bookmark keeps both the week and the lens.
 */

type View = 'board' | 'calendar' | 'agenda';

/** Fallback window for the grid. Widened below if content falls outside it. */
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 19;
const HARD_MIN_HOUR = 6;
const HARD_MAX_HOUR = 23;

interface Span {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Choose the visible hours from the data.
 *
 * A fixed 7am–9pm grid spends half its height on rows nobody uses, which pushes
 * the actual working day into a cramped strip. Fitting the window to the week's
 * content keeps blocks large enough to read — and large enough to tap.
 */
function visibleHours(spans: Span[], timeZone: string): [number, number] {
  let start = DEFAULT_START_HOUR;
  let end = DEFAULT_END_HOUR;

  for (const span of spans) {
    const from = toLocal(span.startsAt, timeZone);
    const to = toLocal(span.endsAt, timeZone);
    start = Math.min(start, from.hour);
    // Round the end upward so a block finishing at 17:30 does not clip.
    end = Math.max(end, to.minute > 0 ? to.hour + 1 : to.hour);
  }

  return [Math.max(HARD_MIN_HOUR, start), Math.min(HARD_MAX_HOUR, Math.max(end, start + 4))];
}

function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const left = toLocal(a, timeZone);
  const right = toLocal(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; week?: string }>;
}) {
  const user = await requireUser();
  const caller = await getCaller();
  const timeZone = user.timeZone;

  const params = await searchParams;
  const view: View =
    params.view === 'calendar' ? 'calendar' : params.view === 'agenda' ? 'agenda' : 'board';

  const now = new Date();
  const today = startOfLocalDay(now, timeZone);

  // Weeks start on Monday. `localDayOfWeek` is Sunday-based, so Sunday (0)
  // belongs to the week that began six days earlier, not the one starting
  // tomorrow — getting this wrong makes Sunday's work vanish from the week.
  const mondayOf = (day: Date): Date =>
    startOfLocalDay(day, timeZone, -((localDayOfWeek(day, timeZone) + 6) % 7));

  let weekStart = mondayOf(today);
  if (params.week && /^\d{4}-\d{2}-\d{2}$/.test(params.week)) {
    const [year, month, day] = params.week.split('-').map(Number);
    weekStart = mondayOf(
      fromLocal({ year: year!, month: month!, day: day!, hour: 12, minute: 0, second: 0 }, timeZone),
    );
  }
  const weekEnd = startOfLocalDay(weekStart, timeZone, 7);
  const isThisWeek = weekStart.getTime() === mondayOf(today).getTime();

  const dateKey = (date: Date): string => {
    const local = toLocal(date, timeZone);
    return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  };
  const todayKey = dateKey(today);

  /** Keep the lens when moving weeks, and the week when switching lens. */
  const href = (next: { view?: View; week?: string }): string => {
    const query = new URLSearchParams();
    const chosen = next.view ?? view;
    if (chosen !== 'board') query.set('view', chosen);
    const chosenWeek = next.week ?? (isThisWeek ? undefined : dateKey(weekStart));
    if (chosenWeek) query.set('week', chosenWeek);
    const suffix = query.toString();
    return suffix ? `/week?${suffix}` : '/week';
  };

  const weekdayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone });
  const dayNumberFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone,
  });

  const allDays = Array.from({ length: 7 }, (_, index) =>
    startOfLocalDay(weekStart, timeZone, index),
  );
  const rangeLabel = `${dayNumberFormat.format(allDays[0]!)} – ${dayNumberFormat.format(allDays[6]!)}`;

  // --- The header, shared by every lens -------------------------------------
  const header = (
    <>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-base-content/40 mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
            {isThisWeek ? 'This week' : 'The week of'}
          </p>
          <div className="flex items-center gap-1.5">
            <Link
              href={href({ week: dateKey(startOfLocalDay(weekStart, timeZone, -7)) })}
              className="btn btn-ghost btn-sm btn-square rounded-lg"
              aria-label="Previous week"
            >
              <ChevronLeftIcon />
            </Link>
            <h1 className="text-[1.7rem] font-extrabold leading-none tracking-tight sm:text-[2.1rem]">
              Week
            </h1>
            <Link
              href={href({ week: dateKey(startOfLocalDay(weekStart, timeZone, 7)) })}
              className="btn btn-ghost btn-sm btn-square rounded-lg"
              aria-label="Next week"
            >
              <ChevronRightIcon />
            </Link>
            {!isThisWeek ? (
              <Link href={href({ week: todayKey })} className="btn btn-ghost btn-xs rounded-lg">
                This week
              </Link>
            ) : null}
          </div>
          <p className="text-base-content/55 mt-1.5 text-sm">
            {rangeLabel}
            {view === 'board' ? ' · drag work onto the day you mean to do it' : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedNav
            current={view}
            options={[
              { value: 'board', label: 'Board', href: href({ view: 'board' }), icon: <BoardIcon /> },
              {
                value: 'calendar',
                label: 'Calendar',
                href: href({ view: 'calendar' }),
                icon: <ColumnsIcon />,
              },
              {
                value: 'agenda',
                label: 'Agenda',
                href: href({ view: 'agenda' }),
                icon: <ListIcon />,
              },
            ]}
          />

          <LoggedActionButton
            action={rebuildPlan}
            fields={{}}
            successMessage="Found times for what you committed to."
            pendingLabel="Planning…"
            className="btn btn-primary btn-sm gap-1.5 rounded-xl"
          >
            <WandIcon />
            Find the time
          </LoggedActionButton>
        </div>
      </header>
    </>
  );

  // =========================================================================
  // Board — which day work belongs to
  // =========================================================================
  if (view === 'board') {
    const [{ days, backlog }, chronic] = await Promise.all([
      caller.board.week({ weekStart }),
      caller.board.chronic({}),
    ]);

    const columns: BoardColumn[] = days.map(({ day, shape, tasks }) => {
      const key = dateKey(day);
      return {
        key,
        label: weekdayFormat.format(day),
        dayNumber: dayNumberFormat.format(day),
        isToday: key === todayKey,
        isPast: day < today,
        capacityMinutes: Math.round(shape.capacity.capacityMinutes),
        bookedMinutes: Math.round(shape.capacity.committedMinutes),
        meetingMinutes: Math.round(shape.capacity.meetingMinutes),
        isNonWorkingDay: shape.isNonWorkingDay,
        hasWorkingHours: shape.hasWorkingHours,
        tasks,
      };
    });

    // Yesterday's unfinished promises, offered rather than moved. Only when
    // yesterday is inside the week on screen, so the button never acts on a
    // day the user cannot see.
    const yesterday = startOfLocalDay(today, timeZone, -1);
    const yesterdayColumn = columns.find((column) => column.key === dateKey(yesterday));
    const stranded = yesterdayColumn?.tasks.filter((task) => task.status !== 'DONE') ?? [];

    return (
      <>
        {header}

        {stranded.length > 0 ? (
          <div className="border-base-200 bg-base-100 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-3">
            <p className="text-sm">
              <span className="font-semibold">
                {stranded.length} thing{stranded.length === 1 ? '' : 's'} from yesterday
              </span>
              <span className="text-base-content/55">
                {' '}
                didn&rsquo;t get done. That is information, not a verdict.
              </span>
            </p>
            <LoggedActionButton
              action={rolloverDay}
              fields={{ from: dateKey(yesterday), to: todayKey }}
              successMessage="Moved them to today."
              pendingLabel="Moving…"
              className="btn btn-outline btn-xs ml-auto rounded-lg"
            >
              Bring them to today
            </LoggedActionButton>
          </div>
        ) : null}

        <WeekBoard columns={columns} backlog={backlog} timeZone={timeZone} />

        {/*
          Work that never lands. The board makes this visible for the first
          time: a card carried across five columns is a different problem from
          a card that is merely late.
        */}
        {chronic.length > 0 ? (
          <div className="border-base-200 bg-base-100 mt-6 rounded-2xl border px-4 py-3.5">
            <p className="text-sm font-semibold">Carried forward a lot</p>
            <p className="text-base-content/55 mt-0.5 text-xs">
              Work that keeps moving is usually too big or too vaguely defined — rarely
              unimportant.
            </p>
            <ul className="mt-2 space-y-1">
              {chronic.map((task) => (
                <li key={task.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{task.title}</span>
                  <span className="text-base-content/50 text-xs">
                    moved {task.rolloverCount} times
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  }

  // =========================================================================
  // Calendar and Agenda — where the work actually sits
  // =========================================================================
  const [{ blocks, events }, autonomy, { connections }, routines] = await Promise.all([
    caller.plan.blocks({ from: weekStart, to: weekEnd }),
    caller.agent.autonomy(),
    caller.calendar.connections(),
    caller.routine.list(),
  ]);

  // Turned into concrete instants for just this week here, at the edge —
  // `ProtectedTimeRule` and `expandLabeledRoutines` are the scheduler's own
  // vocabulary, reused rather than re-implemented so "what routines exist"
  // can never quietly drift from "what the scheduler actually protects".
  const routineBlocks = expandLabeledRoutines(
    routines.flatMap((routine) =>
      (routine.days ?? [null]).map((dayOfWeek) => ({
        kind: 'ROUTINE' as const,
        label: routine.label,
        dayOfWeek,
        startTime: routine.startTime,
        endTime: routine.endTime,
      })),
    ),
    { start: weekStart, end: weekEnd },
    timeZone,
  );

  const linked = connections.filter((connection) => connection.status !== 'DISCONNECTED');
  const halted = linked.find((connection) => connection.status === 'NEEDS_ATTENTION');

  // Weekdays always; a weekend column only when something is actually on it.
  // Five columns are far more readable than seven, and most weeks have nothing
  // on Saturday — showing empty columns just to be symmetrical costs width.
  const gridDays = allDays.filter((day, index) => {
    if (index < 5) return true;
    return (
      blocks.some((block) => isSameLocalDay(block.startsAt, day, timeZone)) ||
      events.some((event) => isSameLocalDay(event.startsAt, day, timeZone)) ||
      routineBlocks.some((routine) => isSameLocalDay(routine.start, day, timeZone))
    );
  });

  const [startHour, endHour] = visibleHours(
    [
      ...blocks,
      ...events,
      ...routineBlocks.map((routine) => ({ startsAt: routine.start, endsAt: routine.end })),
    ],
    timeZone,
  );

  return (
    <>
      {header}

      {/*
        Says what is actually true right now. A permanent "connect a calendar"
        prompt shown to someone who already connected one is the fastest way to
        make every other message on the page unreadable.
      */}
      <Banner
        icon={<RefreshIcon />}
        lead={
          halted
            ? 'Syncing is paused.'
            : linked.length === 0
              ? 'Planner calendar ready.'
              : `Synced with ${linked[0]!.account}.`
        }
        action={{
          href: '/settings',
          label: halted ? 'See why' : linked.length === 0 ? 'Connect a calendar' : 'Manage calendars',
        }}
      >
        {halted
          ? 'Your calendar is not being updated until you have had a look at what happened.'
          : linked.length === 0
            ? 'Connect a CalDAV calendar in Settings to schedule around your real commitments, and to have these blocks appear there.'
            : 'Your events are treated as busy time, and these blocks are written back to your calendar.'}
        {autonomy.scope === 'TODAY'
          ? ' The AI is currently limited to rearranging today.'
          : ' The AI may rearrange this whole week.'}
      </Banner>

      {blocks.length === 0 && events.length === 0 && routineBlocks.length === 0 ? (
        <EmptyState
          title="Nothing scheduled this week yet."
          hint="Commit work to a day on the Board, then press “Find the time”."
        />
      ) : view === 'calendar' ? (
        /*
          One view per choice, at every width. The grid scrolls sideways on
          narrow screens rather than being replaced by the agenda — columns keep
          a readable width and you pan across the week, which is what every
          calendar app does on a phone.
        */
        <WeekGrid
          days={gridDays}
          blocks={blocks}
          events={events}
          routines={routineBlocks}
          timeZone={timeZone}
          startHour={startHour}
          totalHours={endHour - startHour}
        />
      ) : (
        <Agenda days={allDays} blocks={blocks} timeZone={timeZone} now={now} />
      )}
    </>
  );
}

/**
 * Day-grouped list.
 *
 * Not a fallback — it is the accessible equivalent of the grid, and the better
 * layout on a small screen. Absolutely-positioned columns are close to unusable
 * with a screen reader, so this stays a first-class choice rather than
 * something you are forced into by width.
 */
function Agenda({
  days,
  blocks,
  timeZone,
  now,
}: {
  days: Date[];
  blocks: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
    state: string;
    task: { title: string; project: { name: string } | null };
  }>;
  timeZone: string;
  now: Date;
}) {
  const populated = days.filter((day) =>
    blocks.some((block) => isSameLocalDay(block.startsAt, day, timeZone)),
  );

  if (populated.length === 0) {
    return <EmptyState title="Nothing scheduled this week yet." hint="Try “Find the time”." />;
  }

  return (
    <div className="space-y-3">
      {populated.map((day) => {
        const dayBlocks = blocks.filter((block) => isSameLocalDay(block.startsAt, day, timeZone));
        const isToday = isSameLocalDay(day, now, timeZone);

        return (
          <section key={day.toISOString()} className="card bg-base-100 border-base-200 border shadow-sm">
            <div className="card-body gap-0 p-0">
              <h3 className="border-base-200 flex items-center gap-2 border-b px-5 py-3 text-sm font-semibold">
                {new Intl.DateTimeFormat('en-GB', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'short',
                  timeZone,
                }).format(day)}
                {isToday ? <span className="badge badge-sm badge-primary">today</span> : null}
              </h3>

              <ul className="divide-base-200 divide-y">
                {dayBlocks.map((block) => (
                  <li key={block.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="text-base-content/45 shrink-0 font-mono text-xs">
                      {formatTime(block.startsAt, timeZone)}
                    </span>
                    <div className="min-w-0 grow">
                      <div className="truncate text-sm font-medium">{block.task.title}</div>
                      {block.task.project ? (
                        <div className="text-base-content/40 truncate text-xs">
                          {block.task.project.name}
                        </div>
                      ) : null}
                    </div>
                    {block.state === 'PROPOSED' ? (
                      <span className="badge badge-sm badge-soft badge-warning shrink-0">proposed</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })}
    </div>
  );
}
