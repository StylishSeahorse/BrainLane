import {
  breakdownTask,
  completeTask,
  deferTask,
  deleteTask,
  uncompleteTask,
  uncompleteTaskAction,
} from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { Braindump } from '@/components/braindump';
import { AreaPicker } from '@/components/area-picker';
import { BucketPicker } from '@/components/bucket-picker';
import { BUCKET_LABELS, BUCKET_ORDER, type Bucket } from '@/components/buckets';
import { ConfirmButton } from '@/components/confirm-button';
import { CheckIcon } from '@/components/icons';
import { NewTaskForm } from '@/components/new-task-form';
import { TaskEditor } from '@/components/task-editor';
import { TaskTimer } from '@/components/task-timer';
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

/**
 * Unbucketed work reads as "Soon" rather than sitting in a sixth unsorted
 * pile. An inbox you have to process before the list is usable is what kills
 * backlogs; a default that is occasionally wrong costs one click to fix.
 */
function bucketOf(task: { timeBucket: string | null }): Bucket {
  return (task.timeBucket as Bucket | null) ?? 'SOON';
}

export default async function ProjectsPage() {
  await requireUser();
  const caller = await getCaller();
  const [tasks, projects, recentlyDone, areas] = await Promise.all([
    caller.task.list(),
    caller.project.list(),
    caller.task.recentlyCompleted(),
    caller.area.list(),
  ]);

  const projectOptions = projects.map((project) => ({ id: project.id, name: project.name }));

  const remaining = tasks.reduce(
    (sum, task) => sum + Math.max(0, task.estimateMinutes - task.actualMinutes),
    0,
  );

  // Grouped by horizon rather than shown as one undifferentiated column. A
  // flat list of everything ever captured is the thing people stop opening;
  // "Soon" being short is what makes the rest bearable to keep.
  const ordered = [...tasks].sort(
    (a, b) => BUCKET_ORDER.indexOf(bucketOf(a)) - BUCKET_ORDER.indexOf(bucketOf(b)),
  );

  return (
    <>
      <PageHeader
        eyebrow="Everything open"
        title="Tasks"
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

      <div className="grid gap-3 lg:grid-cols-2">
        <NewTaskForm projects={projectOptions} />
        <Braindump />
      </div>

      <SectionTitle>Open tasks</SectionTitle>

      {tasks.length === 0 ? (
        <EmptyState title="Nothing here yet." hint="Add the thing that has been nagging at you." />
      ) : (
        <ul className="space-y-3">
          {ordered.map((task, index) => (
            <li key={task.id} className="card bg-base-100 border-base-200 border shadow-sm">
              {/*
                A heading before the first task of each horizon. Rendered inside
                the row rather than by splitting the list into five lists,
                because the card markup is substantial and duplicating it per
                group is how the two copies drift apart.
              */}
              {index === 0 || bucketOf(ordered[index - 1]!) !== bucketOf(task) ? (
                <h3 className="text-base-content/40 border-base-200 border-b px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] sm:px-5">
                  {BUCKET_LABELS[bucketOf(task)]}
                </h3>
              ) : null}
              <div className="card-body flex-row gap-3 p-4 sm:p-5">
                {/*
                  No confirmation on purpose — asking "did you really do that?"
                  is friction at the one moment the app should feel rewarding.
                  The trade is that it must be genuinely reversible, which the
                  Undo on the log line and the "Finished recently" section
                  below both provide.
                */}
                <div className="pt-1">
                  <LoggedActionButton
                    action={completeTask}
                    fields={{ id: task.id }}
                    successMessage={`Finished "${task.title}".`}
                    undo={{ action: uncompleteTask, arg: task.id, label: 'Undo' }}
                    className="border-base-300 hover:border-primary hover:bg-primary/10 block size-5 rounded-full border-2 transition-colors"
                  >
                    <span className="sr-only">Mark &ldquo;{task.title}&rdquo; done</span>
                  </LoggedActionButton>
                </div>

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

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <TaskTimer
                      taskId={task.id}
                      taskTitle={task.title}
                      startedAt={task.timerStartedAt}
                    />
                    <BucketPicker taskId={task.id} current={bucketOf(task)} />
                    <AreaPicker taskId={task.id} current={task.areaId} areas={areas} />
                    {task.subtasks.length === 0 ? (
                      <LoggedActionButton
                        action={breakdownTask}
                        fields={{ id: task.id, granularity: 'tiny' }}
                        successMessage={`Broke "${task.title}" into smaller steps.`}
                        pendingLabel="Thinking…"
                        className="btn btn-outline btn-xs rounded-lg"
                      >
                        Break it down
                      </LoggedActionButton>
                    ) : null}

                    <TaskEditor
                      task={{
                        id: task.id,
                        title: task.title,
                        notes: task.notes,
                        projectId: task.projectId,
                        priority: task.priority,
                        energy: task.energy,
                        estimateMinutes: task.estimateMinutes,
                        deadline: task.deadline,
                        isSplittable: task.isSplittable,
                      }}
                      projects={projectOptions}
                    />

                    <LoggedActionButton
                      action={deferTask}
                      fields={{ id: task.id, days: '1' }}
                      successMessage={`Moved "${task.title}" to tomorrow.`}
                      pendingLabel="Deferring…"
                      className="btn btn-ghost btn-xs rounded-lg"
                    >
                      Defer a day
                    </LoggedActionButton>

                    {/* Delete is the one genuinely irreversible action here. */}
                    <ConfirmButton
                      action={deleteTask}
                      fields={{ id: task.id }}
                      label="Delete"
                      confirmLabel="Really delete?"
                      successMessage={`Deleted "${task.title}".`}
                      className="btn btn-ghost btn-xs text-error rounded-lg"
                      confirmClassName="btn btn-error btn-xs rounded-lg"
                    />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/*
        The safety net for a mis-tap on the completion circle. Deliberately a
        real section rather than only the Undo on the log line: the log entry
        is gone after a reload, and "I ticked the wrong thing yesterday" needs
        an answer that outlives the session.
      */}
      {recentlyDone.length > 0 ? (
        <>
          <SectionTitle>Finished recently</SectionTitle>
          <ul className="card bg-base-100 border-base-200 divide-base-200 divide-y border shadow-sm">
            {recentlyDone.map((task) => (
              <li key={task.id} className="flex items-center gap-3 px-5 py-3">
                <span className="text-success shrink-0" aria-hidden="true">
                  <CheckIcon />
                </span>
                <div className="min-w-0 grow">
                  <div className="text-base-content/70 truncate text-sm line-through">
                    {task.title}
                  </div>
                  {task.actualMinutes > 0 ? (
                    <div className="text-base-content/40 text-xs">
                      {formatDuration(task.actualMinutes)} tracked
                    </div>
                  ) : null}
                </div>
                <LoggedActionButton
                  action={uncompleteTaskAction}
                  fields={{ id: task.id }}
                  successMessage={`Brought "${task.title}" back.`}
                  pendingLabel="Restoring…"
                  className="btn btn-ghost btn-xs shrink-0 rounded-lg"
                >
                  Bring it back
                </LoggedActionButton>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
