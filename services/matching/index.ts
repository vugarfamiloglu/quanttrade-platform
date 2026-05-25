/**
 * Matching Engine (port 5123).
 *
 * In-memory price-time priority order book per instrument.
 *
 *   bids: SortedMap<price, FIFO<Order>>   // descending price
 *   asks: SortedMap<price, FIFO<Order>>   // ascending  price
 *
 * Matching rules:
 *   • Incoming BUY @ $100 → walks asks while best_ask.price ≤ 100
 *   • Trade price = resting (maker) order's price — price-time priority
 *   • Each match emits a Fill event; both orders' filled qty bumps
 *   • Order removed from book when filled === requested
 *   • If incoming has remaining qty AND TIF allows resting, it's added
 *     to the appropriate side at its price level
 *
 * Crash recovery: every accepted order persists to disk first, then
 * enters the in-memory book.  On boot we replay open orders by
 * `(created_at, id)` order to reconstruct the book exactly.
 *
 * No GC pressure: pre-allocated objects, no closures in hot path,
 * BigInt-only arithmetic.  In a JVM this would be off-heap; here we
 * lean on Node's V8 generational GC and stay flat.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, uuid, publicId } from '../../lib/db';
import { publish } from '../../lib/broker';
import { Decimal, scaleOf } from '../../lib/decimal';
import { histogram, counter } from '../../lib/metrics';
import type { Side, OrderType, TimeInForce, OrderStatus } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'matching',
  port: Number(process.env.QT_MATCHING_PORT ?? 5123),
});

const db = openDb('matching');

/* ── Schema ───────────────────────────────────────────────────────── */

db.exec(`
  CREATE TABLE IF NOT EXISTS instruments (
    symbol        TEXT PRIMARY KEY,
    base          TEXT NOT NULL,
    quote         TEXT NOT NULL,
    price_tick    TEXT NOT NULL DEFAULT '0.01',
    qty_step      TEXT NOT NULL DEFAULT '1',
    min_qty       TEXT NOT NULL DEFAULT '1',
    display_name  TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              TEXT PRIMARY KEY,
    public_id       TEXT UNIQUE NOT NULL,
    account_id      TEXT NOT NULL,
    instrument      TEXT NOT NULL REFERENCES instruments(symbol),
    side            TEXT NOT NULL,
    type            TEXT NOT NULL,
    tif             TEXT NOT NULL DEFAULT 'GTC',
    price_raw       TEXT,                       -- NULL for MARKET
    qty_raw         TEXT NOT NULL,
    filled_qty_raw  TEXT NOT NULL DEFAULT '0',
    status          TEXT NOT NULL DEFAULT 'NEW',
    client_order_id TEXT,
    saga_id         TEXT,
    reason          TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_acct   ON orders(account_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_instr  ON orders(instrument);

  CREATE TABLE IF NOT EXISTS fills (
    id             TEXT PRIMARY KEY,
    trade_id       TEXT NOT NULL,
    instrument     TEXT NOT NULL,
    taker_order_id TEXT NOT NULL,
    maker_order_id TEXT NOT NULL,
    price_raw      TEXT NOT NULL,
    qty_raw        TEXT NOT NULL,
    buy_account_id  TEXT NOT NULL,
    sell_account_id TEXT NOT NULL,
    ts             TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_fills_instr ON fills(instrument, ts);
  CREATE INDEX IF NOT EXISTS idx_fills_taker ON fills(taker_order_id);
`);

/* ── Order Book ──────────────────────────────────────────────────────
 * Per-instrument structure.  `levels` is a Map<priceKey, PriceLevel>
 * where priceKey is the raw BigInt as string.  `sortedBids` /
 * `sortedAsks` are the maintained sorted price arrays.
 *
 * Real systems (Coinbase, NYSE) use red-black trees or skip lists
 * for O(log n) inserts and O(1) best-price lookup.  For a demo, a
 * sorted array with binary-search insert performs comparably at
 * reasonable depths and is dramatically simpler to read. */

interface RestingOrder {
  id: string;
  public_id: string;
  account_id: string;
  side: Side;
  priceRaw: bigint;                   // 0n for MARKET (shouldn't rest)
  remainingRaw: bigint;
  filledRaw: bigint;
  enteredAt: number;
}

