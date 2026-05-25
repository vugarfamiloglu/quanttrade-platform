type Variant = 'bid' | 'ask' | 'cyan' | 'amber' | 'plum' | 'steel' | 'muted';
const MAP: Record<string, Variant> = {
  /* Orders */ NEW: 'cyan', OPEN: 'cyan', PARTIALLY_FILLED: 'amber', FILLED: 'bid',
  CANCELLED: 'muted', REJECTED: 'ask',
  /* Sides */  BUY: 'bid', SELL: 'ask',
  /* TIF */    GTC: 'steel', IOC: 'plum', FOK: 'plum',
  /* Sagas */  pending: 'steel', running: 'cyan', compensating: 'amber', completed: 'bid', compensated: 'amber', failed: 'ask',
  /* Steps */  in_progress: 'cyan', succeeded: 'bid', skipped: 'muted',
  /* Breaker */closed: 'bid', open: 'ask', half_open: 'amber',
  /* Misc */   ok: 'bid', warning: 'amber', error: 'ask', active: 'bid', inactive: 'muted',
};
export function StatusPill({ value, label }: { value: string; label?: string }) {
  const v = String(value ?? '').toLowerCase();
  /* Try case-insensitive lookup first, then exact. */
  const variant = MAP[value] ?? MAP[v] ?? 'muted';
  return <span className={`pill pill-${variant}`}>{(label ?? value ?? '—').toString().toUpperCase().replace('_', ' ')}</span>;
}
