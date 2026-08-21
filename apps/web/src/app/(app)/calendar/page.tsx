import { redirect } from 'next/navigation';

/**
 * The calendar is now a lens on the Week page. `?view=agenda` is preserved so
 * anyone who bookmarked the agenda still lands on it.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  redirect(view === 'agenda' ? '/week?view=agenda' : '/week?view=calendar');
}
