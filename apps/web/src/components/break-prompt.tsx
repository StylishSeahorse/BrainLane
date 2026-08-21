'use client';

/**
 * The break offer.
 *
 * An offer, never an intervention. It appears after a stretch of unbroken work
 * and can be pushed back or waved away; nothing pauses, nothing goes modal,
 * nothing steals focus. Hyperfocus is not a malfunction to be corrected, and a
 * tool that yanks people out of it is one they disable within a week — at
 * which point it protects nobody.
 *
 * Taking the break *does* stop the timer, and that is deliberate. Ten minutes
 * away from the desk logged as ten minutes of work would quietly poison the
 * one dataset the whole app leans on: how long things actually take. The break
 * is offered with the restart already in hand, so the cost of honesty is a
 * single tap.
 */

import { useEffect, useState } from 'react';
import { startTaskTimer, stopTaskTimer } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { formatDuration } from '@/components/format';

/** How long "just a bit longer" buys. */
const SNOOZE_MINUTES = 5;

export function BreakPrompt({
  taskId,
  taskTitle,
  startedAt,
  enabled,
  workMinutes,
  breakMinutes,
}: {
  taskId: string;
  taskTitle: string;
  startedAt: Date | null;
  enabled: boolean;
  workMinutes: number;
  breakMinutes: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [breakUntil, setBreakUntil] = useState<number | null>(null);
  /** Epoch ms before which the prompt stays quiet. */
  const [quietUntil, setQuietUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the timer actually logged, so the reassurance is a fact not a setting. */
  const [loggedMinutes, setLoggedMinutes] = useState<number | null>(null);

  // Ten seconds, not one: the only thing that moves at this granularity is a
  // countdown measured in minutes, and a per-second re-render of the focus
  // screen is exactly the kind of restlessness this screen exists to avoid.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const onBreak = breakUntil !== null && now < breakUntil;
  const breakOver = breakUntil !== null && now >= breakUntil;

  // --- On a break -----------------------------------------------------------
  if (onBreak) {
    const remaining = Math.max(0, Math.ceil((breakUntil - now) / 60_000));
    return (
      <Shell tone="accent">
        <p className="text-sm">
          <span className="font-semibold">On a break.</span>{' '}
          <span className="text-base-content/65">
            About {formatDuration(remaining)} left.
            {loggedMinutes !== null
              ? ` Your ${formatDuration(loggedMinutes)} is logged already —`
              : ' Your work is logged already —'}{' '}
            nothing is riding on you coming back exactly on time.
          </span>
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-xs shrink-0 rounded-lg"
          onClick={() => setBreakUntil(null)}
        >
          Back early
        </button>
      </Shell>
    );
  }

  // --- Break finished -------------------------------------------------------
  if (breakOver) {
    return (
      <Shell tone="accent">
        <p className="text-sm">
          <span className="font-semibold">Break&rsquo;s over.</span>{' '}
          <span className="text-base-content/65">Pick it back up when you are ready.</span>
        </p>
        <button
          type="button"
          disabled={busy}
          className="btn btn-primary btn-xs shrink-0 rounded-lg"
          onClick={() => {
            setBusy(true);
            void startTaskTimer(taskId)
              .then((result) => {
                if (result.error) {
                  logAction(result.error, 'error');
                  return;
                }
                logAction(`Back on "${taskTitle}".`, 'success');
                setBreakUntil(null);
                setQuietUntil(null);
              })
              .finally(() => setBusy(false));
          }}
        >
          Start again
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs shrink-0 rounded-lg"
          onClick={() => {
            setBreakUntil(null);
            setQuietUntil(null);
          }}
        >
          Not yet
        </button>
      </Shell>
    );
  }

  // --- Should we offer one? -------------------------------------------------
  if (!enabled || !startedAt) return null;
  if (quietUntil !== null && now < quietUntil) return null;

  const elapsedMinutes = (now - startedAt.getTime()) / 60_000;
  if (elapsedMinutes < workMinutes) return null;

  return (
    <Shell tone="warning">
      <p className="text-sm">
        <span className="font-semibold">
          {formatDuration(Math.round(elapsedMinutes))} without a break.
        </span>{' '}
        <span className="text-base-content/65">
          Worth {formatDuration(breakMinutes)} away from the screen — but you are the one who
          knows.
        </span>
      </p>

      <button
        type="button"
        disabled={busy}
        className="btn btn-primary btn-xs shrink-0 rounded-lg"
        onClick={() => {
          setBusy(true);
          // Stop first so the break is never counted as work, then start the
          // countdown regardless — a failed stop must not trap someone in a
          // prompt that will not go away.
          void stopTaskTimer(taskId)
            .then((result) => {
              if (result.error) {
                logAction(result.error, 'error');
                return;
              }
              setLoggedMinutes(result.minutes ?? null);
              logAction(`Logged ${result.minutes ?? 0} minutes on "${taskTitle}".`, 'success');
            })
            .finally(() => {
              setBreakUntil(Date.now() + breakMinutes * 60_000);
              setBusy(false);
            });
        }}
      >
        Take {formatDuration(breakMinutes)}
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-xs shrink-0 rounded-lg"
        onClick={() => setQuietUntil(Date.now() + SNOOZE_MINUTES * 60_000)}
      >
        {SNOOZE_MINUTES} more minutes
      </button>

      {/*
        Waving it away buys a full cycle of quiet, not a few minutes. A prompt
        that returns immediately after being dismissed is one people learn to
        ignore, and then it is no longer a prompt at all.
      */}
      <button
        type="button"
        className="btn btn-ghost btn-xs shrink-0 rounded-lg"
        onClick={() => setQuietUntil(Date.now() + workMinutes * 60_000)}
        title="Ask me again after another stretch"
      >
        I&rsquo;m fine
      </button>
    </Shell>
  );
}

function Shell({ tone, children }: { tone: 'accent' | 'warning'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={`flex w-full flex-wrap items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-left ${
        tone === 'accent' ? 'border-accent/30 bg-accent/8' : 'border-warning/30 bg-warning/8'
      }`}
    >
      {children}
    </div>
  );
}
