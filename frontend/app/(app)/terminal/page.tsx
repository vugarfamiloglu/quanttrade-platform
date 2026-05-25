/* Terminal — order book + tape + order entry, one screen. */

import { tryFetch } from '@/lib/server';
import { fmtRaw, fmtRelative, scaleOf } from '@/lib/format';
import { TerminalClient } from './TerminalClient';

export const dynamic = 'force-dynamic';

export default async function TerminalPage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  const sp = await searchParams;
  const instruments = await tryFetch<{ instruments: any[] }>('matching', '/instruments') ?? { instruments: [] };
  const accounts    = await tryFetch<{ accounts: any[] }>('wallet', '/accounts') ?? { accounts: [] };

  const symbol = sp.symbol ?? instruments.instruments[0]?.symbol ?? 'AAPL';
  const [book, trades, quote] = await Promise.all([
    tryFetch<{ symbol: string; bids: any[]; asks: any[] }>('matching', `/book/${symbol}?depth=15`),
    tryFetch<{ trades: any[] }>('matching', `/trades/${symbol}?limit=20`),
    tryFetch<any>('market-data', `/quotes/${symbol}`),
  ]);

  const initialBook   = book   ?? { symbol, bids: [], asks: [] };
  const initialTrades = trades ?? { trades: [] };
  const initialQuote  = quote  ?? {};

  return (
    <TerminalClient
      symbol={symbol}
      instruments={instruments.instruments}
      accounts={accounts.accounts}
      initialBook={initialBook}
      initialTrades={initialTrades.trades}
      initialQuote={initialQuote}
    />
  );
}

/* Convenience export — keeps the page bundle small. */
export { fmtRaw, fmtRelative, scaleOf };
