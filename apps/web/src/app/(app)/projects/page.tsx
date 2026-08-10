import { breakdownTask, completeTask, deferTask, deleteTask } from '@/app/actions';
import { NewTaskForm } from '@/components/new-task-form';
import { formatDuration, relativeDays } from '@/components/format';
import {
  EmptyState,
  EnergyBadge,
  PageHeader,
  PriorityBadge,
  SectionTitle,
} from '@/components/page-header';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
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
        eyebrow="Everything open"
        title="Projects"
        subtitle={`${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${formatDuration(remaining)} of work left`}
      />

      {projects.length > 0 ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            // A project going quiet is a slower, different signal from one task
            // being pushed — worth surfacing on the card rather than in a report.
            const stale = project.daysSinceTouched >= 7;

            return (
              <article
                key={project.id}
                className="card bg-base-100 border-base-200 border shadow-sm"
              >
                <div className="card-body gap-2 p-4">
                  <div className="flex items-start gap-2.5">
                    <span
                      className="mt-1.5 size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: project.color ?? 'var(--color-primary)' }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 grow">
                      <h3 className="truncate font-semibold">{project.name}</h3>
                      <p className="text-base-content/45 text-xs">
                        {project.openTaskCount} open · {formatDuration(project.remainingMinutes)}
                      </p>
                    </div>
                  </div>

                  {project.deadline ? (
                    <span className="badge badge-sm badge-ghost self-start">
                      due {relativeDays(project.deadline)}
                    </span>
                  ) : null}

                  {stale ? (
                    <p className="text-base-content/50 text-xs">
                      Untouched for {project.daysSinceTouched} days.
                    </p>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <NewTaskForm projects={projects.map((project) => ({ id: project.id, name: project.name }))} />

      <SectionTitle>Open tasks</SectionTitle>

      {tasks.length === 0 ? (
        <EmptyState title="Nothing here yet." hint="Add the thing that has been nagging at you." />
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => (
            <li key={task.id} className="card bg-base-100 border-base-200 border shadow-sm">
              <div className="card-body flex-row gap-3 p-4 sm:p-5">
                <form action={completeTask} className="pt-1">
                  <input type="hidden" name="id" value={task.id} />
                  <button
                    type="submit"
                    className="border-base-300 hover:border-primary hover:bg-primary/10 block size-5 rounded-full border-2 transition-colors"
                    aria-label={`Mark "${task.title}" done`}
                    title="Mark done"
                  />
                </form>

                <div className="min-w-0 grow">
                  <h3 className="font-medium">{task.title}</h3>

                  <div className="mt-2 flex flex-wrap gap-1.5">
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
                    <div className="bg-accent/8 border-accent mt-3 rounded-r-lg border-l-[3px] px-3 py-2 text-sm">
                      <span className="font-semibold">Start here:</span> {task.starterStep}
                    </div>
                  ) : null}

                  {task.subtasks.length > 0 ? (
                    <ul className="text-base-content/65 mt-2 list-disc space-y-0.5 pl-5 text-sm">
                      {task.subtasks.map((subtask) => (
                        <li key={subtask.id}>
                          {subtask.title}{' '}
                          <span className="text-base-content/35">
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
                        <button type="submit" className="btn btn-outline btn-xs rounded-lg">
                          Break it down
                        </button>
                      </form>
                    ) : null}
                    <form action={deferTask}>
                      <input type="hidden" name="id" value={task.id} />
                      <input type="hidden" name="days" value="1" />
                      <button type="submit" className="btn btn-ghost btn-xs rounded-lg">
                        Defer a day
                      </button>
                    </form>
                    <form action={deleteTask}>
                      <input type="hidden" name="id" value={task.id} />
                      <button type="submit" className="btn btn-ghost btn-xs text-error rounded-lg">
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