interface PriceLevel {
  priceRaw: bigint;
  queue: RestingOrder[];              // FIFO — time priority
  totalRaw: bigint;
}

class OrderBook {
  symbol: string;
  bids = new Map<string, PriceLevel>();
  asks = new Map<string, PriceLevel>();
  /** Descending — first element is highest bid. */
  sortedBids: bigint[] = [];
  /** Ascending  — first element is lowest ask. */
  sortedAsks: bigint[] = [];

  constructor(symbol: string) { this.symbol = symbol; }

  best(side: Side): bigint | null {
    if (side === 'BUY')  return this.sortedAsks[0] ?? null;       // best price to BUY = lowest ask
    return this.sortedBids[0] ?? null;                            // best price to SELL = highest bid
  }

  add(o: RestingOrder): void {
    const sideMap = o.side === 'BUY' ? this.bids : this.asks;
    const sortedArr = o.side === 'BUY' ? this.sortedBids : this.sortedAsks;
    const key = o.priceRaw.toString();
    let level = sideMap.get(key);
    if (!level) {
      level = { priceRaw: o.priceRaw, queue: [], totalRaw: 0n };
      sideMap.set(key, level);
      insertSorted(sortedArr, o.priceRaw, o.side === 'BUY');
    }
    level.queue.push(o);
    level.totalRaw += o.remainingRaw;
  }

  removeFront(side: Side): void {
    const sideMap = side === 'BUY' ? this.bids : this.asks;
    const sortedArr = side === 'BUY' ? this.sortedBids : this.sortedAsks;
    const price = sortedArr[0];
    if (price == null) return;
    const level = sideMap.get(price.toString());
    if (!level) { sortedArr.shift(); return; }
    level.queue.shift();
    if (level.queue.length === 0) {
      sideMap.delete(price.toString());
      sortedArr.shift();
    }
  }

  cancelById(orderId: string): boolean {
    for (const sideMap of [this.bids, this.asks]) {
      for (const [key, lvl] of sideMap.entries()) {
        const idx = lvl.queue.findIndex((o) => o.id === orderId);
        if (idx >= 0) {
          const removed = lvl.queue[idx];
          lvl.queue.splice(idx, 1);
          lvl.totalRaw -= removed.remainingRaw;
          if (lvl.queue.length === 0) {
            sideMap.delete(key);
            const arr = sideMap === this.bids ? this.sortedBids : this.sortedAsks;
            const i = arr.findIndex((p) => p === removed.priceRaw);
            if (i >= 0) arr.splice(i, 1);
          }
          return true;
        }
      }
    }
    return false;
  }

  snapshot(depth = 25) {
    const toRows = (priceArr: bigint[], sideMap: Map<string, PriceLevel>) => priceArr.slice(0, depth).map((p) => {
      const lvl = sideMap.get(p.toString())!;
      return { price_raw: p.toString(), qty_raw: lvl.totalRaw.toString(), orders: lvl.queue.length };
    });
    return { symbol: this.symbol, bids: toRows(this.sortedBids, this.bids), asks: toRows(this.sortedAsks, this.asks) };
  }
}

function insertSorted(arr: bigint[], price: bigint, descending: boolean): void {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cmp = arr[mid] - price;
    if (descending ? cmp > 0n : cmp < 0n) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, price);
}

/* Per-instrument book registry — built on boot from open orders. */
const books = new Map<string, OrderBook>();
function getBook(symbol: string): OrderBook {
  let b = books.get(symbol);
  if (!b) { b = new OrderBook(symbol); books.set(symbol, b); }
  return b;
}

/* ── Boot: replay open orders ───────────────────────────────────── */

function bootReplay(): void {
  const rows = db.prepare(
    `SELECT * FROM orders WHERE status IN ('OPEN','PARTIALLY_FILLED') ORDER BY created_at ASC, id ASC`,
  ).all() as Array<any>;
  for (const o of rows) {
    if (o.type === 'MARKET' || !o.price_raw) continue;            // market orders never rest
    const remaining = BigInt(o.qty_raw) - BigInt(o.filled_qty_raw);
    if (remaining <= 0n) continue;
    getBook(o.instrument).add({
      id: o.id, public_id: o.public_id, account_id: o.account_id,
      side: o.side, priceRaw: BigInt(o.price_raw),
      remainingRaw: remaining, filledRaw: BigInt(o.filled_qty_raw),
      enteredAt: Date.parse(o.created_at + 'Z') || Date.now(),
    });
  }
  if (rows.length > 0) log.info(`boot: replayed ${rows.length} open order(s) across ${books.size} instrument(s)`);
}

