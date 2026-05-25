/** Express bootstrap shared by every service. */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { loadEnvLocal } from './db';
import { ensureTraceContext, formatTraceparent, childSpan } from './trace';
import { counter, histogram, exposeMetrics, metricsSnapshot } from './metrics';
import { allBreakers } from './circuit-breaker';

loadEnvLocal();

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m', '\x1b[31m', '\x1b[95m'];
const RESET = '\x1b[0m';
let colorCursor = 0;

export interface BootOptions { name: string; port: number; }
export interface Logger {
  info: (msg: string, ...extra: any[]) => void;
  warn: (msg: string, ...extra: any[]) => void;
  error: (msg: string, ...extra: any[]) => void;
}

export interface ReqLocals { traceparent: string; traceId: string; spanId: string; }

declare global {
  namespace Express {
    interface Request { locals: ReqLocals; }
  }
}

export function bootService(opts: BootOptions): { app: Express; log: Logger; port: number } {
  const color = COLORS[colorCursor++ % COLORS.length];
  const log: Logger = {
    info:  (m, ...x) => console.log(`${color}[${opts.name}]${RESET} ${m}`, ...x),
    warn:  (m, ...x) => console.warn(`${color}[${opts.name}]${RESET} ⚠ ${m}`, ...x),
    error: (m, ...x) => console.error(`${color}[${opts.name}]${RESET} ✗ ${m}`, ...x),
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  /* W3C traceparent middleware — always rewrites the header so the
   * downstream gets a fresh span-id under the same trace-id.  The
   * inbound is used as parent if present; otherwise a fresh trace
   * is created at this hop.                                            */
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const parent = ensureTraceContext(req.header('traceparent'));
    const span = childSpan(parent);
    req.locals = {
      traceparent: formatTraceparent(span),
      traceId: span.traceId,
      spanId:  span.spanId,
    };
    next();
  });

  const reqCounter   = counter  ('qt_requests_total',        'Total HTTP requests');
  const reqHistogram = histogram('qt_request_duration_sec',  'HTTP request latency in seconds');

  app.get('/health', (_req, res) => res.json({ service: opts.name, ok: true, uptime_sec: Math.round(process.uptime()) }));
  app.get('/metrics', (_req, res) => { res.type('text/plain'); res.send(exposeMetrics()); });
  app.get('/metrics.json', (_req, res) => res.json({
    ...metricsSnapshot(),
    breakers: allBreakers().map((b) => b.snapshot()),
  }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const ok = res.statusCode < 500;
      reqCounter.inc({ service: opts.name, code: String(res.statusCode), method: req.method });
      reqHistogram.observe(ms / 1000, { service: opts.name, route: req.path });
      if (req.path !== '/health' && req.path !== '/metrics' && req.path !== '/metrics.json') {
        const tracePart = req.locals?.traceId ? ` trace=${req.locals.traceId.slice(0, 8)}…` : '';
        log[ok ? 'info' : 'warn'](`${req.method} ${req.path} → ${res.statusCode} ${ms}ms${tracePart}`);
      }
    });
    next();
  });

  process.on('uncaughtException',  (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
  return { app, log, port: opts.port };
}

export function start(app: Express, port: number, name: string, onReady?: () => void): void {
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err?.__http ?? 500;
    if (status >= 500) console.error(`[${name}] unhandled`, err);
    res.status(status).json({ error: err?.message ?? 'Internal error', trace_id: req.locals?.traceId });
  });
  app.listen(port, () => {
    console.log(`\x1b[32m✓ ${name} listening on http://localhost:${port}\x1b[0m`);
    onReady?.();
  });
}

export function bad(status: number, message: string): never {
  throw Object.assign(new Error(message), { __http: status });
}
