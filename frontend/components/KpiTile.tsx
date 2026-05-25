interface KpiProps {
  label: string; value: string | number; hint?: string;
  tone?: 'default' | 'bid' | 'ask' | 'cyan' | 'amber' | 'plum';
}
export function KpiTile({ label, value, hint, tone = 'default' }: KpiProps) {
  const color =
    tone === 'bid'    ? 'rgb(var(--bid))' :
    tone === 'ask'    ? 'rgb(var(--ask))' :
    tone === 'cyan'   ? 'rgb(var(--cyan))' :
    tone === 'amber'  ? 'rgb(var(--amber))' :
    tone === 'plum'   ? 'rgb(var(--plum))' :
    'rgb(var(--ink))';
  return (
    <div className="kpi">
      <div className="eyebrow">{label}</div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {hint ? <div className="mono" style={{ fontSize: 10.5, color: 'rgb(var(--muted))', marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}