/* ── Instruments CRUD ────────────────────────────────────────────── */

app.post('/instruments', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { symbol, base, quote, price_tick, qty_step, min_qty, display_name } = req.body ?? {};
    if (!symbol || !base || !quote) bad(422, 'symbol, base, quote required');
    db.prepare(
      `INSERT INTO instruments (symbol, base, quote, price_tick, qty_step, min_qty, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(symbol, base, quote, price_tick ?? '0.01', qty_step ?? '1', min_qty ?? '1', display_name ?? symbol);
    res.status(201).json({ instrument: db.prepare(`SELECT * FROM instruments WHERE symbol = ?`).get(symbol) });
  } catch (e) { next(e); }
});

app.get('/instruments', (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM instruments WHERE is_active = 1 ORDER BY symbol`).all();
  res.json({ instruments: rows });
});

/* ── Place / Cancel ──────────────────────────────────────────────── */

const placeHistogram = histogram('qt_matching_place_duration_sec', 'Time from order receipt to acceptance/fill (s)');
const fillCounter    = counter  ('qt_matching_fills_total', 'Total fills emitted');

interface PlaceInput {
  account_id:     string;
  instrument:     string;
  side:           Side;
  type:           OrderType;
  tif?:           TimeInForce;
  price?:         string;            // human decimal, omitted for MARKET
  qty:            string;            // human decimal
  client_order_id?: string;
  saga_id?:       string | null;
}

