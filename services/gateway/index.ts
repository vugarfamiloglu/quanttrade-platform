/**
 * API Gateway (port 5121).
 *
 * Sits between every client and the internal mesh.  Four jobs:
 *
 *   1. Inline JWT verification (ED25519 public key cached in memory) —
 *      no DB round-trip per request, the whole point of asymmetric
 *      keys.  Without this we cannot hit our 100k RPS target.
 *
 *   2. Idempotency dedup — the X-Idempotency-Key header is captured
 *      and the result of the first successful POST is cached.  Same
 *      key replayed → cached response.  Same key with different body
 *      → 409.
 *
 *   3. Rate limit — token bucket per principal.  Refill rate set by
 *      env QT_RATE_LIMIT_RPS.
 *
 *   4. Route + propagate — body forwarded untouched to the right
 *      internal service.  W3C `traceparent` header is generated or
 *      preserved so the whole call chain joins one trace.
 *
 * Token minting also lives here (POST /auth/token) for local dev so
 * clients can grab a JWT without standing up a separate auth service.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb } from '../../lib/db';
import { withIdempotency, IdempotencyConflictError } from '../../lib/idempotency';
import { call as upstreamCall, type ServiceName, baseUrl } from '../../lib/http';
import { sign, verify, generateKeypair, JwtError } from '../../lib/jwt';
import { counter, histogram } from '../../lib/metrics';
import { formatTraceparent, parseTraceparent } from '../../lib/trace';
import type { Request, Response, NextFunction } from 'express';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { app, log, port } = bootService({
  name: 'gateway',
  port: Number(process.env.QT_GATEWAY_PORT ?? 5121),
});

const db = openDb('gateway');

/* ── JWT keypair bootstrap ───────────────────────────────────────────
 * Read from env, otherwise generate-and-persist on first boot so
 * local dev is friction-free.  In prod these would be mounted as
 * secrets (Vault / SOPS / sealed-secrets). */

const keyFile = resolve(process.cwd(), 'data', 'gateway-jwt.json');
let PRIV_KEY = process.env.QT_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n') || '';
let PUB_KEY  = process.env.QT_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n')  || '';
if (!PRIV_KEY || !PUB_KEY) {
  if (existsSync(keyFile)) {
    const cached = JSON.parse(readFileSync(keyFile, 'utf8'));
    PRIV_KEY = cached.privateKey; PUB_KEY = cached.publicKey;
    log.info('JWT keypair loaded from data/gateway-jwt.json');
  } else {
    const kp = generateKeypair();
    PRIV_KEY = kp.privateKey; PUB_KEY = kp.publicKey;
    writeFileSync(keyFile, JSON.stringify(kp, null, 2));
    log.warn('JWT keypair was missing — generated a fresh dev pair and wrote it to data/gateway-jwt.json. ROTATE BEFORE PROD.');
  }
}

/* ── Token-bucket rate limiter ───────────────────────────────────────
 * Per-principal in-memory buckets.  A real deployment shards this
 * across replicas via Redis; the contract (allow / reject + retry
 * after) is identical. */

const RATE_RPS    = Math.max(10, Number(process.env.QT_RATE_LIMIT_RPS ?? 200));
const RATE_BURST  = RATE_RPS * 2;
interface Bucket { tokens: number; updatedAt: number; }
const buckets = new Map<string, Bucket>();
function consume(principal: string, n = 1): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let b = buckets.get(principal);
  if (!b) { b = { tokens: RATE_BURST, updatedAt: now }; buckets.set(principal, b); }
  const refill = ((now - b.updatedAt) / 1000) * RATE_RPS;
  b.tokens = Math.min(RATE_BURST, b.tokens + refill);
  b.updatedAt = now;
  if (b.tokens >= n) { b.tokens -= n; return { allowed: true, retryAfterMs: 0 }; }
  const need = n - b.tokens;
  return { allowed: false, retryAfterMs: Math.ceil((need / RATE_RPS) * 1000) };
}

/* ── Public key + token issuance ─────────────────────────────────── */

app.get('/auth/public-key', (_req: Request, res: Response) => res.type('text/plain').send(PUB_KEY));

app.post('/auth/token', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account_id, scope, ttl_minutes } = req.body ?? {};
    if (!account_id) bad(422, 'account_id is required');
    const ttl = Math.max(1, Math.min(7 * 24 * 60, Number(ttl_minutes ?? 60)));
    const token = sign({
      sub: account_id,
      exp: Math.floor(Date.now() / 1000) + ttl * 60,
      scope: Array.isArray(scope) ? scope : ['trade', 'read'],
    }, PRIV_KEY);
    log.info(`minted token for ${account_id} (ttl ${ttl}m)`);
    res.json({ token, expires_in_sec: ttl * 60, principal: account_id });
  } catch (e) { next(e); }
});

