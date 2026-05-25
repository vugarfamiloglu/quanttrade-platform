/**
 * Clearing Service / Saga Orchestrator (port 5124).
 *
 * Hosts the place_order saga.  Four steps with compensations:
 *
 *   ┌─────────────────┬──────────────────────┐
 *   │ Step            │ Compensation         │
 *   ├─────────────────┼──────────────────────┤
 *   │ 1. reserve_funds│ release_funds         │
 *   │ 2. submit_order │ cancel_order          │
 *   │ 3. process_fills│ reverse_settlements   │
 *   │ 4. settle       │ unrecord_settlement   │
 *   └─────────────────┴──────────────────────┘
 *
 * If step N throws, compensations for steps 1..N-1 run in reverse
 * order.  On crash mid-saga the recovery loop scans for sagas in
 * `running` / `compensating` and resumes them — exactly the contract
 * a Temporal.io workflow would give us.
 *
 * A POST /sagas/place-order is the public entry; the orchestrator
 * persists state on every transition so a kill -9 between any two
 * steps leaves the saga in a recoverable position.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, uuid } from '../../lib/db';
import { withIdempotency, IdempotencyConflictError } from '../../lib/idempotency';
import { defineSaga, getSaga, getSagaSteps, recoverInFlight, ensureSchema as ensureSagaSchema } from '../../lib/saga';
import { publish, subscribe, recentEvents, deadLetters, brokerStats } from '../../lib/broker';
import { call } from '../../lib/http';
import { Decimal, scaleOf } from '../../lib/decimal';
import { counter } from '../../lib/metrics';
import type { Side } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'clearing',
  port: Number(process.env.QT_CLEARING_PORT ?? 5124),
});

const db = openDb('clearing');
ensureSagaSchema(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_settlements (
    id            TEXT PRIMARY KEY,
    trade_id      TEXT NOT NULL,
    order_id      TEXT NOT NULL,
    instrument    TEXT NOT NULL,
    side          TEXT NOT NULL,
    price_raw     TEXT NOT NULL,
    qty_raw       TEXT NOT NULL,
    fee_raw       TEXT NOT NULL,
    buy_account_id  TEXT NOT NULL,
    sell_account_id TEXT NOT NULL,
    /* saga_id is patched in after the saga completes; the live tree
     * during execution doesn't have it yet (the orchestrator returns
     * the id only AFTER run() resolves), so this stays nullable. */
    saga_id       TEXT,
    reversed      INTEGER NOT NULL DEFAULT 0,
    ts            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_settl_saga ON trade_settlements(saga_id);
