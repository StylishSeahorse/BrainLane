import { redirect } from 'next/navigation';

/**
 * The board is now a lens on the Week page rather than a destination of its
 * own — it and the calendar were two sidebar entries showing the same seven
 * days. Kept as a redirect so old links and bookmarks do not dead-end, and the
 * week being viewed is carried across.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  redirect(week ? `/week?week=${week}` : '/week');
}
