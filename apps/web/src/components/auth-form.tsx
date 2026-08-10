'use client';

import { useActionState } from 'react';
import type { ActionState } from '@/app/actions';

interface Props {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  autoComplete: 'current-password' | 'new-password';
  passwordHint?: string;
}

export function AuthForm({ action, submitLabel, autoComplete, passwordHint }: Props) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error ? (
        // role="alert" so it is announced as it appears, not merely rendered.
        <div role="alert" className="alert alert-error text-sm">
          <span>{state.error}</span>
        </div>
      ) : null}

      <fieldset className="fieldset">
        <legend className="fieldset-legend">Email</legend>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="input w-full"
          placeholder="you@example.com"
        />
      </fieldset>

      <fieldset className="fieldset">
        <legend className="fieldset-legend">Password</legend>
        <input
          name="password"
          type="password"
          autoComplete={autoComplete}
          required
          className="input w-full"
        />
        {passwordHint ? <p className="label text-xs">{passwordHint}</p> : null}
      </fieldset>

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? <span className="loading loading-spinner loading-sm" /> : null}
        {pending ? 'Working…' : submitLabel}
      </button>
    </form>
  );
}
