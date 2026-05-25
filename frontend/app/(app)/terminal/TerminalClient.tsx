'use client';

/* The full trading-terminal experience.
 * Three panels in a fixed grid: order book (left), recent trades (right),
 * order entry (below).  Polls the matching engine every 1.5s for fresh
 * depth + tape; the SSE stream from market-data updates the price ticker
 * above the order entry. */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useNotify } from '@/components/NotifyProvider';
import { fmtRaw, fmtRelative, scaleOf } from '@/lib/format';
import { StatusPill } from '@/components/StatusPill';
import { ConfirmModal } from '@/components/ConfirmModal';

interface Props {
  symbol: string;
  instruments: any[];
  accounts: any[];
  initialBook: { symbol: string; bids: any[]; asks: any[] };
  initialTrades: any[];
  initialQuote: any;
}

export function TerminalClient({ symbol, instruments, accounts, initialBook, initialTrades, initialQuote }: Props) {
  const inst = instruments.find((i) => i.symbol === symbol);
  const baseScale  = inst ? scaleOf(inst.base)  : 4;
  const quoteScale = inst ? scaleOf(inst.quote) : 2;

  const [book,   setBook]   = useState(initialBook);
  const [trades, setTrades] = useState(initialTrades);
  const [quote,  setQuote]  = useState(initialQuote);

  /* Poll the matching engine.  Faster than waiting for events to ripple
   * to the UI and good enough for human eyes (~2 cycles/sec). */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [b, t] = await Promise.all([
          api<any>('matching', `/book/${symbol}?depth=15`),
          api<any>('matching', `/trades/${symbol}?limit=20`),
        ]);
        if (!alive) return;
        setBook(b); setTrades(t.trades);
      } catch { /* services may be down; show the stale snapshot */ }
    };
    const i = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(i); };
  }, [symbol]);

  /* Subscribe to /market-data SSE stream for the headline ticker. */
  useEffect(() => {
    const es = new EventSource(`/api/market-data/stream`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.symbol === symbol) setQuote(payload);
      } catch { /* malformed frame */ }
    };
    return () => es.close();
  }, [symbol]);

  /* Depth visualisation — normalize against the largest level so each
   * row's bar reflects its share of visible liquidity. */
  const maxBidQty = useMemo(() => book.bids.reduce((m, r: any) => Math.max(m, Number(r.qty_raw)), 1), [book]);
  const maxAskQty = useMemo(() => book.asks.reduce((m, r: any) => Math.max(m, Number(r.qty_raw)), 1), [book]);

  /* Last price — derive trend from previous trade. */
  const lastPrice  = quote?.last_raw ?? trades[0]?.price_raw ?? '0';
  const prevPrice  = trades[1]?.price_raw ?? lastPrice;
  const trend      = BigInt(lastPrice) > BigInt(prevPrice) ? 'up' : BigInt(lastPrice) < BigInt(prevPrice) ? 'down' : 'flat';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Top strip: instrument selector + headline price ── */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px' }}>
        <div>
          <div className="eyebrow">Instrument</div>
          <select
            className="select mono"
            value={symbol}
            onChange={(e) => { window.location.href = `/terminal?symbol=${e.target.value}`; }}
            style={{ marginTop: 4, width: 220 }}
          >
            {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.display_name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: 'right' }}>
          <div className="eyebrow">Last</div>
          <div className={`tick ${trend}`} style={{ fontSize: 22 }}>
            {fmtRaw(lastPrice, inst?.quote ?? 'USD')}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="eyebrow">24h Vol</div>
          <div className="tick" style={{ fontSize: 14 }}>{quote?.vol_24h_raw ? Number(quote.vol_24h_raw).toLocaleString() : '—'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="eyebrow">Best Bid · Ask</div>
          <div className="mono" style={{ fontSize: 13 }}>
            <span className="bid-text">{book.bids[0] ? fmtRaw(book.bids[0].price_raw, inst?.quote ?? 'USD') : '—'}</span>
            {' · '}
            <span className="ask-text">{book.asks[0] ? fmtRaw(book.asks[0].price_raw, inst?.quote ?? 'USD') : '—'}</span>
          </div>
        </div>
      </div>

      {/* ── Main: book (left, 2 cols) + tape (right) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, alignItems: 'stretch' }}>

        {/* Order book */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="card-header"><h3>Order Book · {symbol}</h3><span className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>price-time priority</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
            {/* Bids */}
            <div>
              <table className="t-table" style={{ width: '100%' }}>
                <thead><tr><th>Bid Price</th><th style={{ textAlign: 'right' }}>Qty</th></tr></thead>
                <tbody>
                  {book.bids.map((r: any, idx: number) => (
                    <tr key={idx} className="book-row">
                      <td className="bid-text">{fmtRaw(r.price_raw, inst?.quote ?? 'USD')}</td>
                      <td className="num">{fmtRaw(r.qty_raw, inst?.base ?? 'AAPL', { grouping: false })}</td>
                      <div className="depth depth-bid" style={{ width: `${Math.min(100, (Number(r.qty_raw) / maxBidQty) * 100)}%` }} />
                    </tr>
                  ))}
                  {book.bids.length === 0 ? <tr><td colSpan={2} style={{ padding: 16, textAlign: 'center', color: 'rgb(var(--muted))' }}>no bids</td></tr> : null}
                </tbody>
              </table>
            </div>
            {/* Asks */}
            <div style={{ borderLeft: '1px dashed rgb(var(--line))' }}>
              <table className="t-table" style={{ width: '100%' }}>
                <thead><tr><th>Ask Price</th><th style={{ textAlign: 'right' }}>Qty</th></tr></thead>
                <tbody>
                  {book.asks.map((r: any, idx: number) => (
                    <tr key={idx} className="book-row">
                      <td className="ask-text">{fmtRaw(r.price_raw, inst?.quote ?? 'USD')}</td>
                      <td className="num">{fmtRaw(r.qty_raw, inst?.base ?? 'AAPL', { grouping: false })}</td>
                      <div className="depth depth-ask" style={{ width: `${Math.min(100, (Number(r.qty_raw) / maxAskQty) * 100)}%` }} />
                    </tr>
                  ))}
                  {book.asks.length === 0 ? <tr><td colSpan={2} style={{ padding: 16, textAlign: 'center', color: 'rgb(var(--muted))' }}>no asks</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ padding: '8px 14px', borderTop: '1px solid rgb(var(--line-soft))', display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'rgb(var(--muted))' }}>
            <span><span className="live-dot" />polling every 1.5s</span>
            <span>showing {book.bids.length + book.asks.length} levels</span>
          </div>
        </div>

        {/* Tape (recent trades) */}
        <div className="card">
          <div className="card-header"><h3>Tape</h3><span className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>{trades.length} fills</span></div>
          <table className="t-table">
            <thead><tr><th>Price</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>When</th></tr></thead>
            <tbody>
              {trades.map((t: any, idx: number) => {
                const prevPx = trades[idx + 1]?.price_raw ?? t.price_raw;
                const cls = BigInt(t.price_raw) > BigInt(prevPx) ? 'bid-text' : BigInt(t.price_raw) < BigInt(prevPx) ? 'ask-text' : 'flat';
                return (
                  <tr key={t.id}>
                    <td className={cls}>{fmtRaw(t.price_raw, inst?.quote ?? 'USD')}</td>
                    <td className="num">{fmtRaw(t.qty_raw, inst?.base ?? 'AAPL', { grouping: false })}</td>
                    <td className="num" style={{ color: 'rgb(var(--muted))', fontSize: 10.5 }}>{fmtRelative(t.ts)}</td>
                  </tr>
                );
              })}
              {trades.length === 0 ? <tr><td colSpan={3} style={{ padding: 16, textAlign: 'center', color: 'rgb(var(--muted))' }}>no trades yet</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Order entry ── */}
      <OrderEntry symbol={symbol} accounts={accounts} inst={inst} baseScale={baseScale} quoteScale={quoteScale} bestBid={book.bids[0]?.price_raw} bestAsk={book.asks[0]?.price_raw} />
    </div>
  );
}

