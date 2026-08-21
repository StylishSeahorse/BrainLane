'use client';

/**
 * Managing contexts.
 *
 * The screen is mostly one switch: does time in this area count as work the
 * day owes, or as time the day has simply lost? Everything else here is a name
 * and a colour.
 *
 * That switch is explained in place rather than in a help article, because it
 * changes the capacity numbers on three other screens and a setting whose
 * effect is invisible is one people flip once and then mistrust forever.
 */

import { useActionState, useState, useTransition } from 'react';
import { createArea, deleteArea, updateArea } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { ConfirmButton } from '@/components/confirm-button';
import { PlusIcon } from '@/components/icons';

export interface AreaRow {
  id: string;
  name: string;
  color: string | null;
  countsTowardCapacity: boolean;
  _count: { tasks: number; projects: number };
}

/** Distinct at a glance, and legible against the card background. */
const SUGGESTED = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7'];

export function Areas({ areas }: { areas: AreaRow[] }) {
  const [state, formAction, pending] = useActionState(createArea, undefined);
  const [color, setColor] = useState(SUGGESTED[areas.length % SUGGESTED.length]!);

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        {areas.length === 0 ? (
          <p className="text-base-content/55 text-sm">
            No areas yet. They are optional — add one when work starts coming from two
            different parts of your life and the capacity meter stops making sense.
          </p>
        ) : (
          <ul className="divide-base-200 divide-y">
            {areas.map((area) => (
              <AreaItem key={area.id} area={area} />
            ))}
          </ul>
        )}

        {/* --- New area ---------------------------------------------------- */}
        <form action={formAction} className="border-base-200 flex flex-wrap items-end gap-2 border-t pt-4">
          <div className="grow">
            <label className="label py-1" htmlFor="area-name">
              <span className="label-text text-xs font-medium">New area</span>
            </label>
            <input
              id="area-name"
              name="name"
              required
              maxLength={40}
              placeholder="Work, Personal, the band…"
              className="input input-sm input-bordered w-full rounded-lg"
            />
          </div>

          <div>
            <label className="label py-1" htmlFor="area-color">
              <span className="label-text text-xs font-medium">Colour</span>
            </label>
            <input
              id="area-color"
              name="color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="h-8 w-12 cursor-pointer rounded-lg border-0 bg-transparent p-0"
              aria-label="Area colour"
            />
          </div>

          <label className="label cursor-pointer gap-2 pb-1.5">
            <input
              type="checkbox"
              name="countsTowardCapacity"
              defaultChecked
              className="checkbox checkbox-sm"
            />
            <span className="label-text text-xs">Counts as work</span>
          </label>

          <button type="submit" disabled={pending} className="btn btn-primary btn-sm gap-1 rounded-lg">
            <PlusIcon />
            {pending ? 'Adding…' : 'Add'}
          </button>
        </form>

        {state?.error ? (
          <p role="alert" className="text-error text-sm">
            {state.error}
          </p>
        ) : null}

        <p className="text-base-content/50 text-xs leading-relaxed">
          An area that <strong>counts as work</strong> competes for your working day like
          anything else. One that does not — errands, appointments — still takes the time out
          of the day, because it genuinely does, but it is reported separately instead of
          counting as work you promised to deliver.
        </p>
      </div>
    </div>
  );
}

function AreaItem({ area }: { area: AreaRow }) {
  const [busy, startTransition] = useTransition();

  const save = (changes: Parameters<typeof updateArea>[0]) => {
    startTransition(async () => {
      const result = await updateArea(changes);
      logAction(result.error ?? `Updated ${area.name}.`, result.error ? 'error' : 'success');
    });
  };

  const used = area._count.tasks + area._count.projects;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <input
        type="color"
        value={area.color ?? '#6366f1'}
        disabled={busy}
        onChange={(event) => save({ id: area.id, color: event.target.value })}
        className="h-6 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
        aria-label={`Colour for ${area.name}`}
      />

      <span className="min-w-0 grow truncate text-sm font-medium">{area.name}</span>

      <span className="text-base-content/40 shrink-0 text-xs">
        {used === 0 ? 'unused' : `${used} item${used === 1 ? '' : 's'}`}
      </span>

      <label className="label shrink-0 cursor-pointer gap-2 py-0">
        <input
          type="checkbox"
          checked={area.countsTowardCapacity}
          disabled={busy}
          onChange={(event) => save({ id: area.id, countsTowardCapacity: event.target.checked })}
          className="checkbox checkbox-xs"
        />
        <span className="label-text text-xs">Counts as work</span>
      </label>

      {/*
        Confirmed, but the copy says plainly that nothing is lost — the foreign
        keys null out rather than cascade. A delete dialog that implies more
        damage than it does makes people keep clutter they wanted rid of.
      */}
      <ConfirmButton
        action={deleteArea}
        fields={{ id: area.id }}
        label="Remove"
        confirmLabel="Remove — work stays"
        successMessage={`Removed ${area.name}. Its work is untouched.`}
        className="btn btn-ghost btn-xs shrink-0 rounded-lg"
        confirmClassName="btn btn-error btn-soft btn-xs shrink-0 rounded-lg"
      />
    </li>
  );
}
