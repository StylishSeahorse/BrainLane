'use client';

import { useActionState, useRef } from 'react';
import { createTask, type ActionState } from '@/app/actions';

/**
 * Progressive disclosure: one field visible by default.
 *
 * A form with nine inputs is a decision point, and a decision point is where
 * capture fails. Everything except the title sits inside a collapse, with
 * defaults that are fine to leave alone.
 */
export function NewTaskForm({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createTask, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await formAction(formData);
        formRef.current?.reset();
      }}
      className="card bg-base-100 border-base-300 border shadow-sm"
    >
      <div className="card-body gap-3">
        {state?.error ? (
          <div role="alert" className="alert alert-error text-sm">
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="join w-full">
          <input
            name="title"
            type="text"
            required
            maxLength={200}
            autoComplete="off"
            placeholder="What needs doing?"
            aria-label="Task title"
            className="input join-item w-full"
          />
          <button type="submit" className="btn btn-primary join-item" disabled={pending}>
            {pending ? <span className="loading loading-spinner loading-xs" /> : 'Add'}
          </button>
        </div>

        <div className="collapse-arrow collapse">
          <input type="checkbox" aria-label="Show more options" />
          <div className="collapse-title min-h-0 p-0 text-sm font-medium">More options</div>

          <div className="collapse-content px-0">
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Notes</legend>
              <textarea name="notes" maxLength={5000} rows={2} className="textarea w-full" />
            </fieldset>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <fieldset className="fieldset">
                <legend className="fieldset-legend">Project</legend>
                <select name="projectId" defaultValue="" className="select w-full">
                  <option value="">None</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Estimate (minutes)</legend>
                <input
                  name="estimateMinutes"
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  defaultValue={30}
                  className="input w-full"
                />
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Energy needed</legend>
                <select name="energy" defaultValue="MEDIUM" className="select w-full">
                  <option value="LOW">Low — can do it tired</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High — needs a clear head</option>
                </select>
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Priority</legend>
                <select name="priority" defaultValue="MEDIUM" className="select w-full">
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </fieldset>

              <fieldset className="fieldset sm:col-span-2">
                <legend className="fieldset-legend">Deadline</legend>
                <input name="deadline" type="datetime-local" className="input w-full" />
              </fieldset>
            </div>

            <label className="label mt-2 cursor-pointer justify-start gap-3">
              <input
                name="isSplittable"
                type="checkbox"
                defaultChecked
                className="checkbox checkbox-sm"
              />
              <span className="label-text">Can be split across sittings</span>
            </label>
          </div>
        </div>
      </div>
    </form>
  );
}
