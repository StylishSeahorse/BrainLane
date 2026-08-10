import {
  confirmAiActionAction,
  reflowSchedule,
  rejectAiActionAction,
  revertAiActionAction,
} from '@/app/actions';
import { formatTime } from '@/components/format';
import { PageHeader } from '@/components/page-header';
import { SparkIcon } from '@/components/icons';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

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
 */
export default async function ActivityPage() {
  const user = await requireUser();
  const caller = await getCaller();

  const [actions, autonomy] = await Promise.all([
    caller.agent.activity({ limit: 50 }),
    caller.agent.autonomy(),
  ]);

  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle={
          <>
            Every change the AI made or asked about. Currently{' '}
            <span className="font-medium">{AUTONOMY_LABEL[autonomy.level]}</span>, limited to{' '}
            {autonomy.scope === 'TODAY' ? 'today' : 'this week'}.
          </>
        }
        action={
          <form action={reflowSchedule}>
            <button type="submit" className="btn btn-sm btn-outline gap-1.5">
              <SparkIcon />
              Let the AI reflow
            </button>
          </form>
        }
      />

      {actions.length === 0 ? (
        <div className="card bg-base-100 border-base-300 border">
          <div className="card-body items-center py-10 text-center">
            <p className="font-medium">The AI has not changed anything yet.</p>
            <p className="text-base-content/50 text-sm">
              Anything it does will be listed here, with a way to undo it.
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {actions.map((action) => {
            const undoOpen =
              action.status === 'APPLIED' &&
              (!action.undoExpiresAt || action.undoExpiresAt.getTime() > now);

            return (
              <li key={action.id} className="card bg-base-100 border-base-300 border shadow-sm">
                <div className="card-body gap-2 p-4 sm:p-5">
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
                      {formatTime(action.createdAt, user.timeZone)}
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
                        <form action={revertAiActionAction}>
                          <input type="hidden" name="id" value={action.id} />
                          <button type="submit" className="btn btn-outline btn-xs">
                            Undo this
                          </button>
                        </form>
                      ) : null}

                      {action.status === 'PROPOSED' ? (
                        <>
                          <form action={confirmAiActionAction}>
                            <input type="hidden" name="id" value={action.id} />
                            <button type="submit" className="btn btn-primary btn-xs">
                              Do it
                            </button>
                          </form>
                          <form action={rejectAiActionAction}>
                            <input type="hidden" name="id" value={action.id} />
                            <button type="submit" className="btn btn-ghost btn-xs">
                              No thanks
                            </button>
                          </form>
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
    </>
  );
}
