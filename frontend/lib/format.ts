/* Display formatters — independent of @lib/decimal so they can run
 * in client components without pulling the BigInt arithmetic core. */

export const ASSET_SCALE: Record<string, number> = {
  USD: 2, USDT: 2, EUR: 2, GBP: 2, JPY: 0,
  BTC: 8, ETH: 8, SOL: 6,
  AAPL: 4, MSFT: 4, NVDA: 4, TSLA: 4, GOOG: 4,
};

export function scaleOf(asset: string): number { return ASSET_SCALE[asset] ?? 2; }

export function fmtRaw(raw: string | bigint | number | null | undefined, asset: string, opts: { grouping?: boolean; signed?: boolean } = {}): string {
  if (raw == null) return '—';
  const scale = scaleOf(asset);
  const v = typeof raw === 'bigint' ? raw : BigInt(String(raw));
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const wholeStr = opts.grouping !== false
    ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : whole.toString();
  const fracStr = scale === 0 ? '' : '.' + frac.toString().padStart(scale, '0');
  const sign = neg ? '-' : (opts.signed && v > 0n ? '+' : '');
  return `${sign}${wholeStr}${fracStr}`;
}

export function fmtNumber(n: number | string, decimals = 0): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export function fmtPercent(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function fmtDate(input: string | Date, opts: { time?: boolean } = { time: true }): string {
  const d = typeof input === 'string' ? new Date(input.includes('T') ? input : input.replace(' ', 'T') + 'Z') : input;
  if (isNaN(d.getTime())) return String(input);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!opts.time) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtRelative(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input.includes('T') ? input : input.replace(' ', 'T') + 'Z') : input;
  if (isNaN(d.getTime())) return String(input);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 5)     return 'just now';
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return fmtDate(d, { time: false });
}

export function shortId(s: string | null | undefined, head = 8, tail = 4): string {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
