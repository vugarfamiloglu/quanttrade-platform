import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Footer } from './Footer';

export function AppShell({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'rgb(var(--bg))' }}>
      <Sidebar />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {header ?? <Header />}
        <div style={{ padding: '16px 22px 22px', flex: 1, minWidth: 0 }}>{children}</div>
        <Footer />
      </main>
    </div>
  );
}
