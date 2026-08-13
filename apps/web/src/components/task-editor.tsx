'use client';

/**
 * Editing a task after the fact.
 *
 * Capture is deliberately one field (see `NewTaskForm`) — asking for nine
 * decisions at the moment of "write this down before I forget" is where
 * capture fails. The consequence is that most tasks arrive with default
 * estimates and no deadline, so there has to be somewhere to fill the rest in
 * later. This is that somewhere.
 *
 * A native `<dialog>`: it gets focus trapping, Escape-to-close and inertness
 * of the page behind it from the platform, none of which is worth
 * reimplementing.
 */
import { useRef, useState, useTransition } from 'react';
import { updateTaskDetails } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { PencilIcon } from '@/components/icons';

export interface EditableTask {
  id: string;
  title: string;
  notes: string | null;
  projectId: string | null;
  priority: string;
  energy: string;
  estimateMinutes: number;
  deadline: Date | null;
  isSplittable: boolean;
}

/**
 * `datetime-local` wants `YYYY-MM-DDTHH:MM` in *local* time, and
 * `toISOString()` gives UTC — feeding it the latter shifts the displayed
 * deadline by the timezone offset every time the dialog opens.
 */
function toLocalInputValue(date: Date | null): string {
  if (!date) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TaskEditor({
  task,
  projects,
}: {
  task: EditableTask;
  projects: Array<{ id: string; name: string }>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (formData: FormData) => {
    startTransition(async () => {
      const result = await updateTaskDetails({
        id: task.id,
        title: String(formData.get('title') ?? '').trim(),
        notes: String(formData.get('notes') ?? ''),
        projectId: String(formData.get('projectId') ?? '') || null,
        priority: formData.get('priority') as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
        energy: formData.get('energy') as 'LOW' | 'MEDIUM' | 'HIGH',
        estimateMinutes: Number(formData.get('estimateMinutes') ?? 30),
        deadline: String(formData.get('deadline') ?? ''),
        isSplittable: formData.get('isSplittable') === 'on',
      });

      if (result.error) {
        setError(result.error);
        return;
      }

      setError(null);
      dialogRef.current?.close();
      logAction(`Updated "${formData.get('title')}".`, 'success');
    });
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-xs gap-1.5 rounded-lg"
        onClick={() => {
          setError(null);
          dialogRef.current?.showModal();
        }}
      >
        <PencilIcon />
        Edit
      </button>

      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-lg">
          <h3 className="text-lg font-semibold">Edit task</h3>

          <form action={save} className="mt-3 space-y-3">
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Title</legend>
              <input
                name="title"
                defaultValue={task.title}
                required
                maxLength={200}
                className="input w-full"
              />
            </fieldset>

            <fieldset className="fieldset">
              <legend className="fieldset-legend">Notes</legend>
              <textarea
                name="notes"
                defaultValue={task.notes ?? ''}
                maxLength={5000}
                rows={2}
                className="textarea w-full"
              />
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <fieldset className="fieldset">
                <legend className="fieldset-legend">Project</legend>
                <select
                  name="projectId"
                  defaultValue={task.projectId ?? ''}
                  className="select w-full"
                >
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
                  defaultValue={task.estimateMinutes}
                  className="input w-full"
                />
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Energy needed</legend>
                <select name="energy" defaultValue={task.energy} className="select w-full">
                  <option value="LOW">Low — can do it tired</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High — needs a clear head</option>
                </select>
              </fieldset>

              <fieldset className="fieldset">
                <legend className="fieldset-legend">Priority</legend>
                <select name="priority" defaultValue={task.priority} className="select w-full">
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </fieldset>

              <fieldset className="fieldset sm:col-span-2">
                <legend className="fieldset-legend">Deadline</legend>
                <input
                  name="deadline"
                  type="datetime-local"
                  defaultValue={toLocalInputValue(task.deadline)}
                  className="input w-full"
                />
                <p className="label text-xs">Leave empty for no deadline.</p>
              </fieldset>
            </div>

            <label className="label cursor-pointer justify-start gap-3">
              <input
                name="isSplittable"
                type="checkbox"
                defaultChecked={task.isSplittable}
                className="checkbox checkbox-sm"
              />
              <span className="label-text">Can be split across sittings</span>
            </label>

            {error ? (
              <div role="alert" className="alert alert-error alert-soft text-sm">
                <span>{error}</span>
              </div>
            ) : null}

            <div className="modal-action">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
                {pending ? <span className="loading loading-dots loading-xs" /> : 'Save changes'}
              </button>
            </div>
          </form>
        </div>

        {/* Clicking the backdrop closes, matching every other modal people use. */}
        <form method="dialog" className="modal-backdrop">
          <button type="submit">close</button>
        </form>
      </dialog>
    </>
  );
}
