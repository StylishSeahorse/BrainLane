import { redirect } from 'next/navigation';

/**
 * Routines are configuration — set once, revisited rarely — so they now live
 * in Settings rather than competing for a sidebar slot with the screens used
 * every day.
 */
export default function RoutinesPage() {
  redirect('/settings#routines');
}
