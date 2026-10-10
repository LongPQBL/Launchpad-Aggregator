'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/launches', label: 'Launches' },
  { href: '/pools', label: 'Pools' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/portfolio', label: 'Portfolio' },
];

// Pale by default; the page the user is on turns the brand green.
export function MainNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main navigation" className="flex gap-3 text-sm">
      {LINKS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined}
            className={cn('transition-colors', active ? 'text-brand-text' : 'text-foreground/70 hover:text-foreground')}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
