import { localDayOfWeek, startOfLocalDay, toLocal } from '@fluid/core';
import { rebuildPlan } from '@/app/actions';
import { formatTime } from '@/components/format';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { SparkIcon } from '@/components/icons';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 21;
const HOURS = DAY_END_HOUR - DAY_START_HOUR;

/**
 * Every date calculation here runs in the *user's* timezone via `@fluid/core`,
 * never through `Date`'s local-time getters.
 *
 * Mixing the two is subtly wrong rather than obviously broken: the server's
 * local midnight is a different instant from the user's, so a block lands in
 * the neighbouring column and the weekday label disagrees with the date beside
 * it. These are the same DST-tested helpers the scheduler uses.
 */
function offsetPercent(date: Date, timeZone: string): number {
  const local = toLocal(date, timeZone);
  const minutes = local.hour * 60 + local.minute - DAY_START_HOUR * 60;
  return Math.max(0, Math.min(100, (minutes / (HOURS * 60)) * 100));
}

function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const left = toLocal(a, timeZone);
  const right = toLocal(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export default async function CalendarPage() {
  const user = await requireUser();
  const timeZone = user.timeZone;
  const caller = await getCaller();

  const now = new Date();
  const todayStart = startOfLocalDay(now, timeZone);
  const mondayOffset = -((localDayOfWeek(todayStart, timeZone) + 6) % 7);
  const weekStart = startOfLocalDay(todayStart, timeZone, mondayOffset);
  const weekEnd = startOfLocalDay(weekStart, timeZone, 7);

  const { blocks, events } = await caller.plan.blocks({ from: weekStart, to: weekEnd });
  const days = Array.from({ length: 7 }, (_, index) => startOfLocalDay(weekStart, timeZone, index));

  return (
    <>
      <PageHeader
        title="This week"
        subtitle="Solid blocks are scheduled work. Hatched are proposals waiting on you. Grey comes from your connected calendars."
        action={
          <form action={rebuildPlan}>
            <button type="submit" className="btn btn-sm btn-outline gap-1.5">
              <SparkIcon />
              Re-plan
            </button>
          </form>
        }
      />

      {/*
        The grid is desktop-only. On a phone it would be seven 40px columns of
        unreadable text, so small screens get the list below — which is the same
        data, not a degraded version of it.
      */}
      <div className="card bg-base-100 border-base-300 hidden overflow-hidden border shadow-sm lg:block">
        <div className="grid grid-cols-[3rem_repeat(7,1fr)]">
          <div className="bg-base-200 border-base-300 border-b" />
          {days.map((day) => {
            const local = toLocal(day, timeZone);
            const isToday = isSameLocalDay(day, now, timeZone);
            return (
              <div
                key={day.toISOString()}
                className={`border-base-300 border-b border-l py-2 text-center text-xs font-semibold ${
                  isToday ? 'bg-primary/10 text-primary' : 'bg-base-200'
                }`}
              >
                {new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(day)}
                <div className="text-base-content/50 font-normal">{local.day}</div>
              </div>
            );
          })}

          <div className="bg-base-200 border-base-300 relative border-r">
            {Array.from({ length: HOURS + 1 }, (_, index) => (
              <span
                key={index}
                className="text-base-content/40 absolute right-1.5 -translate-y-1/2 text-[0.65rem]"
                style={{ top: `${(index / HOURS) * 100}%` }}
              >
                {String(DAY_START_HOUR + index).padStart(2, '0')}
              </span>
            ))}
          </div>

          {days.map((day) => {
            const dayBlocks = blocks.filter((block) => isSameLocalDay(block.startsAt, day, timeZone));
            const dayEvents = events.filter((event) => isSameLocalDay(event.startsAt, day, timeZone));

            return (
              <div key={day.toISOString()} className="cal-col border-base-300 border-l">
                {Array.from({ length: HOURS + 1 }, (_, index) => (
                  <div key={index} className="cal-line" style={{ top: `${(index / HOURS) * 100}%` }} />
                ))}

                {/* External events sit underneath — context, not the plan. */}
                {dayEvents.map((event) => {
                  const top = offsetPercent(event.startsAt, timeZone);
                  const height = Math.max(2, offsetPercent(event.endsAt, timeZone) - top);
                  return (
                    <div
                      key={event.id}
                      className="cal-evt bg-base-200 border-base-300 text-base-content/70"
                      style={{ top: `${top}%`, height: `${height}%` }}
                      title={`${event.title} · ${formatTime(event.startsAt, timeZone)}`}
                    >
                      <div className="truncate font-semibold">{event.title}</div>
                    </div>
                  );
                })}

                {dayBlocks.map((block) => {
                  const top = offsetPercent(block.startsAt, timeZone);
                  const height = Math.max(2, offsetPercent(block.endsAt, timeZone) - top);
                  const proposed = block.state === 'PROPOSED';
                  return (
                    <div
                      key={block.id}
                      className={`cal-evt bg-primary/10 border-primary text-primary ${proposed ? 'cal-evt-proposed' : ''}`}
                      style={{ top: `${top}%`, height: `${height}%` }}
                      title={`${block.task.title} · ${formatTime(block.startsAt, timeZone)}–${formatTime(block.endsAt, timeZone)}`}
                    >
                      <div className="truncate font-semibold">{block.task.title}</div>
                      <div className="opacity-70">{formatTime(block.startsAt, timeZone)}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/*
        Always rendered, not hidden behind a toggle. The grid is hard to read
        with a screen reader and impossible on a phone; this is the accessible
        equivalent rather than a fallback.
      */}
      <SectionTitle>By day</SectionTitle>

      {blocks.length === 0 ? (
        <div className="card bg-base-100 border-base-300 border">
          <div className="card-body items-center py-10 text-center">
            <p className="font-medium">Nothing scheduled this week yet.</p>
            <p className="text-base-content/50 text-sm">Try “Re-plan”.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {days.map((day) => {
            const dayBlocks = blocks.filter((block) => isSameLocalDay(block.startsAt, day, timeZone));
            if (dayBlocks.length === 0) return null;
            const isToday = isSameLocalDay(day, now, timeZone);

            return (
              <section
                key={day.toISOString()}
                className="card bg-base-100 border-base-300 border shadow-sm"
              >
                <div className="card-body gap-0 p-0">
                  <h3
                    className={`border-base-200 border-b px-5 py-2.5 text-sm font-semibold ${
                      isToday ? 'text-primary' : ''
                    }`}
                  >
                    {new Intl.DateTimeFormat('en-GB', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'short',
                      timeZone,
                    }).format(day)}
                    {isToday ? <span className="badge badge-xs badge-primary ml-2">today</span> : null}
                  </h3>

                  <ul className="divide-base-200 divide-y">
                    {dayBlocks.map((block) => (
                      <li key={block.id} className="flex items-center gap-3 px-5 py-2.5">
                        <span className="text-base-content/50 shrink-0 font-mono text-xs">
                          {formatTime(block.startsAt, timeZone)}–{formatTime(block.endsAt, timeZone)}
                        </span>
                        <span className="min-w-0 grow truncate text-sm">{block.task.title}</span>
                        {block.state === 'PROPOSED' ? (
                          <span className="badge badge-xs badge-soft badge-warning">proposed</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
