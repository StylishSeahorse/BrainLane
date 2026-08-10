import { redirect } from 'next/navigation';

/**
 * Tasks now live on the Projects page, which shows them in the context of the
 * project they belong to. Kept as a redirect so old links and bookmarks do not
 * dead-end.
 */
export default function TasksPage() {
  redirect('/projects');
}
