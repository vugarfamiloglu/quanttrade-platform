/* Live event-bus tail.  We expose the broker's `recentEvents` view via
 * a tiny endpoint on the clearing service — it's the only place that
 * imports `lib/broker` at request time so it can read the broker DB. */

import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtRelative, shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Event { id: number; topic: string; payload: any; origin: string; ts: string; traceparent: string | null; }

export default async function EventsPage() {
  /* The broker is a shared SQLite file — any service can expose a read
   * endpoint.  We dual-source from clearing + matching + wallet stats
   * because no single service owns the broker. */
  const recent = await tryFetch<{ events: Event[] }>('clearing', '/events') ?? { events: [] };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="alert alert-info" style={{ fontSize: 11.5 }}>
        At-least-once delivery, per-(group, topic) offsets, W3C traceparent threaded through every envelope.  Failed messages move to the DLQ after 5 attempts.
      </div>
      <div className="card">
        <div className="card-header"><h3>Broker Event Tail</h3><span className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>{recent.events?.length ?? 0} shown</span></div>
        <table className="t-table">
          <thead><tr><th>#</th><th>Topic</th><th>Origin</th><th>Payload</th><th>Trace</th><th>When</th></tr></thead>
          <tbody>
            {(recent.events ?? []).map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ color: 'rgb(var(--muted))' }}>{e.id}</td>
                <td><StatusPill value={e.topic.split('.')[0] || e.topic} label={e.topic} /></td>
                <td className="mono" style={{ fontSize: 10.5 }}>{e.origin}</td>
                <td className="mono" style={{ fontSize: 10, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgb(var(--ink-2))' }}>
                  {JSON.stringify(e.payload).slice(0, 200)}
                </td>
                <td className="mono" style={{ fontSize: 9.5, color: 'rgb(var(--cyan))' }}>{e.traceparent ? e.traceparent.split('-')[1]?.slice(0, 8) + '…' : '—'}</td>
                <td className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>{fmtRelative(e.ts)}</td>
              </tr>
            ))}
            {(recent.events ?? []).length === 0 ? <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No events yet — place an order to populate.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
