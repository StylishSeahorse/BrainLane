import {
  confirmAiActionAction,
  reflowSchedule,
  rejectAiActionAction,
  revertAiActionAction,
} from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { formatTime } from '@/components/format';
import { WandIcon } from '@/components/icons';

/**
 * The AI activity feed.
 *
 * Everything the agent did, wanted to do, or was stopped from doing — each with
 * its reason in plain language and its own revert. Per-entry rather than an undo
 * stack: reversing one change from an hour ago without losing the four sensible
 * ones after it is what makes handing over control feel reversible.
 *
 * Refusals are shown, not hidden. A guardrail that works silently is
 * indistinguishable from one that is not there.
 *
 * It lives on Review rather than in its own sidebar slot because that is what
 * it is — evidence about the week just gone, read in the same sitting as the
 * rest of it, not a place you navigate to on purpose.
 */

const KIND_LABEL: Record<string, string> = {
  CREATE_BLOCK: 'Scheduled',
  MOVE_BLOCK: 'Moved',
  RESIZE_BLOCK: 'Resized',
  DELETE_BLOCK: 'Wants to remove',
};

const STATUS_BADGE: Record<string, string> = {
  APPLIED: 'badge-success',
  PROPOSED: 'badge-warning',
  BLOCKED: 'badge-error',
  REVERTED: 'badge-ghost',
  REJECTED: 'badge-ghost',
};

const AUTONOMY_LABEL: Record<string, string> = {
  FULL_AUTO: 'acts immediately',
  AUTO_WITH_UNDO: 'acts immediately, with undo',
  PROPOSE_THEN_CONFIRM: 'asks before every change',
};

export interface AiActionRow {
  id: string;
  kind: string;
  status: string;
  boundary: string | null;
  reason: string;
  explanation: string | null;
  createdAt: Date;
  undoExpiresAt: Date | null;
}

export function AiActivity({
  actions,
  autonomy,
  timeZone,
}: {
  actions: AiActionRow[];
  autonomy: { level: string; scope: string };
  timeZone: string;
}) {
  const now = Date.now();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base-content/55 text-sm">
          Currently <span className="font-medium">{AUTONOMY_LABEL[autonomy.level]}</span>, limited
          to {autonomy.scope === 'TODAY' ? 'today' : 'this week'}.
        </p>
        <LoggedActionButton
          action={reflowSchedule}
          fields={{}}
          successMessage="Reflowed the schedule."
          pendingLabel="Reflowing…"
          className="btn btn-sm btn-outline gap-1.5 rounded-xl"
        >
          <WandIcon />
          Let the AI reflow
        </LoggedActionButton>
      </div>

      {actions.length === 0 ? (
        <div className="card bg-base-100 border-base-200 border">
          <div className="card-body items-center py-8 text-center">
            <p className="font-medium">The AI has not changed anything yet.</p>
            <p className="text-base-content/50 text-sm">
              Anything it does will be listed here, with a way to undo it.
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {actions.map((action) => {
            const undoOpen =
              action.status === 'APPLIED' &&
              (!action.undoExpiresAt || action.undoExpiresAt.getTime() > now);

            return (
              <li key={action.id} className="card bg-base-100 border-base-200 border shadow-sm">
                <div className="card-body gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{KIND_LABEL[action.kind] ?? action.kind}</span>
                    <span className={`badge badge-sm badge-soft ${STATUS_BADGE[action.status] ?? ''}`}>
                      {action.status.toLowerCase()}
                    </span>
                    {action.boundary ? (
                      <span className="badge badge-sm badge-outline">
                        {action.boundary.toLowerCase().replace(/_/g, ' ')}
                      </span>
                    ) : null}
                    <span className="text-base-content/40 ml-auto font-mono text-xs">
                      {formatTime(action.createdAt, timeZone)}
                    </span>
                  </div>

                  {/* The "why" — always present, never a constraint code. */}
                  <p className="text-base-content/80 text-sm">{action.reason}</p>

                  {action.explanation ? (
                    <p className="text-base-content/50 text-xs">{action.explanation}</p>
                  ) : null}

                  {undoOpen || action.status === 'PROPOSED' ? (
                    <div className="card-actions mt-1">
                      {undoOpen ? (
                        <LoggedActionButton
                          action={revertAiActionAction}
                          fields={{ id: action.id }}
                          successMessage={`Undid: ${KIND_LABEL[action.kind] ?? action.kind}.`}
                          pendingLabel="Undoing…"
                          className="btn btn-outline btn-xs"
                        >
                          Undo this
                        </LoggedActionButton>
                      ) : null}

                      {action.status === 'PROPOSED' ? (
                        <>
                          <LoggedActionButton
                            action={confirmAiActionAction}
                            fields={{ id: action.id }}
                            successMessage="Applied that change."
                            pendingLabel="Applying…"
                            className="btn btn-primary btn-xs"
                          >
                            Do it
                          </LoggedActionButton>
                          <LoggedActionButton
                            action={rejectAiActionAction}
                            fields={{ id: action.id }}
                            successMessage="Dismissed that proposal."
                            pendingLabel="Dismissing…"
                            className="btn btn-ghost btn-xs"
                          >
                            No thanks
                          </LoggedActionButton>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
