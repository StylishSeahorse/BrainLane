'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * `aria-current="page"` alongside the visual highlight: screen-reader users get
 * the same "you are here" signal sighted users get from the colour.
 */
function useActive(href: string): boolean {
  const pathname = usePathname();
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sidebar entry, shown from `lg` upwards. */
export function SidebarLink({ item }: { item: NavItem }) {
  const active = useActive(item.href);

  return (
    <li>
      <Link href={item.href} aria-current={active ? 'page' : undefined} className={active ? 'menu-active font-semibold' : ''}>
        <span aria-hidden="true">{item.icon}</span>
        {item.label}
      </Link>
    </li>
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
    <Link href={item.href} aria-current={active ? 'page' : undefined} className={active ? 'dock-active' : ''}>
      <span aria-hidden="true">{item.icon}</span>
      <span className="dock-label">{item.label}</span>
    </Link>
  );
}
