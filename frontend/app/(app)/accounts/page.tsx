import { tryFetch } from '@/lib/server';
import { fmtRaw, fmtDate, shortId } from '@/lib/format';
import { AccountActions } from './AccountActions';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const data = await tryFetch<{ accounts: any[] }>('wallet', '/accounts');
  const accounts = data?.accounts ?? [];

  /* Fetch balances for each account in parallel — cheap because cached. */
  const enriched = await Promise.all(
    accounts.map(async (a) => {
      const r = await tryFetch<any>('wallet', `/accounts/${a.id}`);
      const snapshots = await tryFetch<any>('wallet', `/accounts/${a.id}/snapshots`);
      return { ...a, balances: r?.balances ?? [], snapshot_count: snapshots?.snapshots?.length ?? 0, latest_snapshot_seq: snapshots?.snapshots?.[0]?.up_to_seq ?? null };
    }),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="alert alert-info" style={{ fontSize: 11.5 }}>
        Every balance is the left-fold of the account's wallet event log.  Snapshots compress cold-start recovery (RTO) so we don't replay millions of events on restart.
      </div>

      {enriched.length === 0 ? (
        <div className="alert alert-warning">No accounts yet — run <code className="kbd">npm run seed</code>.</div>
      ) : null}

      {enriched.map((a) => (
        <div key={a.id} className="card">
          <div className="card-header">
            <div>
              <h3 style={{ display: 'inline-block', marginRight: 12 }}>{a.public_id}</h3>
              <span className="mono" style={{ fontSize: 11, color: 'rgb(var(--ink))' }}>{a.display_name}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'rgb(var(--muted))', marginLeft: 10 }}>{a.email}</span>
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>
              {a.snapshot_count} snapshot(s){a.latest_snapshot_seq ? ` · latest @seq=${a.latest_snapshot_seq}` : ''}
            </div>
          </div>
          <table className="t-table">
            <thead><tr><th>Asset</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Held</th><th style={{ textAlign: 'right' }}>Available</th><th>Updated</th></tr></thead>
            <tbody>
              {a.balances.map((b: any) => (
                <tr key={b.asset}>
                  <td className="mono" style={{ fontWeight: 600 }}>{b.asset}</td>
                  <td className="num mono">{fmtRaw(b.total_raw, b.asset)}</td>
                  <td className="num mono" style={{ color: 'rgb(var(--amber))' }}>{fmtRaw(b.held_raw, b.asset)}</td>
                  <td className="num mono up">{fmtRaw(b.available_raw, b.asset)}</td>
                  <td className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>{fmtDate(b.updated_at)}</td>
                </tr>
              ))}
              {a.balances.length === 0 ? <tr><td colSpan={5} style={{ padding: 12, textAlign: 'center', color: 'rgb(var(--muted))' }}>no balances</td></tr> : null}
            </tbody>
          </table>
          <div style={{ padding: '8px 14px', borderTop: '1px solid rgb(var(--line-soft))', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <a href={`/api/wallet/accounts/${a.id}/events`} className="link mono" style={{ fontSize: 10.5 }} target="_blank">view raw event log →</a>
            <AccountActions accountId={a.id} publicId={a.public_id} />
          </div>
        </div>
      ))}
    </div>
  );
}
