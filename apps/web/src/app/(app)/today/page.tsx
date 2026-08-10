import {
  acceptPlanAction,
  acknowledgeAvoidance,
  breakdownTask,
  deferTask,
  logTime,
  rebuildPlan,
  rejectPlanAction,
} from '@/app/actions';
import { formatDay, formatDuration, formatTime, relativeDays } from '@/components/format';
import { EnergyBadge, PageHeader, SectionTitle } from '@/components/page-header';
import { SparkIcon } from '@/components/icons';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The Today screen.
 *
 * Ordered by what someone with ADHD needs first, not by what is easiest to
 * render: any decision waiting on them, then the one thing to do right now,
 * then the deadline runway, then a gentle check-in. Everything else is a tap
 * away — object permanence is served by "this is on screen now", not by
 * showing everything at once.
 */
export default async function TodayPage() {
  const user = await requireUser();
  const caller = await getCaller();
  const timeZone = user.timeZone;

  const now = new Date();
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);

  const [{ blocks }, pending, runway, avoidance] = await Promise.all([
    caller.plan.blocks({ from: now, to: dayEnd }),
    caller.plan.pending(),
    caller.plan.runway(),
    caller.task.avoidance(),
  ]);

  const current = blocks.find((block) => block.startsAt <= now && block.endsAt > now);
  const next = blocks.find((block) => block.startsAt > now);
  const focus = current ?? next;

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={formatDay(now, timeZone)}
        action={
          <form action={rebuildPlan}>
            <button type="submit" className="btn btn-sm btn-outline gap-1.5">
              <SparkIcon />
              Re-plan
            </button>
          </form>
        }
      />

      {/* --- A plan is waiting on a decision ------------------------------- */}
      {pending ? (
        <section className="card bg-base-100 border-primary/40 mb-6 border shadow-sm">
          <div className="card-body gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="card-title text-base">Your schedule changed</h2>
              <span className={`badge badge-sm ${pending.usedAi ? 'badge-secondary' : 'badge-ghost'}`}>
                {pending.usedAi ? 'with AI' : 'no AI'}
              </span>
            </div>

            <ul className="space-y-2">
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
              <form action={acceptPlanAction}>
                <input type="hidden" name="planVersionId" value={pending.id} />
                <button type="submit" className="btn btn-primary btn-sm">
                  Accept
                </button>
              </form>
              <form action={rejectPlanAction}>
                <input type="hidden" name="planVersionId" value={pending.id} />
                <button type="submit" className="btn btn-ghost btn-sm">
                  Keep what I had
                </button>
              </form>
            </div>
          </div>
        </section>
      ) : null}

      {/* --- The one thing to do now --------------------------------------- */}
      <SectionTitle>{current ? 'Right now' : 'Up next'}</SectionTitle>

      {focus ? (
        <section className="card bg-base-100 border-base-300 border shadow-sm">
          <div className="card-body gap-3">
            <div>
              <h3 className="text-lg font-semibold">{focus.task.title}</h3>
              <p className="text-base-content/60 mt-0.5 text-sm">
                {formatTime(focus.startsAt, timeZone)}–{formatTime(focus.endsAt, timeZone)}
                {focus.task.project ? ` · ${focus.task.project.name}` : ''}
                {focus.state === 'PROPOSED' ? ' · not yet accepted' : ''}
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <EnergyBadge energy={focus.task.energy} />
              <span className="badge badge-sm badge-ghost">
                {formatDuration((focus.endsAt.getTime() - focus.startsAt.getTime()) / 60_000)}
              </span>
            </div>

            {/*
              "Just start": a five-minute version with nothing attached.
              Initiation is the barrier, so the offer has to be smaller than the
              resistance to it — and it must be the biggest button on the screen.
            */}
            <div className="card-actions mt-1 flex-col gap-2 sm:flex-row">
              <form action={logTime} className="w-full sm:w-auto">
                <input type="hidden" name="id" value={focus.task.id} />
                <input type="hidden" name="minutes" value="5" />
                <button type="submit" className="btn btn-primary w-full sm:w-auto">
                  Just start — 5 minutes
                </button>
              </form>
              <form action={breakdownTask} className="w-full sm:w-auto">
                <input type="hidden" name="id" value={focus.task.id} />
                <input type="hidden" name="granularity" value="tiny" />
                <button type="submit" className="btn btn-outline btn-sm w-full sm:w-auto">
                  Too big — break it down
                </button>
              </form>
              <form action={deferTask} className="w-full sm:w-auto">
                <input type="hidden" name="id" value={focus.task.id} />
                <input type="hidden" name="days" value="1" />
                <button type="submit" className="btn btn-ghost btn-sm w-full sm:w-auto">
                  Not today
                </button>
              </form>
            </div>
          </div>
        </section>
      ) : (
        <div className="card bg-base-100 border-base-300 border">
          <div className="card-body items-center py-10 text-center">
            <p className="font-medium">Nothing scheduled for the rest of today.</p>
            <p className="text-base-content/50 text-sm">That is allowed.</p>
          </div>
        </div>
      )}

      {/* --- Deadline runway ------------------------------------------------ */}
      {runway.length > 0 ? (
        <>
          <SectionTitle>Runway</SectionTitle>
          <div className="card bg-base-100 border-base-300 border shadow-sm">
            <div className="card-body gap-4">
              <p className="text-base-content/50 text-xs">
                Work sessions actually booked before each deadline — not days on a calendar.
              </p>

              {runway.map((item) => {
                const short = item.shortfallMinutes > 0;
                return (
                  <div key={item.taskId} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.title}</div>

                      {/* Sessions as pips: countable at a glance, which is the point. */}
                      <div className="mt-1.5 flex items-center gap-1" aria-hidden="true">
                        {Array.from({ length: Math.min(8, item.sessionsBeforeDeadline) }).map(
                          (_, index) => (
                            <span
                              key={index}
                              className={`h-2 w-6 rounded-sm ${short ? 'bg-error' : 'bg-success'}`}
                            />
                          ),
                        )}
                        {item.sessionsBeforeDeadline === 0 ? (
                          <>
                            <span className="border-base-300 h-2 w-6 rounded-sm border border-dashed" />
                            <span className="border-base-300 h-2 w-6 rounded-sm border border-dashed" />
                          </>
                        ) : null}
                      </div>

                      <p className="text-base-content/50 mt-1 text-xs">
                        {item.sessionsBeforeDeadline === 0
                          ? `No sessions booked before this is due ${relativeDays(item.deadline)}.`
                          : `${item.sessionsBeforeDeadline} session${
                              item.sessionsBeforeDeadline === 1 ? '' : 's'
                            } booked · due ${relativeDays(item.deadline)}`}
                        {short ? ` · ${formatDuration(item.shortfallMinutes)} still needs a slot` : ''}
                      </p>
                    </div>

                    <span className={`badge badge-sm badge-soft shrink-0 ${short ? 'badge-error' : 'badge-success'}`}>
                      {short ? 'short' : 'on track'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : null}

      {/* --- Avoidance check-in --------------------------------------------- */}
      {avoidance.length > 0 ? (
        <>
          <SectionTitle>Worth a look</SectionTitle>
          <div className="space-y-3">
            {avoidance.map((task) => (
              <section key={task.id} className="card bg-base-100 border-base-300 border shadow-sm">
                <div className="card-body gap-2">
                  <h3 className="font-semibold">{task.title}</h3>

                  {/*
                    Neutral phrasing is the product requirement: state the fact,
                    offer options, never imply it should have been done already.
                  */}
                  <p className="text-base-content/70 text-sm">
                    {task.rescheduleCount >= 3
                      ? `This has moved ${task.rescheduleCount} times. That usually means it is too big or too vague — rarely that it is unimportant.`
                      : `This has not been touched since ${relativeDays(task.lastTouchedAt)}.`}
                  </p>

                  <div className="card-actions">
                    <form action={breakdownTask}>
                      <input type="hidden" name="id" value={task.id} />
                      <input type="hidden" name="granularity" value="tiny" />
                      <button type="submit" className="btn btn-outline btn-sm">
                        Shrink it
                      </button>
                    </form>
                    <form action={acknowledgeAvoidance}>
                      <input type="hidden" name="id" value={task.id} />
                      <button type="submit" className="btn btn-ghost btn-sm">
                        Leave it for now
                      </button>
                    </form>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </>
      ) : null}

      {/* --- The rest of today ---------------------------------------------- */}
      {blocks.length > 1 ? (
        <>
          <SectionTitle>Rest of today</SectionTitle>
          <ul className="card bg-base-100 border-base-300 divide-base-200 divide-y border shadow-sm">
            {blocks
              .filter((block) => block.id !== focus?.id)
              .map((block) => (
                <li key={block.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="text-base-content/50 w-12 shrink-0 font-mono text-xs">
                    {formatTime(block.startsAt, timeZone)}
                  </span>
                  <span className="min-w-0 grow truncate text-sm font-medium">
                    {block.task.title}
                  </span>
                  <EnergyBadge energy={block.task.energy} />
                  {block.state === 'PROPOSED' ? (
                    <span className="badge badge-sm badge-soft badge-warning">proposed</span>
                  ) : null}
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
