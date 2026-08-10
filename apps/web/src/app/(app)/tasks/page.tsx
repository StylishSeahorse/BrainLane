import { breakdownTask, completeTask, deferTask, deleteTask } from '@/app/actions';
import { NewTaskForm } from '@/components/new-task-form';
import { formatDuration, relativeDays } from '@/components/format';
import { EnergyBadge, PageHeader, PriorityBadge, SectionTitle } from '@/components/page-header';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  await requireUser();
  const caller = await getCaller();
  const [tasks, projects] = await Promise.all([caller.task.list(), caller.project.list()]);

  const remaining = tasks.reduce(
    (sum, task) => sum + Math.max(0, task.estimateMinutes - task.actualMinutes),
    0,
  );

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={`${tasks.length} open · ${formatDuration(remaining)} of work`}
      />

      <NewTaskForm projects={projects.map((project) => ({ id: project.id, name: project.name }))} />

      <SectionTitle>Open</SectionTitle>

      {tasks.length === 0 ? (
        <div className="card bg-base-100 border-base-300 border">
          <div className="card-body items-center py-10 text-center">
            <p className="font-medium">Nothing here yet.</p>
            <p className="text-base-content/50 text-sm">
              Add the thing that has been nagging at you.
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => (
            <li key={task.id} className="card bg-base-100 border-base-300 border shadow-sm">
              <div className="card-body flex-row gap-3 p-4 sm:p-5">
                <form action={completeTask} className="pt-0.5">
                  <input type="hidden" name="id" value={task.id} />
                  <button
                    type="submit"
                    className="btn btn-circle btn-ghost btn-xs border-base-300 border"
                    aria-label={`Mark "${task.title}" done`}
                    title="Mark done"
                  />
                </form>

                <div className="min-w-0 grow">
                  <h3 className="font-medium">{task.title}</h3>

                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {task.project ? (
                      <span className="badge badge-sm badge-ghost">{task.project.name}</span>
                    ) : null}
                    <EnergyBadge energy={task.energy} />
                    <PriorityBadge priority={task.priority} />
                    <span className="badge badge-sm badge-ghost">
                      {formatDuration(task.estimateMinutes)}
                    </span>
                    {task.deadline ? (
                      <span className="badge badge-sm badge-ghost">
                        due {relativeDays(task.deadline)}
                      </span>
                    ) : null}
                    {task.scheduledBlocks.length > 0 ? (
                      <span className="badge badge-sm badge-soft badge-success">
                        {task.scheduledBlocks.length} session
                        {task.scheduledBlocks.length === 1 ? '' : 's'} booked
                      </span>
                    ) : (
                      <span className="badge badge-sm badge-soft badge-warning">not scheduled</span>
                    )}
                    {task.rescheduleCount >= 3 ? (
                      <span className="badge badge-sm badge-soft badge-error">
                        moved {task.rescheduleCount}×
                      </span>
                    ) : null}
                  </div>

                  {task.starterStep ? (
                    <div className="border-success bg-success/10 mt-3 rounded-r-lg border-l-4 px-3 py-2 text-sm">
                      <span className="font-semibold">Start here:</span> {task.starterStep}
                    </div>
                  ) : null}

                  {task.subtasks.length > 0 ? (
                    <ul className="text-base-content/70 mt-2 list-disc space-y-0.5 pl-5 text-sm">
                      {task.subtasks.map((subtask) => (
                        <li key={subtask.id}>
                          {subtask.title}{' '}
                          <span className="text-base-content/40">
                            ({formatDuration(subtask.estimateMinutes)})
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {task.subtasks.length === 0 ? (
                      <form action={breakdownTask}>
                        <input type="hidden" name="id" value={task.id} />
                        <input type="hidden" name="granularity" value="tiny" />
                        <button type="submit" className="btn btn-outline btn-xs">
                          Break it down
                        </button>
                      </form>
                    ) : null}
                    <form action={deferTask}>
                      <input type="hidden" name="id" value={task.id} />
                      <input type="hidden" name="days" value="1" />
                      <button type="submit" className="btn btn-ghost btn-xs">
                        Defer a day
                      </button>
                    </form>
                    <form action={deleteTask}>
                      <input type="hidden" name="id" value={task.id} />
                      <button type="submit" className="btn btn-ghost btn-xs text-error">
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
