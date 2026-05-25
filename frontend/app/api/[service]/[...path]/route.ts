import { NextRequest } from 'next/server';
import { serviceUrl, type ServiceName } from '@/lib/server';

const ALLOWED: ServiceName[] = ['gateway', 'wallet', 'matching', 'clearing', 'market-data'];
const PORT_FOR: Record<ServiceName, string> = {
  gateway:       process.env.QT_GATEWAY_PORT      ?? '5121',
  wallet:        process.env.QT_WALLET_PORT       ?? '5122',
  matching:      process.env.QT_MATCHING_PORT     ?? '5123',
  clearing:      process.env.QT_CLEARING_PORT     ?? '5124',
  'market-data': process.env.QT_MARKET_DATA_PORT  ?? '5125',
};

function describeFailure(service: ServiceName, e: any): string {
  const port = PORT_FOR[service];
  const code = e?.cause?.code ?? e?.code;
  if (code === 'ECONNREFUSED') return `${service} not reachable on port ${port} — run "npm run dev:${service}" (or "npm run dev" for everything).`;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `${service} on port ${port} timed out.`;
  if (code === 'ECONNRESET') return `${service} on port ${port} dropped the connection — check its logs.`;
  return `gateway → ${service} (port ${port}): ${e?.message ?? 'unreachable'}${code ? ` [${code}]` : ''}`;
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ service: string; path: string[] }> }) {
  const { service, path } = await ctx.params;
  if (!ALLOWED.includes(service as ServiceName)) {
    return new Response(JSON.stringify({ error: `unknown service: ${service}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  const subPath = (path ?? []).join('/');
  const search = req.nextUrl.searchParams.toString();
  const url = serviceUrl(service as ServiceName, `/${subPath}${search ? '?' + search : ''}`);

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (['host', 'connection', 'accept-encoding', 'content-length'].includes(k.toLowerCase())) return;
    headers[k] = v;
  });

  const init: RequestInit = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) init.body = await req.text();

  try {
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' } });
  } catch (e: any) {
    const message = describeFailure(service as ServiceName, e);
    console.warn(`[gateway] ${req.method} /${subPath} → ${service} failed:`, message);
    return new Response(JSON.stringify({ error: message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}

export const GET = proxy; export const POST = proxy; export const PUT = proxy; export const PATCH = proxy; export const DELETE = proxy;
