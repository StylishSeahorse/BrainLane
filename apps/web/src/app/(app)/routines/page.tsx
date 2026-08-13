import { deleteRoutine } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { EmptyState, PageHeader, SectionTitle } from '@/components/page-header';
import { RoutineForm } from '@/components/routine-form';
import { requireUser } from '@/server/auth/session';
import { getCaller } from '@/server/caller';

export const dynamic = 'force-dynamic';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function daysLabel(days: number[] | null): string {
  if (days === null) return 'Every day';
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return 'Weekdays';
  if (days.length === 2 && [0, 6].every((day) => days.includes(day))) return 'Weekends';
  return days.map((day) => DAY_NAMES[day]).join(', ');
}

function durationLabel(startTime: string, endTime: string): string {
  const [startHour = 0, startMinute = 0] = startTime.split(':').map(Number);
  const [endHour = 0, endMinute = 0] = endTime.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  // An end at or before the start crosses midnight, which the scheduler
  // already understands — a 23:00–06:30 sleep block is 7h30m, not negative.
  const minutes = end > start ? end - start : 1440 - start + end;

  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Routines — the recurring life a schedule has to fit around.
 *
 * Its own page rather than a section of the calendar: this is settings-shaped
 * work you do once and revisit rarely, and it was competing for attention
 * with the thing the calendar is actually for.
 */
export default async function RoutinesPage() {
  await requireUser();
  const caller = await getCaller();
  const routines = await caller.routine.list();

  return (
    <>
      <PageHeader
        eyebrow="Recurring life"
        title="Routines"
        subtitle="Meals, sleep, the commute — the scheduler works around these the same way it works around a real meeting."
      />

      {routines.length === 0 ? (
        <EmptyState
          title="No routines yet."
          hint="Add the fixed points of your day and nothing will get scheduled over them."
        />
      ) : (
        <ul className="card bg-base-100 border-base-200 divide-base-200 divide-y border shadow-sm">
          {routines.map((routine) => (
            <li key={routine.groupId} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="truncate font-medium">{routine.label}</div>
                <p className="text-base-content/50 text-xs">
                  {daysLabel(routine.days)} · {routine.startTime}–{routine.endTime} ·{' '}
                  {durationLabel(routine.startTime, routine.endTime)}
                </p>
              </div>
              <LoggedActionButton
                action={deleteRoutine}
                fields={{ groupId: routine.groupId }}
                successMessage={`Removed "${routine.label}" from your routine.`}
                pendingLabel="Removing…"
                className="btn btn-ghost btn-xs text-error shrink-0 rounded-lg"
              >
                Remove
              </LoggedActionButton>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Add a routine</SectionTitle>
      <RoutineForm />
    </>
  );
}