function OrderEntry({ symbol, accounts, inst, bestBid, bestAsk }: any) {
  const notify = useNotify();
  const [side,  setSide]  = useState<'BUY' | 'SELL'>('BUY');
  const [type,  setType]  = useState<'LIMIT' | 'MARKET'>('LIMIT');
  const [price, setPrice] = useState('');
  const [qty,   setQty]   = useState('');
  const [account, setAccount] = useState(accounts[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  /* Suggest the touch price when switching sides — typical trader UX. */
  useEffect(() => {
    if (type !== 'LIMIT') return;
    const inferred = side === 'BUY' ? bestAsk : bestBid;
    if (inferred && !price) setPrice(fmtRaw(inferred, inst?.quote ?? 'USD', { grouping: false }));
  }, [side, type, bestBid, bestAsk]);

  const send = async () => {
    setBusy(true);
    try {
      const body: any = {
        account_id: account, instrument: symbol, side, type, qty,
        tif: 'GTC',
      };
      if (type === 'LIMIT') body.price = price;
      const r = await api<any>('clearing', '/sagas/place-order', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      const saga = r.saga ?? r;
      if (saga.status === 'completed') notify.success(`Order placed`, { detail: `saga ${saga.public_id} completed` });
      else if (saga.status === 'compensated') notify.warning(`Order compensated`, { detail: saga.failed_reason });
      else notify.error(`Saga ${saga.status}`, { detail: saga.failed_reason ?? 'unknown' });
    } catch (e: any) { notify.error('Place failed', { detail: e?.message }); }
    finally { setBusy(false); setConfirmOpen(false); }
  };

  return (
    <div className="card">
      <div className="card-header"><h3>Order Entry · {symbol}</h3><Link href="/orders" className="link" style={{ fontSize: 10.5 }}>full history →</Link></div>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) auto', gap: 12, alignItems: 'flex-end' }}>
        <div>
          <label className="label">Account</label>
          <select className="select mono" value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.display_name} ({a.public_id})</option>)}
            {accounts.length === 0 ? <option value="">(no accounts — run seed)</option> : null}
          </select>
        </div>
        <div>
          <label className="label">Side</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={side === 'BUY' ? 'btn-buy' : 'btn-secondary'} onClick={() => setSide('BUY')} style={{ flex: 1 }}>BUY</button>
            <button type="button" className={side === 'SELL' ? 'btn-sell' : 'btn-secondary'} onClick={() => setSide('SELL')} style={{ flex: 1 }}>SELL</button>
          </div>
        </div>
        <div>
          <label className="label">Type</label>
          <select className="select mono" value={type} onChange={(e) => setType(e.target.value as 'LIMIT' | 'MARKET')}>
            <option value="LIMIT">LIMIT</option>
            <option value="MARKET">MARKET</option>
          </select>
        </div>
        <div>
          <label className="label">Price {type === 'MARKET' ? '(market)' : ''}</label>
          <input className="input mono" inputMode="decimal" value={price} disabled={type === 'MARKET'} onChange={(e) => setPrice(e.target.value)} placeholder={type === 'MARKET' ? 'market' : '0.00'} />
        </div>
        <div>
          <label className="label">Qty ({inst?.base ?? 'units'})</label>
          <input className="input mono" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
        </div>
        <div>
          <button className={side === 'BUY' ? 'btn-buy' : 'btn-sell'} disabled={busy || !qty || (type === 'LIMIT' && !price) || !account} onClick={() => setConfirmOpen(true)}>
            {busy ? '…' : (side === 'BUY' ? 'Place BUY' : 'Place SELL')}
          </button>
        </div>
      </div>
      <ConfirmModal
        open={confirmOpen}
        title={`${side} ${qty} ${inst?.base ?? ''} ${type === 'LIMIT' ? `@ ${price}` : '@ market'}`}
        message={`This will run the place_order saga: reserve_funds → submit_order → process_fills → settle.  Any step failing rolls the previous steps back via compensations.`}
        confirmLabel={side === 'BUY' ? 'BUY' : 'SELL'}
        destructive={side === 'SELL'}
        busy={busy}
        onClose={() => setConfirmOpen(false)}
        onConfirm={send}
      />
    </div>
  );
}
