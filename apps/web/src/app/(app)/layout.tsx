import Link from 'next/link';
import { signOut } from '@/app/actions';
import { requireUser } from '@/server/auth/session';
import { DockLink, SidebarLink, type NavItem } from '@/components/nav';
import {
  ActivityIcon,
  CalendarIcon,
  MenuIcon,
  ReviewIcon,
  SettingsIcon,
  TasksIcon,
  TodayIcon,
} from '@/components/icons';

const NAV: NavItem[] = [
  { href: '/today', label: 'Today', icon: <TodayIcon /> },
  { href: '/tasks', label: 'Tasks', icon: <TasksIcon /> },
  { href: '/calendar', label: 'Calendar', icon: <CalendarIcon /> },
  { href: '/activity', label: 'Activity', icon: <ActivityIcon /> },
  { href: '/review', label: 'Review', icon: <ReviewIcon /> },
  { href: '/settings', label: 'Settings', icon: <SettingsIcon /> },
];

/** The four a phone gets. Review and Settings live behind the drawer. */
const DOCK = NAV.slice(0, 4);

/**
 * Responsive app shell.
 *
 * Desktop gets a persistent sidebar; phones get a top bar plus a thumb-reachable
 * bottom dock, with the full menu one tap away in the drawer. The dock is not a
 * cosmetic choice — this is an app people open one-handed, mid-transition, which
 * is exactly when reaching the top of the screen is most annoying.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="drawer lg:drawer-open">
      <input id="app-drawer" type="checkbox" className="drawer-toggle" />

      <div className="drawer-content flex min-h-dvh flex-col">
        <a href="#main" className="btn btn-primary btn-sm sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50">
          Skip to content
        </a>

        {/* Mobile top bar */}
        <header className="navbar bg-base-100 border-base-300 sticky top-0 z-30 border-b lg:hidden">
          <label htmlFor="app-drawer" className="btn btn-ghost btn-square" aria-label="Open menu">
            <MenuIcon />
          </label>
          <Link href="/today" className="btn btn-ghost text-lg font-bold tracking-tight">
            <span className="bg-primary size-2 rounded-full" aria-hidden="true" />
            Fluid
          </Link>
        </header>

        <main id="main" className="mx-auto w-full max-w-4xl grow px-4 pb-28 pt-5 lg:px-8 lg:pb-16 lg:pt-8">
          {children}
        </main>

        {/* Bottom dock, phones only */}
        <nav className="dock bg-base-100 border-base-300 border-t lg:hidden" aria-label="Primary">
          {DOCK.map((item) => (
            <DockLink key={item.href} item={item} />
          ))}
        </nav>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor="app-drawer" aria-label="Close menu" className="drawer-overlay" />

        <div className="bg-base-100 border-base-300 flex min-h-full w-72 flex-col border-r p-4">
          <Link href="/today" className="mb-6 flex items-center gap-2 px-2 text-xl font-bold tracking-tight">
            <span className="bg-primary size-2.5 rounded-full" aria-hidden="true" />
            Fluid
          </Link>

          <ul className="menu w-full gap-0.5 p-0">
            {NAV.map((item) => (
              <SidebarLink key={item.href} item={item} />
            ))}
          </ul>

          <form action={signOut} className="mt-auto pt-6">
            <p className="text-base-content/50 truncate px-2 pb-2 text-xs" title={user.email}>
              {user.email}
            </p>
            <button type="submit" className="btn btn-ghost btn-sm w-full justify-start">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
