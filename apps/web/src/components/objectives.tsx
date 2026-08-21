'use client';

import { useActionState, useRef } from 'react';
import {
  createObjective,
  deleteObjective,
  rollObjectiveForward,
  setObjectiveAchieved,
  type ActionState,
} from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { formatDuration } from '@/components/format';
import { CheckIcon, PlusIcon } from '@/components/icons';

/**
 * What this week is actually for.
 *
 * A thin layer above tasks, capped at five, with progress derived from linked
 * work rather than typed in. The value is the question — "what are the two or
 * three things that would make this a good week?" — which is worth asking on
 * Monday and worth being shown on Thursday, and is lost entirely if this grows
 * into something with statuses and owners that has to be maintained.
 */

export interface ObjectiveRow {
  id: string;
  title: string;
  notes: string | null;
  achievedAt: Date | null;
  rolledFromId: string | null;
  doneCount: number;
  totalCount: number;
  minutesInvested: number;
  tasks: Array<{ id: string; title: string; status: string }>;
}

export function Objectives({ objectives, lastWeek }: {
  objectives: ObjectiveRow[];
  lastWeek: ObjectiveRow[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createObjective,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);

  const unfinishedLastWeek = lastWeek.filter((objective) => !objective.achievedAt);

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-0 p-0">
        <div className="border-base-200 flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">This week</h2>
          <span className="text-base-content/45 text-xs">
            {objectives.length}/5
          </span>
        </div>

        {objectives.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="font-medium">No objectives set.</p>
            <p className="text-base-content/50 mx-auto mt-1 max-w-sm text-sm">
              Two or three things that would make this a good week. Not a task list — the reason
              behind one.
            </p>
          </div>
        ) : (
          <ul className="divide-base-200 divide-y">
            {objectives.map((objective) => {
              const achieved = objective.achievedAt != null;
              const progress =
                objective.totalCount > 0
                  ? Math.round((objective.doneCount / objective.totalCount) * 100)
                  : 0;

              return (
                <li key={objective.id} className={`px-5 py-3.5 ${achieved ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5">
                      <LoggedActionButton
                        action={setObjectiveAchieved}
                        fields={{ id: objective.id, achieved: achieved ? 'false' : 'true' }}
                        successMessage={
                          achieved ? `Reopened "${objective.title}".` : `"${objective.title}" — done.`
                        }
                        className={
                          achieved
                            ? 'bg-primary border-primary grid size-5 place-items-center rounded-full border-2 text-white'
                            : 'border-base-300 hover:border-primary hover:bg-primary/10 block size-5 rounded-full border-2 transition-colors'
                        }
                      >
                        {achieved ? <CheckIcon className="size-3" /> : null}
                        <span className="sr-only">
                          {achieved ? 'Reopen' : 'Mark achieved'} &ldquo;{objective.title}&rdquo;
                        </span>
                      </LoggedActionButton>
                    </div>

                    <div className="min-w-0 grow">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className={`font-medium ${achieved ? 'line-through' : ''}`}>
                          {objective.title}
                        </span>
                        {objective.rolledFromId ? (
                          <span className="badge badge-xs badge-ghost">carried over</span>
                        ) : null}
                      </div>

                      {objective.notes ? (
                        <p className="text-base-content/60 mt-0.5 text-sm">{objective.notes}</p>
                      ) : null}

                      {objective.totalCount > 0 ? (
                        <div className="mt-2">
                          <div className="bg-base-200 h-1.5 w-full overflow-hidden rounded-full">
                            <span
                              className="bg-primary block h-full rounded-full"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <p className="text-base-content/45 mt-1 text-xs">
                            {objective.doneCount} of {objective.totalCount} linked task
                            {objective.totalCount === 1 ? '' : 's'} done
                            {objective.minutesInvested > 0
                              ? ` · ${formatDuration(objective.minutesInvested)} invested`
                              : ''}
                          </p>
                        </div>
                      ) : (
                        <p className="text-base-content/40 mt-1 text-xs">
                          No tasks linked yet.
                        </p>
                      )}
                    </div>

                    <LoggedActionButton
                      action={deleteObjective}
                      fields={{ id: objective.id }}
                      successMessage={`Removed "${objective.title}".`}
                      className="btn btn-ghost btn-xs text-base-content/40 shrink-0 rounded-lg"
                    >
                      Remove
                    </LoggedActionButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {objectives.length < 5 ? (
          <form
            ref={formRef}
            action={async (formData) => {
              await formAction(formData);
              formRef.current?.reset();
            }}
            className="border-base-200 border-t px-5 py-2.5"
          >
            {state?.error ? <p className="text-error mb-1 text-xs">{state.error}</p> : null}
            <div className="flex items-center gap-2">
              <span className="text-base-content/35 shrink-0" aria-hidden="true">
                {pending ? <span className="loading loading-dots loading-xs" /> : <PlusIcon />}
              </span>
              <input
                name="title"
                type="text"
                required
                maxLength={140}
                autoComplete="off"
                disabled={pending}
                placeholder="What would make this a good week?"
                aria-label="New objective"
                className="placeholder:text-base-content/35 min-w-0 grow bg-transparent text-sm outline-none"
              />
              <button type="submit" className="btn btn-ghost btn-xs rounded-lg" disabled={pending}>
                Add
              </button>
            </div>
          </form>
        ) : null}

        {/*
          Last week's unfinished intentions, offered rather than assumed. An
          objective that quietly reappears every Monday stops being read.
        */}
        {unfinishedLastWeek.length > 0 ? (
          <div className="border-base-200 bg-base-200/40 border-t px-5 py-3">
            <p className="text-base-content/50 text-xs font-semibold uppercase tracking-[0.12em]">
              Unfinished last week
            </p>
            <ul className="mt-2 space-y-1.5">
              {unfinishedLastWeek.map((objective) => (
                <li key={objective.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 grow truncate">{objective.title}</span>
                  <LoggedActionButton
                    action={rollObjectiveForward}
                    fields={{ id: objective.id }}
                    successMessage={`Carried "${objective.title}" into this week.`}
                    pendingLabel="Carrying…"
                    className="btn btn-ghost btn-xs shrink-0 rounded-lg"
                  >
                    Carry forward
                  </LoggedActionButton>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
