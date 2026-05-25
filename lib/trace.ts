/**
 * W3C Trace Context.
 *
 *   traceparent = version "-" trace-id "-" parent-id "-" trace-flags
 *
 * traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 *              |  |                                |                |
 *              |  +-- 32-hex trace id              +-- 16-hex span  +-- flags
 *              +-- version
 *
 * Threading the same trace-id through gateway → service → kafka →
 * service-2 is what makes Jaeger able to render the full async chain.
 */

import { randomBytes } from 'node:crypto';

export interface TraceContext { traceId: string; spanId: string; sampled: boolean; }

export function parseTraceparent(header: string | undefined | null): TraceContext | null {
  if (!header) return null;
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;
  const [ver, traceId, spanId, flags] = parts;
  if (ver !== '00') return null;
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) return null;
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === '0'.repeat(16)) return null;
  const sampled = (parseInt(flags, 16) & 1) === 1;
  return { traceId, spanId, sampled };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

export function newTraceContext(): TraceContext {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId:  randomBytes(8).toString('hex'),
    sampled: true,
  };
}

/** When we receive an inbound traceparent we keep its trace-id but
 *  generate a fresh span-id for the work we're about to do. */
export function childSpan(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: randomBytes(8).toString('hex'), sampled: parent.sampled };
}

/** Convenience: returns either the parsed inbound context or a
 *  freshly minted one if the header was absent / malformed. */
export function ensureTraceContext(header: string | undefined | null): TraceContext {
  return parseTraceparent(header) ?? newTraceContext();
}
