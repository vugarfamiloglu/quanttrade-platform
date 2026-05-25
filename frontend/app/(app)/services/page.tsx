import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { KpiTile } from '@/components/KpiTile';
import { fmtNumber } from '@/lib/format';

export const dynamic = 'force-dynamic';

const SERVICES: Array<{ name: any; label: string; port: string }> = [
  { name: 'gateway',      label: 'API Gateway',       port: '5121' },
  { name: 'wallet',       label: 'Wallet Service',     port: '5122' },
  { name: 'matching',     label: 'Matching Engine',    port: '5123' },
  { name: 'clearing',     label: 'Clearing / Sagas',   port: '5124' },
  { name: 'market-data',  label: 'Market Data',        port: '5125' },
];

export default async function ServicesPage() {
  const rows = await Promise.all(SERVICES.map(async (s) => {
    const [health, metrics, stats] = await Promise.all([
      tryFetch<any>(s.name, '/health'),
      tryFetch<any>(s.name, '/metrics.json'),
      tryFetch<any>(s.name, '/stats'),
    ]);
    return { ...s, health, metrics, stats };
  }));

  const totalBreakers = rows.flatMap((r) => r.metrics?.breakers ?? []);
  const openBreakers  = totalBreakers.filter((b: any) => b.state !== 'closed');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <KpiTile label="Services up" value={rows.filter((r) => r.health?.ok).length + ' / ' + rows.length} tone={rows.every((r) => r.health?.ok) ? 'bid' : 'amber'} />
        <KpiTile label="Circuit breakers" value={totalBreakers.length} hint={openBreakers.length > 0 ? `${openBreakers.length} non-closed` : 'all closed'} tone={openBreakers.length > 0 ? 'ask' : 'bid'} />
      </div>

      <div className="card">
        <div className="card-header"><h3>Service Health</h3></div>
        <table className="t-table">
          <thead><tr><th>Service</th><th>Port</th><th>Status</th><th>Uptime</th><th>/metrics</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.label}</td>
                <td className="mono">{r.port}</td>
                <td>{r.health?.ok ? <StatusPill value="ok" /> : <StatusPill value="error" label="DOWN" />}</td>
                <td className="mono num">{r.health?.uptime_sec ?? '—'}{r.health?.uptime_sec ? 's' : ''}</td>
                <td className="mono" style={{ fontSize: 10.5 }}><a className="link" href={`/api/${r.name}/metrics`} target="_blank">prometheus</a> · <a className="link" href={`/api/${r.name}/metrics.json`} target="_blank">json</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalBreakers.length > 0 ? (
        <div className="card">
          <div className="card-header"><h3>Circuit Breakers</h3><span className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>downstream HTTP failure isolation</span></div>
          <table className="t-table">
            <thead><tr><th>Name</th><th>State</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Failed</th><th style={{ textAlign: 'right' }}>Rejected</th><th style={{ textAlign: 'right' }}>Opens</th></tr></thead>
            <tbody>
              {totalBreakers.map((b: any) => (
                <tr key={b.name}>
                  <td className="mono">{b.name}</td>
                  <td><StatusPill value={b.state} /></td>
                  <td className="num">{fmtNumber(b.total)}</td>
                  <td className="num" style={{ color: 'rgb(var(--ask))' }}>{fmtNumber(b.failed)}</td>
                  <td className="num" style={{ color: 'rgb(var(--amber))' }}>{fmtNumber(b.rejected)}</td>
                  <td className="num">{fmtNumber(b.opens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card">
        <div className="card-header"><h3>Per-Service Stats</h3></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, padding: 12 }}>
          {rows.map((r) => (
            <div key={r.name} className="surface-soft" style={{ padding: 10, fontSize: 11 }}>
              <div className="mono" style={{ fontWeight: 700, marginBottom: 5 }}>{r.label}</div>
              {r.stats ? <pre className="mono" style={{ fontSize: 10, color: 'rgb(var(--ink-2))', margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.stats, null, 1).slice(0, 600)}</pre> : <div style={{ color: 'rgb(var(--muted))' }}>offline</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
