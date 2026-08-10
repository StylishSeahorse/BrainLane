import { prisma } from '@fluid/db';
import { formatDuration } from '@/components/format';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Weekly review.
 *
 * The hard rule is no shame metrics: no streaks, no completion percentage, no
 * red for "behind". Patterns and adjustments only. A review screen that makes
 * someone feel bad is one they stop opening, and then the whole feedback loop
 * is gone.
 */
export default async function ReviewPage() {
  const user = await requireUser();
  const caller = await getCaller();

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [accuracy, completed, moved, workingMinutes] = await Promise.all([
    caller.plan.estimateAccuracy(),
    prisma.task.count({
      where: { userId: user.id, status: 'DONE', completedAt: { gte: weekAgo } },
    }),
    prisma.task.count({
      where: {
        userId: user.id,
        rescheduleCount: { gte: 1 },
        lastTouchedAt: { gte: weekAgo },
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
    }),
    weeklyWorkingMinutes(user.id),
  ]);

  return (
    <>
      <PageHeader eyebrow="Last seven days"
        title="Review" subtitle="The last seven days, as patterns rather than a score." />

      <div className="stats stats-vertical bg-base-100 border-base-200 w-full border shadow-sm sm:stats-horizontal">
        <div className="stat">
          <div className="stat-title">Finished</div>
          <div className="stat-value text-3xl">{completed}</div>
          <div className="stat-desc">in the last week</div>
        </div>
        <div className="stat">
          <div className="stat-title">Moved at least once</div>
          <div className="stat-value text-3xl">{moved}</div>
          <div className="stat-desc">usually means too big, not unimportant</div>
        </div>
        <div className="stat">
          <div className="stat-title">Working hours</div>
          <div className="stat-value text-3xl">{formatDuration(workingMinutes)}</div>
          <div className="stat-desc">before meetings and breaks</div>
        </div>
      </div>

      <SectionTitle>How your estimates are landing</SectionTitle>

      <div className="card bg-base-100 border-base-200 border shadow-sm">
        <div className="card-body gap-4">
          {accuracy.sampleCount === 0 ? (
            <div className="py-6 text-center">
              <p className="font-medium">Nothing to compare yet.</p>
              <p className="text-base-content/50 mt-1 text-sm">
                Estimates start to tune themselves once a few tasks have been finished with time
                logged against them.
              </p>
            </div>
          ) : (
            <>
              <p className="text-base-content/50 text-xs">
                Based on your last {accuracy.sampleCount} finished task
                {accuracy.sampleCount === 1 ? '' : 's'}.
              </p>

              {accuracy.byCategory.map((entry) => {
                const percent = Math.round((entry.ratio - 1) * 100);
                const under = percent > 10;
                return (
                  <div key={entry.category} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium capitalize">{entry.category}</div>
                      <p className="text-base-content/50 text-xs">
                        {under
                          ? `Takes about ${percent}% longer than you expect. Worth padding these by default.`
                          : percent < -10
                            ? `Finishes about ${Math.abs(percent)}% faster than you expect.`
                            : 'About right.'}
                      </p>
                    </div>
                    <span
                      className={`badge badge-sm badge-soft shrink-0 font-mono ${
                        under ? 'badge-warning' : 'badge-success'
                      }`}
                    >
                      ×{entry.ratio.toFixed(2)}
                    </span>
                  </div>
                );
              })}

              <p className="text-base-content/60 text-sm">
                Underestimating is close to universal, and it is a calibration problem rather than a
                character one. These figures adjust future suggestions automatically.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}

async function weeklyWorkingMinutes(userId: string): Promise<number> {
  const hours = await prisma.workingHours.findMany({ where: { userId } });
  return hours.reduce((sum, entry) => {
    const [startHour = 0, startMinute = 0] = entry.startTime.split(':').map(Number);
    const [endHour = 0, endMinute = 0] = entry.endTime.split(':').map(Number);
    return sum + (endHour * 60 + endMinute - (startHour * 60 + startMinute));
  }, 0);
}
