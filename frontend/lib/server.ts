import 'server-only';

const PORTS: Record<string, number> = {
  gateway:       Number(process.env.QT_GATEWAY_PORT      ?? 5121),
  wallet:        Number(process.env.QT_WALLET_PORT       ?? 5122),
  matching:      Number(process.env.QT_MATCHING_PORT     ?? 5123),
  clearing:      Number(process.env.QT_CLEARING_PORT     ?? 5124),
  'market-data': Number(process.env.QT_MARKET_DATA_PORT  ?? 5125),
};

export type ServiceName = keyof typeof PORTS;

export function serviceUrl(service: ServiceName, path: string): string {
  return `http://localhost:${PORTS[service]}${path.startsWith('/') ? '' : '/'}${path}`;
}

export async function fetchService<T = any>(service: ServiceName, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(serviceUrl(service, path), { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }, cache: 'no-store' });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data) ? data.error : `${service} ${path} → ${res.status}`;
    throw Object.assign(new Error(String(msg)), { status: res.status, body: data });
  }
  return data as T;
}

export async function tryFetch<T = any>(service: ServiceName, path: string, init?: RequestInit): Promise<T | null> {
  try { return await fetchService<T>(service, path, init); }
  catch { return null; }
}
