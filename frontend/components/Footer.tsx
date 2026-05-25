export function Footer() {
  return (
    <footer className="mono" style={{
      padding: '8px 22px', borderTop: '1px solid rgb(var(--line))', background: 'rgb(var(--bg))',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'rgb(var(--muted))',
    }}>
      <div>QuantTrade Platform · event-sourced · saga-orchestrated · idempotent · circuit-broken</div>
      <div>Trading Floor build · {new Date().getFullYear()}</div>
    </footer>
  );
}
