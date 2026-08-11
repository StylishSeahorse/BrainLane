import { localDayOfWeek, startOfLocalDay, toLocal } from '@fluid/core';
import { rebuildPlan } from '@/app/actions';
import { formatTime } from '@/components/format';
import {
  Banner,
  EmptyState,
  PageHeader,
  SegmentedNav,
} from '@/components/page-header';
import { ColumnsIcon, ListIcon, RefreshIcon, WandIcon } from '@/components/icons';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/** Fallback window. Widened below if anything actually falls outside it. */
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

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await requireUser();
  const timeZone = user.timeZone;
  const caller = await getCaller();
  const view = (await searchParams).view === 'agenda' ? 'agenda' : 'week';

  const now = new Date();
  const todayStart = startOfLocalDay(now, timeZone);
  const mondayOffset = -((localDayOfWeek(todayStart, timeZone) + 6) % 7);
  const weekStart = startOfLocalDay(todayStart, timeZone, mondayOffset);
  const weekEnd = startOfLocalDay(weekStart, timeZone, 7);

  const { blocks, events } = await caller.plan.blocks({ from: weekStart, to: weekEnd });
  const autonomy = await caller.agent.autonomy();
  const { connections } = await caller.calendar.connections();

  const linked = connections.filter((connection) => connection.status !== 'DISCONNECTED');
  const halted = linked.find((connection) => connection.status === 'NEEDS_ATTENTION');

  const allDays = Array.from({ length: 7 }, (_, index) => startOfLocalDay(weekStart, timeZone, index));

  // Weekdays always; a weekend column only when something is actually on it.
  // Five columns are far more readable than seven, and most weeks have nothing
  // on Saturday — showing empty columns just to be symmetrical costs width.
  const days = allDays.filter((day, index) => {
    if (index < 5) return true;
    return (
      blocks.some((block) => isSameLocalDay(block.startsAt, day, timeZone)) ||
      events.some((event) => isSameLocalDay(event.startsAt, day, timeZone))
    );
  });

  const [startHour, endHour] = visibleHours([...blocks, ...events], timeZone);
  const totalHours = endHour - startHour;

  const offsetPercent = (date: Date): number => {
    const local = toLocal(date, timeZone);
    const minutes = local.hour * 60 + local.minute - startHour * 60;
    return Math.max(0, Math.min(100, (minutes / (totalHours * 60)) * 100));
  };

  const hourLabels = Array.from({ length: totalHours + 1 }, (_, index) => startHour + index).filter(
    (hour) => (hour - startHour) % 2 === 0,
  );

  const formatHour = (hour: number) =>
    `${((hour + 11) % 12) + 1} ${hour < 12 || hour === 24 ? 'AM' : 'PM'}`;

  return (
    <>
      <PageHeader
        eyebrow="Your week"
        title="Calendar"
        action={
          <>
            <SegmentedNav
              current={view}
              options={[
                { value: 'week', label: 'Week', href: '/calendar', icon: <ColumnsIcon /> },
                { value: 'agenda', label: 'Agenda', href: '/calendar?view=agenda', icon: <ListIcon /> },
              ]}
            />
            <form action={rebuildPlan}>
              <button type="submit" className="btn btn-primary gap-2 rounded-xl">
                <WandIcon />
                Plan my week
              </button>
            </form>
          </>
        }
      />

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

      {blocks.length === 0 && events.length === 0 ? (
        <EmptyState
          title="Nothing scheduled this week yet."
          hint="Add a few tasks, then press “Plan my week”."
        />
      ) : view === 'week' ? (
        <>
          {/* The grid is desktop-only: on a phone these become unreadable slivers. */}
          <div className="card bg-base-100 border-base-200 hidden overflow-hidden border shadow-sm lg:block">
            <div
              className="grid"
              style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}
            >
              <div className="border-base-200 border-b" />
              {days.map((day) => {
                const local = toLocal(day, timeZone);
                const isToday = isSameLocalDay(day, now, timeZone);
                return (
                  <div
                    key={day.toISOString()}
                    className="border-base-200 border-b border-l py-4 text-center"
                  >
                    <div
                      className={`text-[0.65rem] font-semibold uppercase tracking-[0.12em] ${
                        isToday ? 'text-primary' : 'text-base-content/40'
                      }`}
                    >
                      {new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(day)}
                    </div>
                    <div
                      className={`mt-1 text-2xl font-bold tracking-tight ${
                        isToday ? 'text-primary' : ''
                      }`}
                    >
                      {local.day}
                    </div>
                  </div>
                );
              })}

              <div className="relative" style={{ height: `${totalHours * 4}rem` }}>
                {hourLabels.map((hour) => (
                  <span
                    key={hour}
                    className="text-base-content/35 absolute right-2.5 -translate-y-1/2 text-[0.65rem] font-medium"
                    style={{ top: `${((hour - startHour) / totalHours) * 100}%` }}
                  >
                    {formatHour(hour)}
                  </span>
                ))}
              </div>

              {days.map((day) => {
                const dayBlocks = blocks.filter((block) =>
                  isSameLocalDay(block.startsAt, day, timeZone),
                );
                const dayEvents = events.filter((event) =>
                  isSameLocalDay(event.startsAt, day, timeZone),
                );

                return (
                  <div
                    key={day.toISOString()}
                    className="cal-col border-base-200 border-l"
                    style={{ height: `${totalHours * 4}rem` }}
                  >
                    {Array.from({ length: totalHours + 1 }, (_, index) => (
                      <div
                        key={index}
                        className="cal-line"
                        style={{ top: `${(index / totalHours) * 100}%` }}
                      />
                    ))}

                    {dayEvents.map((event) => {
                      const top = offsetPercent(event.startsAt);
                      const height = Math.max(3, offsetPercent(event.endsAt) - top);
                      return (
                        <div
                          key={event.id}
                          className="cal-evt cal-evt-external"
                          style={{ top: `${top}%`, height: `${height}%` }}
                          title={`${event.title} · ${formatTime(event.startsAt, timeZone)}`}
                        >
                          <div className="text-base-content/50 text-[0.62rem]">
                            {formatTime(event.startsAt, timeZone)}
                          </div>
                          <div className="text-base-content/80 truncate font-semibold">
                            {event.title}
                          </div>
                        </div>
                      );
                    })}

                    {dayBlocks.map((block) => {
                      const top = offsetPercent(block.startsAt);
                      const height = Math.max(3, offsetPercent(block.endsAt) - top);
                      const proposed = block.state === 'PROPOSED';
                      return (
                        <div
                          key={block.id}
                          className={`cal-evt ${proposed ? 'cal-evt-proposed' : ''}`}
                          style={{ top: `${top}%`, height: `${height}%` }}
                          title={`${block.task.title} · ${formatTime(block.startsAt, timeZone)}–${formatTime(block.endsAt, timeZone)}`}
                        >
                          <div className="text-primary/70 text-[0.62rem]">
                            {formatTime(block.startsAt, timeZone)}
                          </div>
                          <div className="line-clamp-2 font-semibold">{block.task.title}</div>
                          <div className="text-base-content/40 mt-0.5 text-[0.6rem]">
                            {proposed ? 'Awaiting your OK' : 'AI task block'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Phones get the agenda instead — same data, not a degraded grid. */}
          <div className="lg:hidden">
            <Agenda
              days={allDays}
              blocks={blocks}
              timeZone={timeZone}
              now={now}
              isSameLocalDay={isSameLocalDay}
            />
          </div>
        </>
      ) : (
        <Agenda
          days={allDays}
          blocks={blocks}
          timeZone={timeZone}
          now={now}
          isSameLocalDay={isSameLocalDay}
        />
      )}
    </>
  );
}

/**
 * Day-grouped list.
 *
 * Not a fallback — it is the accessible equivalent of the grid, and the only
 * sensible layout on a phone. Absolutely-positioned columns are close to
 * unusable with a screen reader.
 */
function Agenda({
  days,
  blocks,
  timeZone,
  now,
  isSameLocalDay,
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
  isSameLocalDay: (a: Date, b: Date, timeZone: string) => boolean;
}) {
  const populated = days.filter((day) =>
    blocks.some((block) => isSameLocalDay(block.startsAt, day, timeZone)),
  );

  if (populated.length === 0) {
    return <EmptyState title="Nothing scheduled this week yet." hint="Try “Plan my week”." />;
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
