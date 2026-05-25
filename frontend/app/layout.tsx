import './globals.css';
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/ThemeProvider';
import { NotifyProvider } from '@/components/NotifyProvider';

export const metadata: Metadata = {
  title: { default: 'QuantTrade Platform', template: '%s · QuantTrade' },
  description:
    'High-throughput trading infrastructure — event-sourced wallet, in-memory matching engine, saga-orchestrated clearing, distributed locking, idempotent gateway, full observability.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* suppressHydrationWarning is required because the inline
     * anti-flash script below mutates <html class="…"> before React
     * hydrates.  The flag only suppresses the warning for <html>'s
     * own attributes — child mismatches still warn as normal. */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Trading Floor defaults to dark — that's the working assumption. */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){try{var t=localStorage.getItem('qt-theme')||'dark';if(t!=='light')document.documentElement.classList.add('dark');}catch(_){document.documentElement.classList.add('dark');}})();
        `}} />
      </head>
      <body>
        <ThemeProvider>
          <NotifyProvider>{children}</NotifyProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
