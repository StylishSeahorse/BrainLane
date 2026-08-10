import Link from 'next/link';
import { prisma } from '@fluid/db';
import { signOut } from '@/app/actions';
import { requireUser } from '@/server/auth/session';
import { DockLink, SidebarLink, type NavItem } from '@/components/nav';
import {
  ActivityIcon,
  CalendarIcon,
  DotsIcon,
  LeafIcon,
  LogoMark,
  MenuIcon,
  ProjectsIcon,
  ReviewIcon,
  SettingsIcon,
  TodayIcon,
} from '@/components/icons';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // The Today badge counts what is actually waiting on them right now — blocks
  // left today plus any plan awaiting a decision. A number that means nothing
  // is worse than no number: it trains people to ignore the one place the app
  // asks for attention.
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const [dueToday, pendingPlans] = await Promise.all([
    prisma.scheduledBlock.count({
      where: {
        task: { userId: user.id },
        state: { in: ['PROPOSED', 'ACCEPTED'] },
        startsAt: { gte: now, lte: endOfDay },
      },
    }),
    prisma.planVersion.count({ where: { userId: user.id, status: 'PROPOSED' } }),
  ]);

  const todayBadge = dueToday + pendingPlans;

  const nav: NavItem[] = [
    { href: '/today', label: 'Today', icon: <TodayIcon />, ...(todayBadge ? { badge: todayBadge } : {}) },
    { href: '/calendar', label: 'Calendar', icon: <CalendarIcon /> },
    { href: '/projects', label: 'Projects', icon: <ProjectsIcon /> },
    { href: '/activity', label: 'Activity', icon: <ActivityIcon /> },
    { href: '/review', label: 'Review', icon: <ReviewIcon /> },
    { href: '/settings', label: 'Settings', icon: <SettingsIcon /> },
  ];

  const dock = [nav[0]!, nav[1]!, nav[2]!, nav[3]!];
  const handle = user.email.split('@')[0] ?? 'you';

  return (
    <div className="drawer lg:drawer-open">
      <input id="app-drawer" type="checkbox" className="drawer-toggle" />

      <div className="drawer-content from-page-from to-page-to flex min-h-dvh flex-col bg-gradient-to-b">
        <a
          href="#main"
          className="btn btn-primary btn-sm sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
        >
          Skip to content
        </a>

        {/* Mobile top bar */}
        <header className="navbar bg-base-100/85 border-base-200 sticky top-0 z-30 min-h-14 border-b backdrop-blur lg:hidden">
          <label htmlFor="app-drawer" className="btn btn-ghost btn-square btn-sm" aria-label="Open menu">
            <MenuIcon />
          </label>
          <Link href="/today" className="flex items-center gap-2 px-2">
            <span className="from-primary to-secondary grid size-7 place-items-center rounded-lg bg-gradient-to-br text-white">
              <LogoMark className="size-4" />
            </span>
            <span className="text-[0.95rem] tracking-tight">
              ADHD <span className="font-bold">Planner</span>
            </span>
          </Link>
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl grow px-4 pb-28 pt-6 lg:px-10 lg:pb-14 lg:pt-9">
          {children}
        </main>

        <nav className="dock bg-base-100/95 border-base-200 border-t backdrop-blur lg:hidden" aria-label="Primary">
          {dock.map((item) => (
            <DockLink key={item.href} item={item} />
          ))}
        </nav>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor="app-drawer" aria-label="Close menu" className="drawer-overlay" />

        <div className="bg-base-100 border-base-200 flex min-h-full w-[254px] flex-col border-r px-4 py-5">
          <Link href="/today" className="mb-7 flex items-center gap-3 px-1">
            <span className="from-primary to-secondary grid size-10 place-items-center rounded-xl bg-gradient-to-br text-white shadow-sm">
              <LogoMark />
            </span>
            <span className="text-[1.05rem] tracking-tight">
              ADHD <span className="font-bold">Planner</span>
            </span>
          </Link>

          <nav className="flex flex-col gap-1" aria-label="Main">
            {nav.map((item) => (
              <SidebarLink key={item.href} item={item} />
            ))}
          </nav>

          {/*
            The product's whole posture in one card. It sits above the account
            row rather than buried in settings because the moment someone needs
            reminding is the moment they are looking at a plan that slipped.
          */}
          <div className="mt-auto">
            <div className="bg-accent/8 border-accent/15 mb-4 rounded-2xl border p-3.5">
              <div className="text-accent flex items-center gap-2 text-[0.83rem] font-semibold">
                <LeafIcon />
                No shame zone
              </div>
              <p className="text-base-content/55 mt-1 text-xs leading-snug">
                Plans change. We&rsquo;ll change with them.
              </p>
            </div>

            <div className="border-base-200 flex items-center gap-2.5 border-t pt-4">
              <span className="from-primary to-secondary grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-sm font-semibold text-white">
                {handle.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 grow">
                <div className="truncate text-[0.85rem] font-semibold" title={user.email}>
                  {handle}
                </div>
                <div className="text-base-content/45 text-xs">Private workspace</div>
              </div>

              <form action={signOut}>
                <button
                  type="submit"
                  className="btn btn-ghost btn-xs btn-square text-base-content/40"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <DotsIcon />
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
