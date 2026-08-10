'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

function useActive(href: string): boolean {
  const pathname = usePathname();
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Sidebar entry.
 *
 * `aria-current="page"` alongside the fill: screen-reader users get the same
 * "you are here" signal sighted users get from the colour.
 */
export function SidebarLink({ item }: { item: NavItem }) {
  const active = useActive(item.href);

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[0.94rem] transition-colors ${
        active
          ? 'bg-primary/10 text-primary font-semibold'
          : 'text-base-content/70 hover:bg-base-200 hover:text-base-content font-medium'
      }`}
    >
      <span aria-hidden="true" className={active ? 'text-primary' : 'text-base-content/45'}>
        {item.icon}
      </span>
      <span className="grow">{item.label}</span>

      {item.badge ? (
        <span
          className={`min-w-6 rounded-full px-1.5 py-0.5 text-center text-xs font-semibold ${
            active ? 'bg-primary text-primary-content' : 'bg-base-200 text-base-content/60'
          }`}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Bottom dock entry for narrow screens.
 *
 * Thumb-reachable navigation matters more than usual here: this is an app people
 * check standing up, mid-transition, one-handed — the moments when remembering
 * what you were doing is hardest.
 */
export function DockLink({ item }: { item: NavItem }) {
  const active = useActive(item.href);

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={active ? 'dock-active text-primary' : 'text-base-content/60'}
    >
      <span aria-hidden="true">{item.icon}</span>
      <span className="dock-label">{item.label}</span>
    </Link>
  );
}
