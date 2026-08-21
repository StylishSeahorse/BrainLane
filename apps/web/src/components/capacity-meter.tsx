import type { Capacity, LoadVerdict } from '@fluid/core';
import { formatDuration } from '@/components/format';

/**
 * How big the day is, and how much of it is spoken for.
 *
 * The bar is the argument: a task list can grow forever, a Tuesday cannot.
 * Meetings and routines are drawn as part of the same bar rather than
 * subtracted invisibly, so "I have no time this week" stops being a feeling
 * and becomes something with a cause you can point at.
 *
 * Overcommitment is stated plainly and never auto-corrected. Being told while
 * there is still time to choose is the whole value; the tool quietly dropping
 * something to make the numbers work would be a betrayal of that.
 */

const VERDICT_COPY: Record<LoadVerdict, { label: string; tone: string }> = {
  empty: { label: 'Nothing booked', tone: 'text-base-content/50' },
  light: { label: 'Room to spare', tone: 'text-success' },
  balanced: { label: 'Looks doable', tone: 'text-success' },
  full: { label: 'Full day', tone: 'text-warning' },
  over: { label: 'More than fits', tone: 'text-error' },
};

export function CapacityMeter({
  capacity,
  verdict,
  isNonWorkingDay,
  hasWorkingHours,
}: {
  capacity: Capacity;
  verdict: LoadVerdict;
  isNonWorkingDay: boolean;
  hasWorkingHours: boolean;
}) {
  // Without working hours there is no denominator, and a meter with an
  // invented one would be worse than none: it would quietly imply the app
  // knows something about the day that it does not.
  if (!hasWorkingHours) {
    return (
      <div className="border-base-200 bg-base-100 rounded-2xl border px-4 py-3 text-sm">
        <span className="text-base-content/60">
          Set your working hours in Settings and this becomes a real capacity check —
          how much of the day is actually left, not just how many tasks are on it.
        </span>
      </div>
    );
  }

  if (isNonWorkingDay) {
    return (
      <div className="border-base-200 bg-base-100 rounded-2xl border px-4 py-3 text-sm">
        <span className="font-medium">Not a working day.</span>{' '}
        <span className="text-base-content/60">
          {capacity.committedMinutes > 0
            ? `${formatDuration(capacity.committedMinutes)} is scheduled anyway — that is allowed, just not planned for.`
            : 'Nothing is expected of you today.'}
        </span>
      </div>
    );
  }

  const copy = VERDICT_COPY[verdict];
  const total = Math.max(capacity.workableMinutes, 1);
  const pct = (minutes: number) => `${Math.min(100, (minutes / total) * 100)}%`;

  return (
    <div className="border-base-200 bg-base-100 rounded-2xl border px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={`text-sm font-semibold ${copy.tone}`}>{copy.label}</span>
        <span className="text-base-content/55 text-xs">
          {formatDuration(capacity.committedMinutes)} planned of{' '}
          {formatDuration(capacity.capacityMinutes)} free
        </span>
      </div>

      {/*
        One bar, three materials: meetings and routines first because they are
        not negotiable, then the work that was chosen on top of them.
      */}
      <div
        className="bg-base-200 mt-2 flex h-2.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`${formatDuration(capacity.committedMinutes)} of work planned against ${formatDuration(
          capacity.capacityMinutes,
        )} of free time, in a ${formatDuration(capacity.workableMinutes)} working day`}
      >
        {capacity.meetingMinutes > 0 ? (
          <span className="bg-base-content/30 h-full" style={{ width: pct(capacity.meetingMinutes) }} />
        ) : null}
        {capacity.protectedMinutes > 0 ? (
          <span className="bg-base-content/15 h-full" style={{ width: pct(capacity.protectedMinutes) }} />
        ) : null}
        {/*
          Personal time sits with meetings and routines rather than with work,
          because that is exactly what it is here: time the day has lost, not
          work the day owes.
        */}
        {capacity.personalMinutes > 0 ? (
          <span className="bg-secondary/40 h-full" style={{ width: pct(capacity.personalMinutes) }} />
        ) : null}
        <span
          className={`h-full ${verdict === 'over' ? 'bg-error' : 'bg-primary'}`}
          style={{ width: pct(capacity.committedMinutes) }}
        />
      </div>

      <div className="text-base-content/45 mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.7rem]">
        {capacity.meetingMinutes > 0 ? <span>{formatDuration(capacity.meetingMinutes)} meetings</span> : null}
        {capacity.protectedMinutes > 0 ? (
          <span>{formatDuration(capacity.protectedMinutes)} routines</span>
        ) : null}
        {capacity.personalMinutes > 0 ? (
          <span>{formatDuration(capacity.personalMinutes)} personal</span>
        ) : null}
        {capacity.bufferMinutes > 0 ? (
          <span>{formatDuration(capacity.bufferMinutes)} transitions</span>
        ) : null}
        {capacity.completedMinutes > 0 ? (
          <span className="text-success">{formatDuration(capacity.completedMinutes)} done</span>
        ) : null}
      </div>

      {verdict === 'over' ? (
        <p className="text-error mt-2 text-sm">
          That is {formatDuration(capacity.overcommittedMinutes)} more than the day holds. Nothing
          has been dropped — worth moving something before the day decides for you.
        </p>
      ) : null}
    </div>
  );
}