`);

const sagaCounter = counter('qt_clearing_sagas_total', 'Place-order sagas by outcome');

/* ── place_order saga definition ─────────────────────────────────── */

interface PlaceOrderInput {
  account_id: string;
  instrument: string;          // 'AAPL'
  side:       Side;
  type:       'LIMIT' | 'MARKET';
  price?:     string;          // human
  qty:        string;          // human
  tif?:       'GTC' | 'IOC' | 'FOK';
  fee_bp?:    number;          // basis points (1/100 of a percent), default 5
  client_order_id?: string;
  /** Demo hook — inject failure at a specific step to exercise compensation. */
  inject_failure_step?: string;
}

interface PlaceOrderCtx {
  input: PlaceOrderInput;
  saga_id: string | null;
  base: string;   quote: string;
  qty: string;    estimatedCost: string;      // in quote
  holdAccount: string;                         // either base (SELL) or quote (BUY)
  holdAsset: string;
  /* Filled in by steps */
  orderId: string | null;
  publicOrderId: string | null;
  fills: Array<{
    trade_id: string; price_raw: string; qty_raw: string;
    maker_order_id: string; buy_account_id: string; sell_account_id: string;
  }>;
  settlementsRecorded: string[];        // ids of trade_settlements rows
  appliedHolds: Array<{ asset: string; amount_raw: string }>;
  appliedDebits: Array<{ account_id: string; asset: string; amount_raw: string; fill_id: string }>;
  appliedCredits: Array<{ account_id: string; asset: string; amount_raw: string; fill_id: string }>;
  feeRaw: string;
}

async function fetchInstrument(symbol: string): Promise<{ symbol: string; base: string; quote: string }> {
  const r = await call<{ instruments: any[] }>('matching', `/instruments`, { method: 'GET', retries: 1 });
  const i = r.instruments.find((x) => x.symbol === symbol);
  if (!i) throw new Error(`unknown instrument: ${symbol}`);
  return i;
}

const placeOrderSaga = defineSaga<PlaceOrderInput, PlaceOrderCtx>(
  'place_order',
  (input): PlaceOrderCtx => ({
    input, saga_id: null,
    base: '', quote: '', qty: input.qty,
    estimatedCost: '0', holdAccount: input.account_id, holdAsset: 'USD',
    orderId: null, publicOrderId: null,
    fills: [], settlementsRecorded: [],
    appliedHolds: [], appliedDebits: [], appliedCredits: [],
    feeRaw: '0',
  }),
  [
    /* ── Step 1: reserve funds (or shares) ───────────────────────── */
    {
      name: 'reserve_funds',
      forward: async (ctx) => {
        if (ctx.input.inject_failure_step === 'reserve_funds') throw new Error('injected failure (reserve_funds)');
        const inst = await fetchInstrument(ctx.input.instrument);
        ctx.base = inst.base; ctx.quote = inst.quote;
        const priceScale = scaleOf(inst.quote);
        const qtyScale   = scaleOf(inst.base);
        const qty = Decimal.parse(ctx.input.qty, qtyScale);
        /* MARKET: we still need an estimate to hold against; we use a
         * generous fixed cap (twice the best ask) so the user can't
         * accidentally over-hold.  Real systems quote the depth here. */
        let estimatedQuote = Decimal.zero(priceScale);
        if (ctx.input.type === 'LIMIT') {
          const price = Decimal.parse(ctx.input.price!, priceScale);
          /* qty (base scale) × price (quote scale) → quote scale */
          estimatedQuote = qty.mul(price, priceScale);
        } else {
          /* MARKET: ask the matching book what the spread looks like. */
          const bk = await call<{ asks: any[]; bids: any[] }>('matching', `/book/${inst.symbol}?depth=1`, { method: 'GET', retries: 0 }).catch(() => ({ asks: [], bids: [] }));
          if (ctx.input.side === 'BUY') {
            const ref = bk.asks[0] ? BigInt(bk.asks[0].price_raw) : 0n;
            if (ref === 0n) throw new Error('no liquidity for MARKET BUY');
            estimatedQuote = new Decimal((BigInt(qty.toDb().v) * ref * 2n) / (10n ** BigInt(qtyScale)), priceScale);
          } else {
            estimatedQuote = Decimal.zero(priceScale);
          }
        }
        /* Add fee allowance to the hold so the debit at settle time
         * never under-holds. */
        const feeBp = BigInt(ctx.input.fee_bp ?? 5);
        const feeAllowance = new Decimal((BigInt(estimatedQuote.toDb().v) * feeBp) / 10_000n, priceScale);
        const totalHold = ctx.input.side === 'BUY'
          ? estimatedQuote.add(feeAllowance)
          : qty;                                         // SELL holds shares of base
        ctx.holdAsset = ctx.input.side === 'BUY' ? ctx.quote : ctx.base;
        ctx.estimatedCost = totalHold.toDb().v;
        ctx.appliedHolds.push({ asset: ctx.holdAsset, amount_raw: ctx.estimatedCost });

        await call('wallet', '/hold', {
          method: 'POST',
          body: JSON.stringify({
            account_id: ctx.input.account_id, asset: ctx.holdAsset,
            amount: totalHold.toString(), order_id: null,
          }),
          retries: 1,
        });
        return { hold_amount: totalHold.toString(), asset: ctx.holdAsset };
      },
      compensate: async function release_funds(ctx) {
        for (const h of ctx.appliedHolds) {
          await call('wallet', '/release', { method: 'POST', body: JSON.stringify({
            account_id: ctx.input.account_id, asset: h.asset, amount: bigIntToHuman(h.amount_raw, h.asset),
          }), retries: 1 }).catch((e) => log.warn(`release_funds compensation partial: ${e?.message}`));
        }
      },
    },

    /* ── Step 2: submit to matching engine ──────────────────────── */
    {
      name: 'submit_order',
      forward: async (ctx) => {
        if (ctx.input.inject_failure_step === 'submit_order') throw new Error('injected failure (submit_order)');
        const r = await call<{ order: any; fills: any[] }>('matching', '/orders', {
          method: 'POST',
          body: JSON.stringify({
            account_id: ctx.input.account_id, instrument: ctx.input.instrument,
            side: ctx.input.side, type: ctx.input.type, tif: ctx.input.tif ?? 'GTC',
            price: ctx.input.price, qty: ctx.input.qty,
            client_order_id: ctx.input.client_order_id ?? null,
            saga_id: ctx.saga_id,
          }),
          retries: 0,
        });
        ctx.orderId = r.order.id; ctx.publicOrderId = r.order.public_id;
        /* The matching engine's POST /orders response includes fills
         * but not the buy/sell account ids — re-fetch via /orders/:id
         * which carries the full fill row.  One round-trip; cheap. */
        if (r.fills.length > 0) {
          const detail = await call<{ fills: any[] }>('matching', `/orders/${r.order.id}`, { method: 'GET' });
          ctx.fills = detail.fills.map((x: any) => ({
            trade_id: x.trade_id, price_raw: x.price_raw, qty_raw: x.qty_raw,
            maker_order_id: x.maker_order_id,
            buy_account_id: x.buy_account_id, sell_account_id: x.sell_account_id,
          }));
        }
        return { order_id: r.order.id, public_id: r.order.public_id, fills_count: r.fills.length };
      },
      compensate: async function cancel_order(ctx) {
        if (!ctx.orderId) return;
        await call('matching', `/orders/${ctx.orderId}/cancel`, {
          method: 'POST', body: JSON.stringify({ reason: 'saga_rollback' }), retries: 1,
        }).catch((e) => log.warn(`cancel_order compensation partial: ${e?.message}`));
      },
    },

    /* ── Step 3: apply fills to wallets ─────────────────────────── */
    {
      name: 'process_fills',
      forward: async (ctx) => {
        if (ctx.input.inject_failure_step === 'process_fills') throw new Error('injected failure (process_fills)');
        const priceScale = scaleOf(ctx.quote);
        const qtyScale   = scaleOf(ctx.base);
        let totalFee = Decimal.zero(priceScale);

        for (const f of ctx.fills) {
          const price = Decimal.fromDb(f.price_raw, priceScale);
          const qty   = Decimal.fromDb(f.qty_raw,   qtyScale);
          const notional = qty.mul(price, priceScale);
          const feeBp = BigInt(ctx.input.fee_bp ?? 5);
          const fee = new Decimal((BigInt(notional.toDb().v) * feeBp) / 10_000n, priceScale);
          totalFee = totalFee.add(fee);

          /* Buyer: pays notional+fee in quote, receives qty in base. */
          await call('wallet', '/debit', { method: 'POST', body: JSON.stringify({
            account_id: f.buy_account_id, asset: ctx.quote, amount: notional.add(fee).toString(), fill_id: f.trade_id,
          }), retries: 1 });
          ctx.appliedDebits.push({ account_id: f.buy_account_id, asset: ctx.quote, amount_raw: notional.add(fee).toDb().v, fill_id: f.trade_id });

          await call('wallet', '/credit', { method: 'POST', body: JSON.stringify({
            account_id: f.buy_account_id, asset: ctx.base, amount: qty.toString(), fill_id: f.trade_id,
          }), retries: 1 });
          ctx.appliedCredits.push({ account_id: f.buy_account_id, asset: ctx.base, amount_raw: qty.toDb().v, fill_id: f.trade_id });

          /* Seller: receives notional in quote, loses qty in base (held). */
          await call('wallet', '/debit', { method: 'POST', body: JSON.stringify({
            account_id: f.sell_account_id, asset: ctx.base, amount: qty.toString(), fill_id: f.trade_id,
          }), retries: 1 });
          ctx.appliedDebits.push({ account_id: f.sell_account_id, asset: ctx.base, amount_raw: qty.toDb().v, fill_id: f.trade_id });

          await call('wallet', '/credit', { method: 'POST', body: JSON.stringify({
            account_id: f.sell_account_id, asset: ctx.quote, amount: notional.sub(fee).toString(), fill_id: f.trade_id,
          }), retries: 1 });
          ctx.appliedCredits.push({ account_id: f.sell_account_id, asset: ctx.quote, amount_raw: notional.sub(fee).toDb().v, fill_id: f.trade_id });
        }
        ctx.feeRaw = totalFee.toDb().v;
        return { fee_total_raw: ctx.feeRaw, fills_processed: ctx.fills.length };
      },
      compensate: async function reverse_settlements(ctx) {
        /* Best-effort reverse — issue compensating wallet events for
         * every applied debit/credit.  In production these would be
         * idempotency-keyed corrections in the wallet event log. */
        for (const c of ctx.appliedCredits) {
          await call('wallet', '/debit', { method: 'POST', body: JSON.stringify({
            account_id: c.account_id, asset: c.asset, amount: bigIntToHuman(c.amount_raw, c.asset), fill_id: c.fill_id + ':rollback',
          }), retries: 1 }).catch(() => {});
        }
        for (const d of ctx.appliedDebits) {
          await call('wallet', '/credit', { method: 'POST', body: JSON.stringify({
            account_id: d.account_id, asset: d.asset, amount: bigIntToHuman(d.amount_raw, d.asset), fill_id: d.fill_id + ':rollback',
          }), retries: 1 }).catch(() => {});
        }
      },
    },

    /* ── Step 4: settle (record trade + release residual hold) ──── */
    {
      name: 'settle',
      forward: async (ctx) => {
        if (ctx.input.inject_failure_step === 'settle') throw new Error('injected failure (settle)');
        for (const f of ctx.fills) {
          const id = uuid();
          db.prepare(
            `INSERT INTO trade_settlements (id, trade_id, order_id, instrument, side, price_raw, qty_raw, fee_raw, buy_account_id, sell_account_id, saga_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(id, f.trade_id, ctx.orderId, ctx.input.instrument, ctx.input.side, f.price_raw, f.qty_raw, '0', f.buy_account_id, f.sell_account_id, ctx.saga_id);
          ctx.settlementsRecorded.push(id);
          publish('trade.settled', { settlement_id: id, trade_id: f.trade_id, order_id: ctx.orderId, instrument: ctx.input.instrument, price_raw: f.price_raw, qty_raw: f.qty_raw }, 'clearing');
        }
        /* Release residual hold (what we held vs what we used). */
        const priceScale = scaleOf(ctx.quote);
        const qtyScale   = scaleOf(ctx.base);
        if (ctx.input.side === 'BUY') {
          const used = ctx.fills.reduce((acc, f) => {
            const price = Decimal.fromDb(f.price_raw, priceScale);
            const qty   = Decimal.fromDb(f.qty_raw,   qtyScale);
            const fee = new Decimal((BigInt(qty.mul(price, priceScale).toDb().v) * BigInt(ctx.input.fee_bp ?? 5)) / 10_000n, priceScale);
            return acc.add(qty.mul(price, priceScale)).add(fee);
          }, Decimal.zero(priceScale));
          const held = Decimal.fromDb(ctx.estimatedCost, priceScale);
          const residual = held.sub(used);
          if (residual.isPos()) {
            await call('wallet', '/release', { method: 'POST', body: JSON.stringify({
              account_id: ctx.input.account_id, asset: ctx.quote, amount: residual.toString(),
            }), retries: 1 });
          }
        } else {
          /* SELL: residual base shares (if order was partially filled). */
          const used = ctx.fills.reduce((acc, f) => acc.add(Decimal.fromDb(f.qty_raw, qtyScale)), Decimal.zero(qtyScale));
          const held = Decimal.fromDb(ctx.estimatedCost, qtyScale);
          const residual = held.sub(used);
          if (residual.isPos()) {
            await call('wallet', '/release', { method: 'POST', body: JSON.stringify({
              account_id: ctx.input.account_id, asset: ctx.base, amount: residual.toString(),
            }), retries: 1 });
          }
        }
        return { settlements: ctx.settlementsRecorded.length };
      },
      compensate: async function unrecord_settlements(ctx) {
        for (const id of ctx.settlementsRecorded) {
          db.prepare(`UPDATE trade_settlements SET reversed = 1 WHERE id = ?`).run(id);
        }
      },
    },
  ],
);

