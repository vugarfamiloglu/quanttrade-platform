'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from './Logo';

interface NavItem { href: string; label: string; icon: React.ReactNode; section?: string; }
const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

const NAV: NavItem[] = [
  { section: 'Trade',    href: '/terminal', label: 'Terminal',     icon: <Icon d="M3 3h18v18H3zM3 9h18M9 3v18" /> },
  { section: 'Trade',    href: '/orders',   label: 'Orders',       icon: <Icon d="M3 6h18M3 12h18M3 18h12" /> },
  { section: 'Trade',    href: '/accounts', label: 'Accounts',     icon: <Icon d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /> },

  { section: 'Engine',   href: '/sagas',    label: 'Sagas',        icon: <Icon d="M3 12h4l3-9 4 18 3-9h4" /> },
  { section: 'Engine',   href: '/events',   label: 'Event Stream', icon: <Icon d="M22 12h-4l-3 9L9 3l-3 9H2" /> },

  { section: 'System',   href: '/services', label: 'Services',     icon: <Icon d="M9 12h6m-3-3v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /> },
  { section: 'System',   href: '/settings', label: 'Settings',     icon: <Icon d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const sections = Array.from(new Set(NAV.map((n) => n.section ?? 'Other')));
  return (
    <aside style={{
      width: 200, flexShrink: 0, height: '100vh', position: 'sticky', top: 0,
      background: 'rgb(var(--bg-soft))', borderRight: '1px solid rgb(var(--line))',
      display: 'flex', flexDirection: 'column', padding: '14px 10px 12px',
    }}>
      <Link href="/terminal" style={{ textDecoration: 'none', color: 'inherit', padding: '2px 6px 14px' }}>
        <Logo />
      </Link>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', flex: 1 }}>
        {sections.map((sec) => (
          <div key={sec} style={{ marginBottom: 6 }}>
            <div className="eyebrow" style={{ padding: '8px 10px 4px', fontSize: 9 }}>{sec}</div>
            {NAV.filter((n) => (n.section ?? 'Other') === sec).map((n) => {
              const active = pathname === n.href || pathname?.startsWith(n.href + '/');
              return (
                <Link key={n.href} href={n.href} className={`nav-link ${active ? 'active' : ''}`}>
                  <span style={{ display: 'grid', placeItems: 'center', width: 16 }}>{n.icon}</span>
                  {n.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="mono" style={{ padding: '8px 10px', borderTop: '1px solid rgb(var(--line-soft))', fontSize: 9.5, color: 'rgb(var(--muted))' }}>
        <span className="live-dot" />v0.1 · {new Date().getFullYear()}
      </div>
    </aside>
  );
}
