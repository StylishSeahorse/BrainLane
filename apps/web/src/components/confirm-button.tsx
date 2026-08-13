'use client';

/**
 * A two-step button for something that cannot be undone.
 *
 * Deliberately not a modal. Completing a task is one tap and fully
 * reversible, so it needs no confirmation at all; deleting one destroys it,
 * so it needs exactly enough friction to stop a misplaced tap — and no more.
 * Arming in place costs one extra tap and never steals focus or covers the
 * page the way a dialog would.
 *
 * The armed state disarms itself after a few seconds. A button left reading
 * "Really delete?" indefinitely becomes a trap for the *next* stray tap,
 * which is the failure this exists to prevent.
 */
import { useEffect, useState, useTransition } from 'react';
import { logAction } from '@/components/action-log';

const DISARM_MS = 4000;

export function ConfirmButton({
  action,
  fields,
  label,
  confirmLabel,
  successMessage,
  className,
  confirmClassName,
}: {
  action: (formData: FormData) => Promise<void | { error?: string } | undefined>;
  fields: Record<string, string>;
  label: string;
  confirmLabel: string;
  successMessage: string;
  className?: string;
  confirmClassName?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), DISARM_MS);
    return () => clearTimeout(id);
  }, [armed]);

  const run = () => {
    startTransition(async () => {
      try {
        const formData = new FormData();
        for (const [key, value] of Object.entries(fields)) formData.set(key, value);

        const result = await action(formData);
        if (result && 'error' in result && result.error) {
          logAction(result.error, 'error');
          return;
        }
        logAction(successMessage, 'success');
      } catch (error) {
        logAction(error instanceof Error ? error.message : 'Something went wrong.', 'error');
      } finally {
        setArmed(false);
      }
    });
  };

  return (
    <button
      type="button"
      className={armed ? (confirmClassName ?? className) : className}
      disabled={pending}
      onClick={() => (armed ? run() : setArmed(true))}
    >
      {pending ? (
        <span className="loading loading-dots loading-xs" />
      ) : armed ? (
        confirmLabel
      ) : (
        label
      )}
    </button>
  );
}
