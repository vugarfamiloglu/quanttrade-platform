'use client';

export async function api<T = any>(service: string, path: string, init?: RequestInit): Promise<T> {
  const url = `/api/${service}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data) ? data.error : `${service} ${path} → ${res.status}`;
    throw Object.assign(new Error(String(msg)), { status: res.status, body: data });
  }
  return data as T;
}
