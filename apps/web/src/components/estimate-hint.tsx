'use client';

import { useEffect, useState } from 'react';
import { suggestEstimate } from '@/app/actions';

/**
 * What this kind of work has actually taken before.
 *
 * The single most useful number the app owns, and until now it was only
 * visible in a weekly report — long after the moment it could change
 * anything. Shown at the point of estimating, it turns a guess into a
 * recollection.
 *
 * Framed as evidence, never as a correction. Underestimating is close to
 * universal and it is a calibration problem, not a character one; "these took
 * 45m" is information, "you always get this wrong" is a reason to close the
 * app.
 */
export function EstimateHint({
  title,
  onAccept,
}: {
  title: string;
  onAccept: (minutes: number) => void;
}) {
  const [hint, setHint] = useState<{ medianMinutes: number; sampleCount: number } | null>(null);

  useEffect(() => {
    const trimmed = title.trim();
    if (trimmed.length < 3) {
      setHint(null);
      return;
    }

    // Debounced, and guarded against out-of-order replies: typing a title is
    // a stream of keystrokes, and a slow early request landing after a fast
    // later one would show a suggestion for a title that no longer exists.
    let cancelled = false;
    const id = setTimeout(() => {
      void suggestEstimate(trimmed).then((result) => {
        if (cancelled) return;
        setHint(
          result.suggestion
            ? { medianMinutes: result.suggestion.medianMinutes, sampleCount: result.sampleCount }
            : null,
        );
      });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [title]);

  if (!hint) return null;

  return (
    <p className="text-base-content/55 mt-1 text-xs">
      Similar work has taken about{' '}
      <button
        type="button"
        className="link link-primary font-medium"
        onClick={() => onAccept(hint.medianMinutes)}
      >
        {hint.medianMinutes} min
      </button>{' '}
      across {hint.sampleCount} finished task{hint.sampleCount === 1 ? '' : 's'}.
    </p>
  );
}