/* ── Auth middleware ─────────────────────────────────────────────── */

interface Principal { sub: string; scope: string[]; }
declare module 'express-serve-static-core' {
  interface Request { principal?: Principal; }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const h = req.header('authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'missing Bearer token' }); return; }
  try {
    const payload = verify(m[1], PUB_KEY);
    req.principal = { sub: payload.sub, scope: Array.isArray(payload.scope) ? payload.scope : [] };
    next();
  } catch (e: any) {
    if (e instanceof JwtError) { res.status(401).json({ error: `jwt: ${e.reason}` }); return; }
    next(e);
  }
}

/* ── Rate limit + idempotency middleware (POST/PUT/DELETE only) ──── */

const reqCounter = counter('qt_gateway_requests_total', 'Gateway requests total');

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const principal = req.principal?.sub ?? `anon:${req.ip}`;
  const out = consume(principal);
  if (!out.allowed) {
    reqCounter.inc({ outcome: 'rate_limited' });
    res.setHeader('Retry-After', String(Math.ceil(out.retryAfterMs / 1000)));
    res.status(429).json({ error: 'rate limit exceeded', retry_after_ms: out.retryAfterMs });
    return;
  }
  next();
}

/* ── Proxy ───────────────────────────────────────────────────────── */

const ALLOWED: ServiceName[] = ['wallet', 'matching', 'clearing', 'market-data'];

/**
 * POST /:service/:path  →  forwarded as POST to that service.
 * Same for GET/PUT/DELETE.
 *
 * Idempotency-Key, when present, is upgraded from "client hint" to
 * "binding contract": the first successful response is cached for
 * `QT_IDEMPOTENCY_TTL_HOURS`.  Same key replayed returns the cached
 * response; same key + different body → 409.
 */
async function proxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const service = req.params.service as ServiceName;
    if (!ALLOWED.includes(service)) bad(404, `unknown service: ${service}`);
    const subpath = '/' + (req.params[0] ?? '');
    const search = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const url = subpath + search;

    const headers: Record<string, string> = {
      'X-Principal-Sub':   req.principal?.sub ?? '',
      'X-Principal-Scope': (req.principal?.scope ?? []).join(','),
      'traceparent':       req.locals.traceparent,
    };

    const idemKey = req.header('Idempotency-Key');
    const isMutator = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';

    const doCall = async () => {
      const result = await upstreamCall<any>(service, url, {
        method:  req.method,
        body:    isMutator ? JSON.stringify(req.body ?? {}) : undefined,
        headers,
        retries: 0,
        traceparent: req.locals.traceparent,
      }).catch((e: any) => ({ __error: e, __status: e?.__http ?? 502, __body: e?.body ?? { error: e?.message } }));
      if ((result as any).__error) return { status: (result as any).__status, body: (result as any).__body };
      return { status: 200, body: result };
    };

    let outcome: { status: number; body: any };
    if (isMutator && idemKey) {
      try {
        outcome = await withIdempotency(db, idemKey, { method: req.method, url, body: req.body }, doCall);
      } catch (e: any) {
        if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
        throw e;
      }
    } else {
      outcome = await doCall();
    }

    reqCounter.inc({ outcome: outcome.status >= 500 ? 'upstream_error' : 'ok' });
    res.status(outcome.status).json(outcome.body);
  } catch (e) { next(e); }
}

const proxyHandler = [requireAuth, rateLimitMiddleware, proxy];
app.get   ('/:service/*', ...proxyHandler);
app.post  ('/:service/*', ...proxyHandler);
app.put   ('/:service/*', ...proxyHandler);
app.delete('/:service/*', ...proxyHandler);

/* ── Stats ───────────────────────────────────────────────────────── */

app.get('/stats', (_req: Request, res: Response) => {
  const upstreams = ALLOWED.map((s) => ({ service: s, url: baseUrl(s) }));
  res.json({
    rate_rps: RATE_RPS,
    rate_burst: RATE_BURST,
    active_principals: buckets.size,
    upstreams,
  });
});

/* ── Boot ─────────────────────────────────────────────────────────── */

start(app, port, 'gateway', () => {
  log.info(`JWT alg=EdDSA · rate_rps=${RATE_RPS} (burst ${RATE_BURST}) · upstreams=[${ALLOWED.join(', ')}]`);
});
