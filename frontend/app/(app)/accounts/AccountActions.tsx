'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useNotify } from '@/components/NotifyProvider';

export function AccountActions({ accountId, publicId }: { accountId: string; publicId: string }) {
  const router = useRouter();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const rebuild = async () => {
    setBusy(true);
    try {
      const r = await api<any>('wallet', `/accounts/${accountId}/rebuild`, { method: 'POST' });
      notify.success(`${publicId} rebuilt`, { detail: `snapshot@${r.snapshot_seq} + ${r.events_replayed} events in ${r.recovery_ms}ms` });
      router.refresh();
    } catch (e: any) { notify.error('Rebuild failed', { detail: e?.message }); }
    finally { setBusy(false); }
  };
  return <button className="btn-secondary btn-xs" onClick={rebuild} disabled={busy}>{busy ? '…' : 'Rebuild from event log'}</button>;
}
