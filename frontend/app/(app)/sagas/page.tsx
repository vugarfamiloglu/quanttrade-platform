import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtRelative, fmtDate, shortId } from '@/lib/format';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function SagasPage({ searchParams }: { searchParams: Promise<{ status?: string; id?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  qs.set('limit', '100');
  const list = await tryFetch<{ sagas: any[] }>('clearing', `/sagas?${qs.toString()}`);
  const selected = sp.id ? await tryFetch<{ saga: any; steps: any[] }>('clearing', `/sagas/${sp.id}`) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Link href="/sagas" className={!sp.status ? 'pill pill-cyan' : 'pill pill-muted'}>ALL</Link>
        {['running', 'completed', 'compensating', 'compensated', 'failed'].map((s) =>
          <Link key={s} href={`/sagas?status=${s}`} className={sp.status === s ? 'pill pill-cyan' : 'pill pill-muted'}>{s}</Link>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.8fr', gap: 12, alignItems: 'flex-start' }}>

        <div className="card">
          <div className="card-header"><h3>Recent Sagas</h3></div>
          <table className="t-table">
            <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Step</th><th>When</th></tr></thead>
            <tbody>
              {(list?.sagas ?? []).map((s) => {
                const sel = sp.id === s.id || sp.id === s.public_id;
                return (
                  <tr key={s.id} style={sel ? { background: 'rgba(56, 189, 248, .07)' } : undefined}>
                    <td className="mono" style={{ fontSize: 10.5 }}>
                      <Link href={`/sagas?id=${s.public_id}${sp.status ? '&status=' + sp.status : ''}`} className="link">{s.public_id}</Link>
                    </td>
                    <td className="mono">{s.kind}</td>
                    <td><StatusPill value={s.status} /></td>
                    <td className="num" style={{ fontSize: 11 }}>{s.current_step}/{s.total_steps}</td>
                    <td className="mono" style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>{fmtRelative(s.created_at)}</td>
                  </tr>
                );
              })}
              {(list?.sagas ?? []).length === 0 ? <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No sagas yet.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header"><h3>Saga Detail{selected ? ` · ${selected.saga.public_id}` : ''}</h3></div>
          {selected ? (
            <div style={{ padding: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: 11.5, marginBottom: 14 }}>
                <span className="eyebrow">Kind</span><span className="mono">{selected.saga.kind}</span>
                <span className="eyebrow">Status</span><span><StatusPill value={selected.saga.status} /></span>
                <span className="eyebrow">Started</span><span className="mono" style={{ fontSize: 11 }}>{fmtDate(selected.saga.created_at)}</span>
                {selected.saga.failed_reason ? <><span className="eyebrow">Failure</span><span style={{ color: 'rgb(var(--ask))' }}>{selected.saga.failed_reason}</span></> : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selected.steps.map((step) => (
                  <div key={step.id} className={`saga-step ${step.status}`}>
                    <span className="mono" style={{ width: 22, color: 'rgb(var(--muted))' }}>{step.position}</span>
                    <span style={{ flex: 1 }}>{step.name}</span>
                    <StatusPill value={step.status} />
                    {step.compensation_name ? <span className="mono pill pill-amber" style={{ fontSize: 9 }}>↻ {step.compensation_name}</span> : null}
                    {step.error ? <span className="mono" style={{ fontSize: 10, color: 'rgb(var(--ask))', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{step.error}</span> : null}
                  </div>
                ))}
              </div>
              <details style={{ marginTop: 14, fontSize: 11 }}>
                <summary style={{ cursor: 'pointer', color: 'rgb(var(--muted))', fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>raw input + context (debug)</summary>
                <pre className="mono" style={{ fontSize: 10, color: 'rgb(var(--ink-2))', background: 'rgb(var(--bg-soft))', padding: 10, borderRadius: 3, overflowX: 'auto', marginTop: 6 }}>{JSON.stringify({ input: JSON.parse(selected.saga.input_json), context: JSON.parse(selected.saga.context_json) }, null, 2)}</pre>
              </details>
            </div>
          ) : (
            <div style={{ padding: 22, textAlign: 'center', color: 'rgb(var(--muted))', fontSize: 12 }}>Pick a saga on the left to inspect its step-by-step flow.</div>
          )}
        </div>
      </div>
    </div>
  );
}
