'use client';
import { useTheme } from './ThemeProvider';
import { usePathname } from 'next/navigation';

const TITLES: Record<string, { title: string; subtitle?: string }> = {
  '/terminal':  { title: 'Terminal',     subtitle: 'Order book · tape · order entry' },
  '/orders':    { title: 'Orders',       subtitle: 'Lifecycle of every order through the engine' },
  '/accounts':  { title: 'Accounts',     subtitle: 'Event-sourced balances + snapshot recovery' },
  '/sagas':     { title: 'Sagas',        subtitle: 'Orchestrated transactions with compensations' },
  '/events':    { title: 'Event Stream', subtitle: 'Live broker tail with traceparent threading' },
  '/services':  { title: 'Services',     subtitle: 'Health · circuit breakers · metrics' },
  '/settings':  { title: 'Settings',     subtitle: 'Runtime configuration + JWT keypair' },
};

export function Header({ title: t0, subtitle: s0, right }: { title?: string; subtitle?: string; right?: React.ReactNode }) {
  const { theme, toggle } = useTheme();
  const pathname = usePathname() ?? '/terminal';
  const matched = Object.keys(TITLES).find((k) => pathname === k || pathname.startsWith(k + '/'));
  const computed = matched ? TITLES[matched] : { title: 'QuantTrade', subtitle: '' };
  const title = t0 ?? computed.title;
  const subtitle = s0 ?? computed.subtitle;
  return (
    <header style={{ padding: '14px 22px 11px', borderBottom: '1px solid rgb(var(--line))', background: 'rgb(var(--bg))', display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="h-display" style={{ fontSize: 19, margin: 0, letterSpacing: '-0.005em' }}>{title}</h1>
        {subtitle ? <div className="mono" style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 2 }}>{subtitle}</div> : null}
      </div>
      {right}
      <button className="btn-ghost" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
        {theme === 'dark' ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        )}
      </button>
    </header>
  );
}