function bigIntToHuman(raw: string, asset: string): string {
  return Decimal.fromDb(raw, scaleOf(asset)).toString();
}

/* ── Routes ──────────────────────────────────────────────────────── */

app.post('/sagas/place-order', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = req.header('Idempotency-Key') ?? `saga:${uuid()}`;
    const result = await withIdempotency(db, idemKey, req.body, async () => {
      const input = req.body as PlaceOrderInput;
      if (!input.account_id) bad(422, 'account_id required');
      if (!input.instrument) bad(422, 'instrument required');
      if (!input.qty)        bad(422, 'qty required');

      publish('saga.started', { kind: 'place_order', account_id: input.account_id, instrument: input.instrument, side: input.side, qty: input.qty }, 'clearing', req.locals.traceparent);
      const inst = await placeOrderSaga.run(db, input);
      /* Patch saga_id into context after creation. */
      const fullCtx = JSON.parse(inst.context_json);
      fullCtx.saga_id = inst.id;
      db.prepare(`UPDATE sagas SET context_json = ? WHERE id = ?`).run(JSON.stringify(fullCtx), inst.id);

      if (inst.status === 'completed') {
        sagaCounter.inc({ outcome: 'completed' });
        publish('saga.completed', { saga_id: inst.id, public_id: inst.public_id }, 'clearing', req.locals.traceparent);
      } else if (inst.status === 'compensated') {
        sagaCounter.inc({ outcome: 'compensated' });
        publish('saga.compensated', { saga_id: inst.id, public_id: inst.public_id, reason: inst.failed_reason }, 'clearing', req.locals.traceparent);
      } else {
        sagaCounter.inc({ outcome: 'failed' });
        publish('saga.failed', { saga_id: inst.id, public_id: inst.public_id, reason: inst.failed_reason }, 'clearing', req.locals.traceparent);
      }
      log.info(`saga ${inst.public_id} ${inst.status} (${inst.kind})`);
      return { status: inst.status === 'completed' ? 201 : 422, body: {
        saga: inst, steps: getSagaSteps(db, inst.id),
      } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

app.get('/sagas', (req: Request, res: Response) => {
  const where: string[] = [];
  const params: any[] = [];
  const q = req.query as Record<string, string | undefined>;
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.kind)   { where.push('kind = ?');   params.push(q.kind); }
  const limit = Math.min(Number(q.limit ?? 100), 500);
  const sql = `SELECT * FROM sagas ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  res.json({ sagas: rows, total: rows.length });
});

app.get('/sagas/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const inst = db.prepare(`SELECT * FROM sagas WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!inst) bad(404, 'saga not found');
    const steps = getSagaSteps(db, (inst as any).id);
    res.json({ saga: inst, steps });
  } catch (e) { next(e); }
});

app.get('/settlements', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const rows = db.prepare(`SELECT * FROM trade_settlements ORDER BY ts DESC LIMIT ?`).all(limit);
  res.json({ settlements: rows, total: rows.length });
});

