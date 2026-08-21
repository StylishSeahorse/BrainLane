'use client';

/**
 * The day, read back.
 *
 * ADHD days routinely end with real work done and no memory of doing it — the
 * hours are gone and nothing feels finished. That gap is what this closes: not
 * a productivity score, just an accurate account of where the time went,
 * grouped so it reads as a shape rather than a log.
 *
 * Nothing here is a metric. No percentages, no target, no comparison with
 * yesterday. A number you can fall short of turns the one screen meant to end
 * the day well into another place to feel behind.
 */

import { useState } from 'react';
import { formatDuration } from '@/components/format';
import { CheckIcon } from '@/components/icons';

export interface HighlightGroup {
  key: string;
  name: string;
  color: string | null;
  minutes: number;
  counts: boolean;
  items: Array<{ id: string; title: string; minutes: number }>;
}

export function Highlights({
  groups,
  totalMinutes,
  taskCount,
  heading = 'What today added up to',
}: {
  groups: HighlightGroup[];
  totalMinutes: number;
  taskCount: number;
  heading?: string;
}) {
  const [copied, setCopied] = useState(false);

  if (taskCount === 0) {
    return (
      <p className="text-base-content/50 text-sm">
        Nothing ticked off today. That is a fact about the day, not about you — some days
        are meetings, or recovery, or one enormous thing that is still in progress.
      </p>
    );
  }

  /** Plain text, because the destination is a standup note or a message box. */
  const asText = [
    heading,
    '',
    ...groups.flatMap((group) => [
      `${group.name} — ${formatDuration(group.minutes)}`,
      ...group.items.map((item) => `  · ${item.title}`),
      '',
    ]),
  ]
    .join('\n')
    .trim();

  const copy = () => {
    void navigator.clipboard.writeText(asText).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      },
      () => setCopied(false),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold">
            {taskCount} thing{taskCount === 1 ? '' : 's'}
          </span>
          <span className="text-base-content/55"> · {formatDuration(totalMinutes)} of work</span>
        </p>

        <button type="button" onClick={copy} className="btn btn-ghost btn-xs rounded-lg">
          {copied ? (
            <>
              <CheckIcon className="size-3.5" /> Copied
            </>
          ) : (
            'Copy summary'
          )}
        </button>
      </div>

      <ul className="space-y-2.5">
        {groups.map((group) => (
          <li key={group.key}>
            <div className="flex items-baseline gap-2">
              {group.color ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: group.color }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="text-sm font-semibold">{group.name}</span>
              {!group.counts ? (
                <span className="badge badge-xs badge-ghost shrink-0">personal</span>
              ) : null}
              <span className="text-base-content/45 ml-auto shrink-0 text-xs tabular-nums">
                {formatDuration(group.minutes)}
              </span>
            </div>

            <ul className="mt-0.5 space-y-0.5 pl-4">
              {group.items.map((item) => (
                <li key={item.id} className="text-base-content/70 flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 grow">{item.title}</span>
                  <span className="text-base-content/35 shrink-0 text-xs tabular-nums">
                    {formatDuration(item.minutes)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