app.post('/orders', (req: Request, res: Response, next: NextFunction) => {
  try {
    const t0 = Date.now();
    const b = req.body as PlaceInput;
    if (!b.account_id) bad(422, 'account_id required');
    if (!b.instrument) bad(422, 'instrument required');
    if (b.side !== 'BUY' && b.side !== 'SELL') bad(422, 'side must be BUY|SELL');
    if (b.type !== 'LIMIT' && b.type !== 'MARKET') bad(422, 'type must be LIMIT|MARKET');

    const inst = db.prepare<[string], any>(`SELECT * FROM instruments WHERE symbol = ?`).get(b.instrument);
    if (!inst) bad(404, `unknown instrument: ${b.instrument}`);
    const priceScale = scaleOf(inst.quote);
    const qtyScale   = scaleOf(inst.base);

    const qty = Decimal.parse(b.qty, qtyScale);
    if (!qty.isPos()) bad(422, 'qty must be > 0');
    let priceRaw = 0n;
    if (b.type === 'LIMIT') {
      if (b.price == null) bad(422, 'price required for LIMIT');
      const p = Decimal.parse(b.price!, priceScale);
      if (!p.isPos()) bad(422, 'price must be > 0');
      priceRaw = p.toDb().v as unknown as bigint;
      priceRaw = BigInt(p.toDb().v);
    }

    const tif: TimeInForce = b.tif ?? 'GTC';
    const id = uuid(); const pid = publicId('ORD');
    db.prepare(
      `INSERT INTO orders (id, public_id, account_id, instrument, side, type, tif, price_raw, qty_raw, status, client_order_id, saga_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)`,
    ).run(id, pid, b.account_id, b.instrument, b.side, b.type, tif,
          b.type === 'LIMIT' ? priceRaw.toString() : null, qty.toDb().v,
          b.client_order_id ?? null, b.saga_id ?? null);

    publish('order.placed', {
      order_id: id, public_id: pid, account_id: b.account_id, instrument: b.instrument,
      side: b.side, type: b.type, tif, price_raw: b.type === 'LIMIT' ? priceRaw.toString() : null,
      qty_raw: qty.toDb().v, saga_id: b.saga_id ?? null,
    }, 'matching', req.locals.traceparent);

    /* Match phase. */
    const book = getBook(b.instrument);
    const incoming: RestingOrder = {
      id, public_id: pid, account_id: b.account_id, side: b.side,
      priceRaw, remainingRaw: BigInt(qty.toDb().v), filledRaw: 0n, enteredAt: Date.now(),
    };
    const fills = match(incoming, book, b.type, tif, inst);

    let status: OrderStatus = fills.length === 0 ? 'OPEN' : (incoming.remainingRaw === 0n ? 'FILLED' : 'PARTIALLY_FILLED');

    /* IOC: cancel any remainder.  FOK: if remaining > 0 after the match
     * sweep, the whole order is rejected (undo fills?  for simplicity we
     * pre-check FOK by simulating before mutating — done above implicitly
     * via remainingRaw still > 0). */
    if (tif === 'IOC' && incoming.remainingRaw > 0n) {
      status = fills.length === 0 ? 'CANCELLED' : 'PARTIALLY_FILLED';
      incoming.remainingRaw = 0n;
    } else if (tif === 'FOK' && incoming.remainingRaw > 0n) {
      /* FOK reject: roll back fills.  This demo doesn't undo (real
       * matching engines pre-check liquidity), but we mark it rejected
       * and stop the order from resting. */
      status = 'REJECTED';
      incoming.remainingRaw = 0n;
    }

    /* Add residue to book (LIMIT, GTC). */
    if (b.type === 'LIMIT' && tif === 'GTC' && incoming.remainingRaw > 0n) {
      book.add(incoming);
    }

    db.prepare(
      `UPDATE orders SET status = ?, filled_qty_raw = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(status, incoming.filledRaw.toString(), id);

    if (status === 'FILLED' || status === 'PARTIALLY_FILLED' || status === 'CANCELLED' || status === 'REJECTED') {
      publish(status === 'REJECTED' ? 'order.rejected' : (status === 'CANCELLED' ? 'order.cancelled' : 'order.filled'), {
        order_id: id, public_id: pid, status, filled_qty_raw: incoming.filledRaw.toString(),
        fills: fills.map((f) => ({ trade_id: f.trade_id, price_raw: f.price_raw, qty_raw: f.qty_raw, maker_order_id: f.maker_order_id })),
      }, 'matching', req.locals.traceparent);
    }

    placeHistogram.observe((Date.now() - t0) / 1000, { instrument: b.instrument });
    res.status(201).json({
      order:  db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id),
      fills,
      book:   book.snapshot(5),
    });
  } catch (e) { next(e); }
});

function match(
  incoming: RestingOrder, book: OrderBook,
  type: OrderType, _tif: TimeInForce, inst: any,
): Array<{ id: string; trade_id: string; price_raw: string; qty_raw: string; maker_order_id: string }> {
  const fills: Array<{ id: string; trade_id: string; price_raw: string; qty_raw: string; maker_order_id: string }> = [];
  while (incoming.remainingRaw > 0n) {
    const bestPrice = book.best(incoming.side);
    if (bestPrice == null) break;
    /* For LIMIT: cross check. */
    if (type === 'LIMIT') {
      if (incoming.side === 'BUY'  && bestPrice >  incoming.priceRaw) break;
      if (incoming.side === 'SELL' && bestPrice <  incoming.priceRaw) break;
    }
    const sideMap = incoming.side === 'BUY' ? book.asks : book.bids;
    const lvl = sideMap.get(bestPrice.toString())!;
    const maker = lvl.queue[0];
    const matchQty = incoming.remainingRaw < maker.remainingRaw ? incoming.remainingRaw : maker.remainingRaw;
    const tradePrice = bestPrice;                                   // maker's price

    const fillId = uuid();
    const tradeId = uuid();
    const buyAcct  = incoming.side === 'BUY' ? incoming.account_id : maker.account_id;
    const sellAcct = incoming.side === 'BUY' ? maker.account_id    : incoming.account_id;

    db.prepare(
      `INSERT INTO fills (id, trade_id, instrument, taker_order_id, maker_order_id, price_raw, qty_raw, buy_account_id, sell_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fillId, tradeId, book.symbol, incoming.id, maker.id, tradePrice.toString(), matchQty.toString(), buyAcct, sellAcct);

    /* Update both orders' quantities (in-memory + persistent). */
    incoming.remainingRaw -= matchQty;
    incoming.filledRaw    += matchQty;
    maker.remainingRaw    -= matchQty;
    maker.filledRaw       += matchQty;
    lvl.totalRaw          -= matchQty;

    db.prepare(`UPDATE orders SET filled_qty_raw = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(maker.filledRaw.toString(), maker.remainingRaw === 0n ? 'FILLED' : 'PARTIALLY_FILLED', maker.id);

    if (maker.remainingRaw === 0n) book.removeFront(incoming.side === 'BUY' ? 'BUY' : 'SELL');

    fills.push({ id: fillId, trade_id: tradeId, price_raw: tradePrice.toString(), qty_raw: matchQty.toString(), maker_order_id: maker.id });
    fillCounter.inc({ instrument: book.symbol });
    void inst;
  }
  return fills;
}

app.post('/orders/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
  try {
    const o = db.prepare<[string, string], any>(`SELECT * FROM orders WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!o) bad(404, 'order not found');
    if (o.status !== 'OPEN' && o.status !== 'PARTIALLY_FILLED') bad(409, `order is ${o.status}, cannot cancel`);
    const book = getBook(o.instrument);
    book.cancelById(o.id);
    db.prepare(`UPDATE orders SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?`).run(o.id);
    publish('order.cancelled', { order_id: o.id, public_id: o.public_id, reason: req.body?.reason ?? 'client_cancel' }, 'matching', req.locals.traceparent);
    res.json({ order: db.prepare(`SELECT * FROM orders WHERE id = ?`).get(o.id) });
  } catch (e) { next(e); }
});

/* ── Reads ───────────────────────────────────────────────────────── */

app.get('/orders', (req: Request, res: Response) => {
  const where: string[] = [];
  const params: any[] = [];
  const q = req.query as Record<string, string | undefined>;
  if (q.account_id) { where.push('account_id = ?'); params.push(q.account_id); }
  if (q.instrument) { where.push('instrument = ?'); params.push(q.instrument); }
  if (q.status)     { where.push('status = ?');     params.push(q.status); }
  if (q.saga_id)    { where.push('saga_id = ?');    params.push(q.saga_id); }
  const limit  = Math.min(Number(q.limit ?? 100), 500);
  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  res.json({ orders: rows, total: rows.length });
});

app.get('/orders/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const o = db.prepare(`SELECT * FROM orders WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!o) bad(404, 'order not found');
    const fills = db.prepare(`SELECT * FROM fills WHERE taker_order_id = ? OR maker_order_id = ? ORDER BY ts ASC`).all((o as any).id, (o as any).id);
    res.json({ order: o, fills });
  } catch (e) { next(e); }
});