app.get('/stats', (_req: Request, res: Response) => {
  const sagas       = (db.prepare(`SELECT COUNT(*) as c FROM sagas`).get() as { c: number }).c;
  const settlements = (db.prepare(`SELECT COUNT(*) as c FROM trade_settlements WHERE reversed = 0`).get() as { c: number }).c;
  const reversed    = (db.prepare(`SELECT COUNT(*) as c FROM trade_settlements WHERE reversed = 1`).get() as { c: number }).c;
  const byStatus    = db.prepare(`SELECT status, COUNT(*) as c FROM sagas GROUP BY status`).all();
  res.json({ sagas, settlements, reversed_settlements: reversed, sagas_by_status: byStatus });
});

/* ── Broker introspection (the clearing service happens to host this
 * because every saga touches the broker — it's an arbitrary but
 * convenient location for the read endpoint). */

app.get('/events', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json({ events: recentEvents(limit) });
});

app.get('/dlq', (_req: Request, res: Response) => {
  res.json({ dead_letters: deadLetters(100) });
});

app.get('/broker-stats', (_req: Request, res: Response) => {
  res.json(brokerStats());
});

/* ── Boot recovery: resume in-flight sagas ───────────────────────── */

start(app, port, 'clearing', () => {
  const inFlight = recoverInFlight(db);
  if (inFlight.length > 0) log.warn(`recovery: ${inFlight.length} in-flight saga(s) at boot — operator should inspect /sagas?status=running|compensating`);

  /* Subscribe to DLQ alerts so operators see them in the audit page. */
  subscribe('order.filled', 'clearing-monitor', () => { /* placeholder for downstream metrics */ });
});
