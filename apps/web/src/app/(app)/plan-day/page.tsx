import Link from 'next/link';
import { startOfLocalDay, toLocal } from '@fluid/core';
import { DailyPlan } from '@/components/daily-plan';
import { formatDay } from '@/components/format';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The morning ritual, on its own screen.
 *
 * A route rather than a modal on Today, for two reasons. It survives a
 * refresh and can be linked to — which matters when the ritual is the thing
 * you are trying to build a habit around — and it gets the rest of the app out
 * of the way while the one question on it is answered.
 */
export default async function PlanDayPage() {
  const user = await requireUser();
  const caller = await getCaller();
  const timeZone = user.timeZone;

  const today = startOfLocalDay(new Date(), timeZone);
  const context = await caller.day.planning({ day: today });

  const dateKey = (date: Date): string => {
    const local = toLocal(date, timeZone);
    return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  };

  return (
    <>
      <header className="mb-6 text-center">
        <p className="text-base-content/40 mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
          {formatDay(today, timeZone)}
        </p>
        <h1 className="text-[1.7rem] font-extrabold leading-none tracking-tight sm:text-[2.1rem]">
          Plan your day
        </h1>
        <p className="text-base-content/55 mx-auto mt-2 max-w-md text-sm">
          {context.alreadyPlannedAt
            ? 'You have already done this today. Running it again is fine — nothing is lost.'
            : 'Five minutes now, and the rest of the day stops being a series of decisions.'}
        </p>
      </header>

      <DailyPlan
        dayKey={dateKey(today)}
        yesterdayKey={dateKey(startOfLocalDay(today, timeZone, -1))}
        yesterday={context.yesterday}
        completedYesterday={context.completedYesterday}
        today={context.today}
        backlog={context.backlog}
        meetings={context.meetings}
        capacityMinutes={Math.round(context.shape.capacity.capacityMinutes)}
        hasWorkingHours={context.shape.hasWorkingHours}
        isNonWorkingDay={context.shape.isNonWorkingDay}
        timeZone={timeZone}
      />

      <p className="text-base-content/35 mt-6 text-center text-xs">
        <Link href="/today" className="link">
          Skip and go straight to today
        </Link>
      </p>
    </>
  );
}