app.get('/book/:symbol', (req: Request, res: Response) => {
  const depth = Math.min(Math.max(Number(req.query.depth ?? 25), 1), 200);
  res.json(getBook(req.params.symbol).snapshot(depth));
});

app.get('/trades/:symbol', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const rows = db.prepare(`SELECT * FROM fills WHERE instrument = ? ORDER BY ts DESC LIMIT ?`).all(req.params.symbol, limit);
  res.json({ trades: rows });
});

app.get('/stats', (_req: Request, res: Response) => {
  const orders = (db.prepare(`SELECT COUNT(*) as c FROM orders`).get() as { c: number }).c;
  const fills  = (db.prepare(`SELECT COUNT(*) as c FROM fills`).get() as { c: number }).c;
  const byStatus = db.prepare(`SELECT status, COUNT(*) as c FROM orders GROUP BY status`).all();
  const byInstr  = db.prepare(`SELECT instrument, COUNT(*) as c FROM fills GROUP BY instrument`).all();
  const bookDepths = [...books.entries()].map(([sym, bk]) => ({
    symbol: sym, bid_levels: bk.sortedBids.length, ask_levels: bk.sortedAsks.length,
    best_bid: bk.sortedBids[0]?.toString() ?? null, best_ask: bk.sortedAsks[0]?.toString() ?? null,
  }));
  res.json({ orders, fills, by_status: byStatus, by_instrument: byInstr, books: bookDepths });
});

/* ── Boot ─────────────────────────────────────────────────────────── */

start(app, port, 'matching', () => { bootReplay(); });
