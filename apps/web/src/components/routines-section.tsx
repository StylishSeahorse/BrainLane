import { deleteRoutine } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { RoutineForm } from '@/components/routine-form';

/**
 * Routines — the recurring life a schedule has to fit around.
 *
 * Meals, sleep, the school run: time the scheduler may never allocate. It was
 * its own sidebar entry, which overstated it — this is configuration you set
 * once and revisit rarely, so it belongs beside the other settings rather than
 * competing for attention with the screens used every day.
 *
 * Extracted as a component rather than inlined into the settings page so the
 * page stays a readable list of sections.
 */

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

export interface RoutineRow {
  groupId: string;
  label: string;
  days: number[] | null;
  startTime: string;
  endTime: string;
}

export function RoutinesSection({ routines }: { routines: RoutineRow[] }) {
  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <p className="text-base-content/55 text-sm">
          Meals, sleep, the commute — the scheduler works around these exactly the way it works
          around a real meeting. Nothing is ever booked over them.
        </p>

        {routines.length === 0 ? (
          <p className="text-base-content/45 text-sm">
            None yet. Add the fixed points of your day and nothing will get scheduled on top of
            them.
          </p>
        ) : (
          <ul className="divide-base-200 divide-y">
            {routines.map((routine) => (
              <li key={routine.groupId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{routine.label}</div>
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

        <div className="border-base-200 border-t pt-4">
          <RoutineForm />
        </div>
      </div>
    </div>
  );
}
