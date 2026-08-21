'use client';

import { useState, useTransition } from 'react';
import { commitBraindump, parseBraindumpText, type BraindumpDraft } from '@/app/actions';
import { logAction } from '@/components/action-log';

/**
 * Get it all out of your head, then decide.
 *
 * Two steps, deliberately. The first is a box that accepts anything typed at
 * the speed of thought; the second shows exactly what was understood before a
 * single row is written. Capture is where an ADHD user most needs to be
 * trusted immediately and least needs a surprise — six half-right tasks
 * appearing unannounced is worse than the form they were avoiding.
 *
 * Nothing here is clever. The parse is deterministic and works with no AI
 * configured, which matters more at this moment than sophistication does.
 */
export function Braindump() {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<BraindumpDraft[] | null>(null);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();

  const kept = drafts?.filter((_, index) => !dropped.has(index)) ?? [];

  if (drafts) {
    return (
      <div className="card bg-base-100 border-primary/40 border shadow-sm">
        <div className="card-body gap-3">
          <div>
            <h3 className="font-semibold">
              {drafts.length} thing{drafts.length === 1 ? '' : 's'} found
            </h3>
            <p className="text-base-content/55 text-sm">
              Nothing has been saved yet. Drop anything that came out wrong.
            </p>
          </div>

          <ul className="divide-base-200 border-base-200 divide-y rounded-xl border">
            {drafts.map((draft, index) => {
              const isDropped = dropped.has(index);
              return (
                <li
                  key={`${draft.source}-${index}`}
                  className={`flex items-start gap-3 px-3 py-2.5 ${isDropped ? 'opacity-40' : ''}`}
                >
                  <div className="min-w-0 grow">
                    <div className={`text-sm font-medium ${isDropped ? 'line-through' : ''}`}>
                      {draft.title}
                    </div>
                    {draft.hints.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {draft.hints.map((hint) => (
                          <span key={hint} className="badge badge-xs badge-ghost">
                            {hint}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    className="btn btn-ghost btn-xs shrink-0 rounded-lg"
                    onClick={() =>
                      setDropped((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                  >
                    {isDropped ? 'Keep' : 'Drop'}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="card-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm rounded-xl"
              disabled={pending || kept.length === 0}
              onClick={() => {
                startTransition(async () => {
                  const result = await commitBraindump(kept);
                  if (result.error) {
                    logAction(result.error, 'error');
                    return;
                  }
                  logAction(
                    `Added ${result.count} task${result.count === 1 ? '' : 's'}.`,
                    'success',
                  );
                  setDrafts(null);
                  setDropped(new Set());
                  setText('');
                });
              }}
            >
              {pending ? <span className="loading loading-dots loading-xs" /> : null}
              Add {kept.length} task{kept.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending}
              onClick={() => {
                setDrafts(null);
                setDropped(new Set());
              }}
            >
              Back to editing
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-3">
        <div>
          <h3 className="font-semibold">Braindump</h3>
          <p className="text-base-content/55 text-sm">
            Everything at once, however it comes out. Dates and durations get picked up on the way
            through.
          </p>
        </div>

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          maxLength={4000}
          placeholder={
            'I need to organise lights for Saturday, ring Steve about the trailer, order the new XLR leads sometime this month, finish the event poster tomorrow 90 mins'
          }
          className="textarea w-full text-sm"
          aria-label="Braindump"
        />

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl"
            disabled={pending || text.trim().length === 0}
            onClick={() => {
              startTransition(async () => {
                const parsed = await parseBraindumpText(text);
                if (parsed.length === 0) {
                  logAction('Could not find any tasks in that.', 'error');
                  return;
                }
                setDrafts(parsed);
              });
            }}
          >
            {pending ? <span className="loading loading-dots loading-xs" /> : null}
            Sort this out
          </button>
        </div>
      </div>
    </div>
  );
}
