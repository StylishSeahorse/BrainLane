/** Shared display helpers. Kept dumb and pure so pages stay readable. */

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(date);
}

export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "in 3 days" / "tomorrow" / "today" / "2 days ago". */
export function relativeDays(target: Date, now = new Date()): string {
  const days = Math.round((target.getTime() - now.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/**
 * A timestamp both sides of the render agree on.
 *
 * `toLocaleString()` with no arguments reads the *runtime's* locale and zone,
 * which differ between the server and the browser — so it renders one string on
 * the server, a different one on the client, and React reports a hydration
 * mismatch. Pinning both the locale and the zone is what makes it stable.
 */
export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}
