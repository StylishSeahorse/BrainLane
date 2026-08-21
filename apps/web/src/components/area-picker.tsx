'use client';

/**
 * Which context a task belongs to.
 *
 * A select rather than a colour swatch grid: the choice is rarely made and
 * almost never changed, so it should be legible and out of the way rather than
 * eye-catching. The colour dot beside it is the payoff — once set, the context
 * is readable everywhere else without reading anything.
 */

import { useTransition } from 'react';
import { assignTaskArea } from '@/app/actions';
import { logAction } from '@/components/action-log';

export interface AreaOption {
  id: string;
  name: string;
  color: string | null;
  countsTowardCapacity: boolean;
}

const NONE = '';

export function AreaPicker({
  taskId,
  current,
  areas,
}: {
  taskId: string;
  current: string | null;
  areas: AreaOption[];
}) {
  const [pending, startTransition] = useTransition();

  // Nothing to choose between. Rendering a one-option select would imply a
  // decision exists where none does.
  if (areas.length === 0) return null;

  const selected = areas.find((area) => area.id === current);

  return (
    <span className="inline-flex items-center gap-1.5">
      {selected?.color ? (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: selected.color }}
          aria-hidden="true"
        />
      ) : null}

      <select
        className="select select-xs w-auto rounded-lg"
        value={current ?? NONE}
        disabled={pending}
        aria-label="Which area this belongs to"
        onChange={(event) => {
          const next = event.target.value === NONE ? null : event.target.value;
          startTransition(async () => {
            const result = await assignTaskArea(taskId, next);
            const name = areas.find((area) => area.id === next)?.name;
            logAction(
              result.error ?? (name ? `Filed under ${name}.` : 'Removed from its area.'),
              result.error ? 'error' : 'success',
            );
          });
        }}
      >
        <option value={NONE}>No area</option>
        {areas.map((area) => (
          <option key={area.id} value={area.id}>
            {area.name}
            {area.countsTowardCapacity ? '' : ' (not work)'}
          </option>
        ))}
      </select>
    </span>
  );
}
