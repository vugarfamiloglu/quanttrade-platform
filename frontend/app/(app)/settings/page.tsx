export const dynamic = 'force-dynamic';

const PORTS = [
  ['Frontend',       process.env.QT_FRONTEND_PORT    ?? '5120'],
  ['Gateway',        process.env.QT_GATEWAY_PORT     ?? '5121'],
  ['Wallet',         process.env.QT_WALLET_PORT      ?? '5122'],
  ['Matching',       process.env.QT_MATCHING_PORT    ?? '5123'],
  ['Clearing',       process.env.QT_CLEARING_PORT    ?? '5124'],
  ['Market Data',    process.env.QT_MARKET_DATA_PORT ?? '5125'],
];

const POLICIES = [
  ['JWT algorithm',                'EdDSA (Ed25519) — asymmetric, public key verified inline'],
  ['Rate limit (per principal)',   `${process.env.QT_RATE_LIMIT_RPS ?? '200'} RPS · burst ${(Number(process.env.QT_RATE_LIMIT_RPS ?? 200) * 2)}`],
  ['Idempotency TTL',              `${process.env.QT_IDEMPOTENCY_TTL_HOURS ?? '24'} h`],
  ['Snapshot every',               `${process.env.QT_SNAPSHOT_EVERY ?? '500'} wallet events`],
  ['Broker poll cadence',          `${process.env.QT_BROKER_POLL_MS ?? '120'} ms`],
  ['Broker DLQ threshold',         '5 failed attempts'],
  ['Circuit breaker',              `open after ${process.env.QT_BREAKER_FAILURE_THRESHOLD ?? '5'} failures in ${process.env.QT_BREAKER_WINDOW_MS ?? '10000'}ms · cool-off ${process.env.QT_BREAKER_RESET_MS ?? '30000'}ms`],
  ['Distributed lock',             'SQLite-backed Redlock contract · 5s TTL · per (account, asset)'],
];

export default function SettingsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card">
        <div className="card-header"><h3>Service Ports</h3><span className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>configure via .env.local</span></div>
        <table className="t-table">
          <thead><tr><th>Service</th><th style={{ textAlign: 'right' }}>Port</th><th>Health probe</th></tr></thead>
          <tbody>
            {PORTS.map(([n, p]) => (
              <tr key={n}>
                <td>{n}</td>
                <td className="mono num">{p}</td>
                <td><code className="kbd">http://localhost:{p}/health</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-header"><h3>Operational Policies</h3></div>
        <table className="t-table">
          <thead><tr><th>Policy</th><th>Value</th></tr></thead>
          <tbody>
            {POLICIES.map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="mono" style={{ fontSize: 11 }}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="alert alert-info">
        Every mutating endpoint accepts <code className="kbd">Idempotency-Key</code>; use it on every retry.  Every endpoint flows the W3C <code className="kbd">traceparent</code> header through to upstreams so Jaeger / Tempo can stitch the async chain together.
      </div>
    </div>
  );
}
