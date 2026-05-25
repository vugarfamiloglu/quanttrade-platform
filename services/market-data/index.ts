/**
 * Market Data Service (port 5125).
 *
 * Listens to order.filled events from the broker, aggregates them
 * into per-instrument ticks (last/bid/ask/volume) and 1-minute
 * candles (open/high/low/close).  Exposes an SSE stream for the
 * UI to subscribe to so the terminal feels live without polling.
 *
 * In production this would be a separate Apache Druid / ClickHouse
 * pipeline; the contract — "events in, OHLCV out" — is identical.
 */

import { bootService, start } from '../../lib/service-base';
import { openDb } from '../../lib/db';
/* broker is intentionally not imported here — see comment below about
 * why the poll loop is the right call instead of a subscription. */
import type { Request, Response } from 'express';

const { app, log, port } = bootService({
  name: 'market-data',
  port: Number(process.env.QT_MARKET_DATA_PORT ?? 5125),
});

const db = openDb('market-data');

db.exec(`
  CREATE TABLE IF NOT EXISTS ticks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    instrument TEXT NOT NULL,
    price_raw  TEXT NOT NULL,
    qty_raw    TEXT NOT NULL,
    ts         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ticks_instr_ts ON ticks(instrument, ts);

  CREATE TABLE IF NOT EXISTS candles_1m (
    instrument TEXT NOT NULL,
    bucket_ts  TEXT NOT NULL,
    open_raw   TEXT NOT NULL,
    high_raw   TEXT NOT NULL,
    low_raw    TEXT NOT NULL,
    close_raw  TEXT NOT NULL,
    vol_raw    TEXT NOT NULL DEFAULT '0',
    PRIMARY KEY (instrument, bucket_ts)
  );
`);

interface LastState {
  last_raw: string; vol_24h_raw: string;
  high_raw: string; low_raw: string; updated_at: string;
}
const lastByInstrument = new Map<string, LastState>();

/* SSE subscribers — push every tick straight to the UI. */
const sseClients = new Set<Response>();
function broadcast(payload: any): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) {
    try { c.write(line); } catch { /* dropped */ }
  }
}

/* We don't subscribe to the broker directly: matching's `orders`
 * table lives in its own SQLite file (no cross-process query), and
 * resolving instrument from the event payload would mean an HTTP
 * round-trip per fill.  The poll loop below covers the same job with
 * a single round-trip per instrument every 5 seconds — fast enough
 * for human eyes and bounded blast radius. */

/* Simpler version: poll the matching service every 2s for new trades
 * and tick the cache.  More resilient since we don't depend on broker
 * schema agreement. */
async function poll(): Promise<void> {
  try {
    const list = await fetch(`http://localhost:${Number(process.env.QT_MATCHING_PORT ?? 5123)}/instruments`).then((r) => r.json()) as { instruments: any[] };
    for (const inst of list.instruments) {
      const tr = await fetch(`http://localhost:${Number(process.env.QT_MATCHING_PORT ?? 5123)}/trades/${inst.symbol}?limit=10`).then((r) => r.json()) as { trades: any[] };
      if (!tr.trades?.length) continue;
      const latest = tr.trades[0];
      const cur = lastByInstrument.get(inst.symbol);
      if (cur && cur.last_raw === latest.price_raw && cur.updated_at === latest.ts) continue;
      const next: LastState = {
        last_raw: latest.price_raw,
        vol_24h_raw: tr.trades.reduce((s, t) => s + Number(t.qty_raw), 0).toString(),
        high_raw: tr.trades.reduce((m, t) => Number(t.price_raw) > Number(m) ? t.price_raw : m, latest.price_raw),
        low_raw:  tr.trades.reduce((m, t) => Number(t.price_raw) < Number(m) ? t.price_raw : m, latest.price_raw),
        updated_at: latest.ts,
      };
      lastByInstrument.set(inst.symbol, next);
      broadcast({ kind: 'tick', symbol: inst.symbol, ...next });
      /* Update candle bucket. */
      const bucket = bucketize(latest.ts);
      const existing = db.prepare<[string, string], { open_raw: string; high_raw: string; low_raw: string; close_raw: string; vol_raw: string }>(
        `SELECT * FROM candles_1m WHERE instrument = ? AND bucket_ts = ?`,
      ).get(inst.symbol, bucket);
      if (!existing) {
        db.prepare(`INSERT INTO candles_1m (instrument, bucket_ts, open_raw, high_raw, low_raw, close_raw, vol_raw) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(inst.symbol, bucket, latest.price_raw, latest.price_raw, latest.price_raw, latest.price_raw, latest.qty_raw);
      } else {
        const high = Number(latest.price_raw) > Number(existing.high_raw) ? latest.price_raw : existing.high_raw;
        const low  = Number(latest.price_raw) < Number(existing.low_raw)  ? latest.price_raw : existing.low_raw;
        db.prepare(`UPDATE candles_1m SET high_raw = ?, low_raw = ?, close_raw = ?, vol_raw = ? WHERE instrument = ? AND bucket_ts = ?`)
          .run(high, low, latest.price_raw, (Number(existing.vol_raw) + Number(latest.qty_raw)).toString(), inst.symbol, bucket);
      }
    }
  } catch { /* matching may be down; skip this tick */ }
}

function bucketize(ts: string): string {
  /* Round down to the minute. */
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/* ── Routes ──────────────────────────────────────────────────────── */

app.get('/quotes', (_req: Request, res: Response) => {
  const out = [...lastByInstrument.entries()].map(([sym, s]) => ({ symbol: sym, ...s }));
  res.json({ quotes: out });
});

app.get('/quotes/:symbol', (req: Request, res: Response) => {
  res.json({ symbol: req.params.symbol, ...lastByInstrument.get(req.params.symbol) });
});

app.get('/candles/:symbol', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 120), 1440);
  const rows = db.prepare(`SELECT * FROM candles_1m WHERE instrument = ? ORDER BY bucket_ts DESC LIMIT ?`).all(req.params.symbol, limit);
  res.json({ symbol: req.params.symbol, candles: rows.reverse() });
});

app.get('/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  sseClients.add(res);
  /* Send current snapshot on connect. */
  for (const [sym, s] of lastByInstrument.entries()) {
    res.write(`data: ${JSON.stringify({ kind: 'tick', symbol: sym, ...s })}\n\n`);
  }
  req.on('close', () => sseClients.delete(res));
});

app.get('/stats', (_req: Request, res: Response) => {
  const ticks   = (db.prepare(`SELECT COUNT(*) as c FROM ticks`).get() as { c: number }).c;
  const candles = (db.prepare(`SELECT COUNT(*) as c FROM candles_1m`).get() as { c: number }).c;
  res.json({ ticks, candles, active_quotes: lastByInstrument.size, sse_subscribers: sseClients.size });
});

start(app, port, 'market-data', () => {
  /* 5-second cadence is plenty for an operator UI; tighter would
   * just hammer the matching service without giving humans more info. */
  setInterval(poll, 5000);
  log.info('aggregator armed — 5s poll → broadcast to /stream subscribers');
});
