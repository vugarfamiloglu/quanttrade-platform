/**
 * Service-to-service HTTP client.
 *   • Circuit breaker per (service)
 *   • Bounded exponential backoff
 *   • W3C traceparent header propagation
 *
 * Failing fast when a downstream is sick is the difference between
 * one slow service and the whole platform falling over (cascading
 * failure).  The breaker enforces that boundary.
 */

import { getBreaker } from './circuit-breaker';
import { newTraceContext, formatTraceparent } from './trace';

const PORTS: Record<string, number> = {
  gateway:      Number(process.env.QT_GATEWAY_PORT      ?? 5121),
  wallet:       Number(process.env.QT_WALLET_PORT       ?? 5122),
  matching:     Number(process.env.QT_MATCHING_PORT     ?? 5123),
  clearing:     Number(process.env.QT_CLEARING_PORT     ?? 5124),
  'market-data':Number(process.env.QT_MARKET_DATA_PORT  ?? 5125),
};

export type ServiceName = keyof typeof PORTS;

export function baseUrl(service: ServiceName): string { return `http://localhost:${PORTS[service]}`; }

export class BreakerOpenError extends Error {
  constructor(service: string) {
    super(`circuit breaker open for ${service} — failing fast`);
    this.name = 'BreakerOpenError';
  }
}

interface CallOptions extends RequestInit {
  retries?:    number;
  retryBaseMs?: number;
  timeoutMs?:  number;
  traceparent?: string | null;
}

export async function call<T = any>(
  service: ServiceName, path: string, init: CallOptions = {},
): Promise<T> {
  const breaker = getBreaker(`http:${service}`);
  if (!breaker.allow()) throw new BreakerOpenError(service);

  const url = `${baseUrl(service)}${path.startsWith('/') ? '' : '/'}${path}`;
  /* Default 2 retries so transient localhost fetch hiccups on Windows
   * (Node's undici occasionally drops the first connection) don't trip
   * the breaker.  Callers that want stricter behaviour pass retries: 0. */
  const retries = init.retries ?? 2;
  const baseMs  = init.retryBaseMs ?? 80;
  const timeoutMs = init.timeoutMs ?? 15_000;
  const traceparent = init.traceparent ?? formatTraceparent(newTraceContext());

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'traceparent':  traceparent,
          ...(init.headers || {}),
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
      if (!res.ok) {
        /* 4xx is a client-side problem, not a downstream-health
         * problem — don't trip the breaker on those. */
        if (res.status >= 500) breaker.recordFailure();
        else                   breaker.recordSuccess();
        throw Object.assign(new Error((data && data.error) || `${service} ${path} → ${res.status}`), { __http: res.status, body: data });
      }
      breaker.recordSuccess();
      return data as T;
    } catch (e: any) {
      clearTimeout(timer);
      /* Network / timeout / 5xx — all count as downstream failure. */
      if (!e.__http || e.__http >= 500) breaker.recordFailure();
      lastErr = e;
      if (attempt < retries) {
        const delayMs = baseMs * Math.pow(2, attempt) + Math.random() * baseMs;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}
