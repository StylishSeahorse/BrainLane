'use client';

/**
 * Adding a recurring routine — brush teeth, lunch, the commute.
 *
 * A client component only because picking which days needs interactive
 * toggle state; the actual write goes through `createRoutine`, a plain
 * server action called directly (not a `<form action>`) so the day list — an
 * array, awkward to carry through `FormData` — can be sent as what it is.
 */
import { useState, useTransition } from 'react';
import { createRoutine } from '@/app/actions';
import { logAction } from '@/components/action-log';

interface Preset {
  label: string;
  startTime: string;
  endTime: string;
  /** 'weekdays' picks Mon–Fri; 'every' leaves the day list empty (every day). */
  days: 'every' | 'weekdays';
}

const PRESETS: Preset[] = [
  { label: 'Brush teeth (morning)', startTime: '07:00', endTime: '07:10', days: 'every' },
  { label: 'Brush teeth (night)', startTime: '21:30', endTime: '21:40', days: 'every' },
  { label: 'Lunch', startTime: '12:00', endTime: '13:00', days: 'weekdays' },
  { label: 'Dinner', startTime: '18:30', endTime: '19:15', days: 'every' },
  { label: 'Commute', startTime: '08:15', endTime: '08:45', days: 'weekdays' },
  { label: 'Exercise', startTime: '17:30', endTime: '18:15', days: 'weekdays' },
  { label: 'Wind down', startTime: '21:00', endTime: '21:30', days: 'every' },
  { label: 'Sleep', startTime: '23:00', endTime: '06:30', days: 'every' },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function RoutineForm() {
  const [label, setLabel] = useState('');
  const [startTime, setStartTime] = useState('07:00');
  const [endTime, setEndTime] = useState('07:15');
  // Empty means every day — matches how the router (and the scheduler
  // underneath it) already reads an absent day list.
  const [days, setDays] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const applyPreset = (preset: Preset) => {
    setLabel(preset.label);
    setStartTime(preset.startTime);
    setEndTime(preset.endTime);
    setDays(preset.days === 'weekdays' ? WEEKDAYS : []);
    setError(null);
  };

  const toggleDay = (day: number) => {
    setDays((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort(),
    );
  };

  const submit = () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Give it a name.');
      return;
    }

    startTransition(async () => {
      const result = await createRoutine({ label: trimmed, startTime, endTime, days });
      if (result.error) {
        setError(result.error);
        logAction(result.error, 'error');
        return;
      }
      setError(null);
      logAction(`Added "${trimmed}" to your routine.`, 'success');
      setLabel('');
      setDays([]);
    });
  };

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="btn btn-outline btn-xs rounded-full"
              onClick={() => applyPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Name</legend>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Lunch"
              maxLength={60}
              className="input w-full"
            />
          </fieldset>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Start</legend>
            <input
              type="time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              className="input"
            />
          </fieldset>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">End</legend>
            <input
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className="input"
            />
          </fieldset>
        </div>

        <div>
          <p className="label mb-1 text-xs">Which days</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={`btn btn-xs rounded-full ${days.length === 0 ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setDays([])}
            >
              Every day
            </button>
            {DAY_LABELS.map((name, index) => (
              <button
                key={name}
                type="button"
                className={`btn btn-xs rounded-full ${days.includes(index) ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => toggleDay(index)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div role="alert" className="alert alert-error alert-soft text-sm">
            <span>{error}</span>
          </div>
        ) : null}

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl"
            onClick={submit}
            disabled={pending}
          >
            {pending ? 'Adding…' : 'Add routine'}
          </button>
        </div>
      </div>
    </div>
  );
}
