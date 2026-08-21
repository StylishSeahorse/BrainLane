'use client';

import { useActionState, useRef } from 'react';
import { createTask, type ActionState } from '@/app/actions';
import { PlusIcon } from '@/components/icons';

/**
 * Sunsama-style capture at the bottom of the day list: one field, sensible
 * defaults for everything else. A new task lands in the backlog rather than
 * on today's plan — the AI decides where it fits on the next re-plan — so the
 * placeholder says so instead of letting the silence read as "it vanished".
 */
export function QuickAddTask() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createTask, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await formAction(formData);
        formRef.current?.reset();
      }}
      className="border-base-200 border-t px-4 py-2.5"
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
          maxLength={200}
          autoComplete="off"
          disabled={pending}
          placeholder="Add a task — Re-plan slots it in"
          aria-label="Add a task"
          className="placeholder:text-base-content/35 min-w-0 grow bg-transparent text-sm outline-none"
        />
        {/*
          Enter submits, but it cannot be the only way in: a phone keyboard's
          "go" key is easy to miss, and a field with no visible commit control
          reads as a search box. Matches the explicit Add button the Tasks page
          already uses.
        */}
        <button type="submit" className="btn btn-ghost btn-xs rounded-lg" disabled={pending}>
          Add
        </button>
      </div>
    </form>
  );
}
