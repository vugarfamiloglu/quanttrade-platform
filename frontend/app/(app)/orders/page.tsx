import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtRaw, fmtRelative, shortId } from '@/lib/format';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const k of ['status', 'instrument', 'account_id'] as const) if (sp[k]) qs.set(k, sp[k]);
  qs.set('limit', '200');
  const data = await tryFetch<{ orders: any[]; total: number }>('matching', `/orders?${qs.toString()}`);
  const orders = data?.orders ?? [];
  const instruments = await tryFetch<{ instruments: any[] }>('matching', '/instruments');
  const instMap = new Map((instruments?.instruments ?? []).map((i) => [i.symbol, i]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Link href="/orders" className={!sp.status ? 'pill pill-cyan' : 'pill pill-muted'}>ALL</Link>
        {['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'].map((s) =>
          <Link key={s} href={`/orders?status=${s}`} className={sp.status === s ? 'pill pill-cyan' : 'pill pill-muted'}>{s.replace('_', ' ')}</Link>
        )}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: 'rgb(var(--muted))' }}>{data?.total ?? 0} matching</span>
      </div>

      <div className="card">
        <table className="t-table">
          <thead><tr>
            <th>ID</th><th>Instrument</th><th>Side</th><th>Type</th>
            <th style={{ textAlign: 'right' }}>Price</th>
            <th style={{ textAlign: 'right' }}>Qty</th>
            <th style={{ textAlign: 'right' }}>Filled</th>
            <th>Status</th><th>Saga</th><th>When</th>
          </tr></thead>
          <tbody>
            {orders.map((o) => {
              const inst = instMap.get(o.instrument);
              const fillRatio = Number(o.filled_qty_raw) / Number(o.qty_raw);
              return (
                <tr key={o.id}>
                  <td className="mono" style={{ fontSize: 10.5 }}>{o.public_id}</td>
                  <td className="mono">{o.instrument}</td>
                  <td><StatusPill value={o.side} /></td>
                  <td className="mono">{o.type}</td>
                  <td className={o.side === 'BUY' ? 'bid-text mono num' : 'ask-text mono num'}>
                    {o.price_raw ? fmtRaw(o.price_raw, inst?.quote ?? 'USD') : 'MKT'}
                  </td>
                  <td className="num mono">{fmtRaw(o.qty_raw, inst?.base ?? 'AAPL', { grouping: false })}</td>
                  <td className="num mono">{fmtRaw(o.filled_qty_raw, inst?.base ?? 'AAPL', { grouping: false })} <span style={{ color: 'rgb(var(--muted))', fontSize: 10 }}>({(fillRatio * 100).toFixed(0)}%)</span></td>
                  <td><StatusPill value={o.status} /></td>
                  <td className="mono" style={{ fontSize: 10 }}>{shortId(o.saga_id, 6, 4)}</td>
                  <td className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>{fmtRelative(o.created_at)}</td>
                </tr>
              );
            })}
            {orders.length === 0 ? <tr><td colSpan={10} style={{ padding: 22, textAlign: 'center', color: 'rgb(var(--muted))' }}>No orders match the filter.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
