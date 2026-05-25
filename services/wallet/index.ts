/**
 * Wallet Service (port 5122).
 *
 * Holds every account's funds, but never as a mutable balance row.
 * The source of truth is the immutable event log — every balance
 * change is an event:
 *
 *   AccountOpened · Deposited · Withdrew
 *   FundsHeld · FundsReleased
 *   TradeDebited · TradeCredited · FeeCharged
 *
 * The current balance is the LEFT-FOLD of the event stream:
 *   state = events.reduce(apply, zero)
 *
 * For O(1) reads we cache the current state in `balances`.  For
 * bounded recovery time (RTO), we snapshot every QT_SNAPSHOT_EVERY
 * events.  Cold start = load latest snapshot + replay only events
 * with seq > snapshot.up_to_seq.
 *
 * Concurrency safety: every mutation acquires a distributed lock
 * keyed on (account, asset).  Two pods racing on the same key would
 * see the same available balance and double-spend; the lock makes
 * the read-modify-write atomic across the cluster.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, uuid, publicId } from '../../lib/db';
import { withLock } from '../../lib/distributed-lock';
import { publish } from '../../lib/broker';
import { latestSnapshot, writeSnapshot, shouldSnapshot, ensureSchema as ensureSnapshotSchema } from '../../lib/snapshot';
import { Decimal, scaleOf } from '../../lib/decimal';
import { histogram } from '../../lib/metrics';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'wallet',
  port: Number(process.env.QT_WALLET_PORT ?? 5122),
});

const db = openDb('wallet');

/* ── Schema ───────────────────────────────────────────────────────── */

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id           TEXT PRIMARY KEY,
    public_id    TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    email        TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /* The wallet event log — append-only, the source of truth. */
  CREATE TABLE IF NOT EXISTS wallet_events (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    asset             TEXT NOT NULL,
    kind              TEXT NOT NULL,
    amount_raw        TEXT NOT NULL,
    related_order_id  TEXT,
    related_fill_id   TEXT,
    metadata_json     TEXT NOT NULL DEFAULT '{}',
    seq               INTEGER NOT NULL,    -- monotonic per account
    ts                TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_walev_acct_seq ON wallet_events(account_id, seq);
  /* seq is monotonic PER (account, asset) — the per-asset lock
   * serializes writes within that pair but two writes for the same
   * account on different assets advance their seqs independently. */
  CREATE UNIQUE INDEX IF NOT EXISTS uq_walev_acct_asset_seq ON wallet_events(account_id, asset, seq);

  /* Materialised projection — O(1) reads.  Trust the event log if
   * this ever diverges; the invariant scanner re-checks periodically. */
  CREATE TABLE IF NOT EXISTS balances (
    account_id TEXT NOT NULL,
    asset      TEXT NOT NULL,
    total_raw  TEXT NOT NULL DEFAULT '0',
    held_raw   TEXT NOT NULL DEFAULT '0',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, asset)
  );
`);

/* Append-only triggers — no UPDATE/DELETE on the event log. */
const triggerExists = (n: string) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`).get(n);
if (!triggerExists('walev_no_update')) db.exec(`CREATE TRIGGER walev_no_update BEFORE UPDATE ON wallet_events BEGIN SELECT RAISE(ABORT, 'wallet events are append-only'); END;`);
if (!triggerExists('walev_no_delete')) db.exec(`CREATE TRIGGER walev_no_delete BEFORE DELETE ON wallet_events BEGIN SELECT RAISE(ABORT, 'wallet events cannot be deleted'); END;`);

ensureSnapshotSchema(db);

/* ── Projection ──────────────────────────────────────────────────── */

interface AssetState { total_raw: string; held_raw: string; }
type AccountState = Record<string /* asset */, AssetState>;

function zeroState(): AccountState { return {}; }

function applyEvent(state: AccountState, ev: { asset: string; kind: string; amount_raw: string }): AccountState {
  const next: AccountState = { ...state };
  const cur: AssetState = next[ev.asset] ?? { total_raw: '0', held_raw: '0' };
  const scale = scaleOf(ev.asset);
  const total = Decimal.fromDb(cur.total_raw, scale);
  const held  = Decimal.fromDb(cur.held_raw,  scale);
  const amount = Decimal.fromDb(ev.amount_raw, scale);

  let nextTotal = total, nextHeld = held;
  switch (ev.kind) {
    case 'AccountOpened':                                                break;
    case 'Deposited':       nextTotal = total.add(amount);              break;
    case 'Withdrew':        nextTotal = total.sub(amount);              break;
    case 'FundsHeld':       nextHeld  = held.add(amount);                break;
    case 'FundsReleased':   nextHeld  = held.sub(amount);                break;
    case 'TradeDebited': {
      nextTotal = total.sub(amount);
      /* Settle against any outstanding hold first, then any remaining
       * debit comes out of free funds.  This single rule lets the
       * SAME event kind work for both the saga's taker (who pre-held)
       * AND the resting maker (who never did). */
      const reduceBy = amount.lte(held) ? amount : held;
      nextHeld = held.sub(reduceBy);
      break;
    }
    case 'TradeCredited':   nextTotal = total.add(amount);              break;
    case 'FeeCharged':      nextTotal = total.sub(amount);              break;
    default:                throw new Error(`unknown event kind: ${ev.kind}`);
  }
  next[ev.asset] = { total_raw: nextTotal.toDb().v, held_raw: nextHeld.toDb().v };
  return next;
}

/** Cold-start recovery: snapshot + replay since.  Returns ms elapsed
 * so we can prove the snapshot really compresses recovery time. */
function rebuildAccount(accountId: string): { eventsReplayed: number; snapshotSeq: number; ms: number; state: AccountState } {
  const t0 = Date.now();
  const snap = latestSnapshot<AccountState>(db, accountId);
  let state = snap ? snap.state : zeroState();
  const since = snap?.up_to_seq ?? 0;
  const rows = db.prepare<[string, number], { seq: number; asset: string; kind: string; amount_raw: string }>(
    `SELECT seq, asset, kind, amount_raw FROM wallet_events WHERE account_id = ? AND seq > ? ORDER BY seq ASC`,
  ).all(accountId, since);
  for (const r of rows) state = applyEvent(state, r);
  return { eventsReplayed: rows.length, snapshotSeq: since, ms: Date.now() - t0, state };
}

/* ── Cache projection into `balances` ────────────────────────────── */

function writeBalances(accountId: string, state: AccountState): void {
  const stmt = db.prepare(`INSERT INTO balances (account_id, asset, total_raw, held_raw, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
                            ON CONFLICT (account_id, asset) DO UPDATE SET total_raw = excluded.total_raw, held_raw = excluded.held_raw, updated_at = datetime('now')`);
  const txn = db.transaction(() => {
    for (const [asset, s] of Object.entries(state)) stmt.run(accountId, asset, s.total_raw, s.held_raw);
  });
  txn();
}

/** On boot, replay all known accounts into the cache.  In production
 * Cassandra would survive the wallet pod crashing; we do it on disk. */
function bootRebuildAll(): void {
  const ids = db.prepare(`SELECT id FROM accounts`).all() as Array<{ id: string }>;
  const t0 = Date.now();
  for (const { id } of ids) {
    const r = rebuildAccount(id);
    writeBalances(id, r.state);
    if (r.eventsReplayed > 0) {
      log.info(`recovered ${id.slice(0, 8)} from snapshot@${r.snapshotSeq} + ${r.eventsReplayed} events in ${r.ms}ms`);
    }
  }
  if (ids.length > 0) log.info(`cold start: ${ids.length} account(s) rebuilt in ${Date.now() - t0}ms total`);
}
bootRebuildAll();

/* ── Event append + snapshot trigger ─────────────────────────────── */

const writeHistogram = histogram('qt_wallet_write_duration_sec', 'Wallet event-append latency (s)');

interface AppendInput {
  account_id: string;
  asset: string;
  kind: 'AccountOpened' | 'Deposited' | 'Withdrew' | 'FundsHeld' | 'FundsReleased' | 'TradeDebited' | 'TradeCredited' | 'FeeCharged';
  amount_raw?: string;          // omit for AccountOpened
  related_order_id?: string | null;
  related_fill_id?:  string | null;
  metadata?: Record<string, any>;
  traceparent?: string | null;
}

/**
 * Race-safe append.  ALL writes for an (account, asset) serialise
 * through the distributed lock.  Inside the lock:
 *   1. Compute next seq
 *   2. Validate (e.g. hold ≤ available)
 *   3. INSERT event
 *   4. Update balances cache
 *   5. Snapshot if N events since last
 *   6. Publish wallet.event for downstream consumers
 */
async function appendEvent(input: AppendInput): Promise<{ seq: number; state: AssetState }> {
  const lockKey = `wallet:${input.account_id}:${input.asset}`;
  return withLock(lockKey, async () => {
    const t0 = Date.now();
    const next = (db.prepare<[string, string], { mx: number }>(
      `SELECT COALESCE(MAX(seq), 0) as mx FROM wallet_events WHERE account_id = ? AND asset = ?`,
    ).get(input.account_id, input.asset)?.mx ?? 0) + 1;
    const amount = input.amount_raw ?? '0';

    /* Validate against the CURRENT cached state — we hold the lock,
     * so no one else can race us. */
    const cur = (db.prepare<[string, string], { total_raw: string; held_raw: string }>(
      `SELECT total_raw, held_raw FROM balances WHERE account_id = ? AND asset = ?`,
    ).get(input.account_id, input.asset)) ?? { total_raw: '0', held_raw: '0' };

    const scale = scaleOf(input.asset);
    const total = Decimal.fromDb(cur.total_raw, scale);
    const held  = Decimal.fromDb(cur.held_raw,  scale);
    const amt   = Decimal.fromDb(amount, scale);
    if (input.kind === 'Withdrew' || input.kind === 'FundsHeld') {
      const available = total.sub(held);
      if (amt.gt(available)) {
        bad(409, `insufficient available ${input.asset}: have ${available.toString()}, need ${amt.toString()}`);
      }
    }
    if (input.kind === 'FundsReleased') {
      if (amt.gt(held)) {
        bad(409, `cannot release ${amt.toString()} ${input.asset}: only ${held.toString()} held`);
      }
    }
    if (input.kind === 'TradeDebited' || input.kind === 'FeeCharged') {
      /* Trade debits drain total directly.  Validation: we must have
       * enough total funds (anything beyond the held pool comes out of
       * available). */
      if (amt.gt(total)) {
        bad(409, `insufficient total to ${input.kind} ${amt.toString()} ${input.asset}: have ${total.toString()}`);
      }
    }

    const id = uuid();
    db.prepare(
      `INSERT INTO wallet_events (id, account_id, asset, kind, amount_raw, related_order_id, related_fill_id, metadata_json, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.account_id, input.asset, input.kind, amount, input.related_order_id ?? null, input.related_fill_id ?? null, JSON.stringify(input.metadata ?? {}), next);

    /* Project the change into the cache. */
    const newState = applyEvent({ [input.asset]: cur }, { asset: input.asset, kind: input.kind, amount_raw: amount });
    db.prepare(
      `INSERT INTO balances (account_id, asset, total_raw, held_raw, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (account_id, asset) DO UPDATE SET total_raw = excluded.total_raw, held_raw = excluded.held_raw, updated_at = datetime('now')`,
    ).run(input.account_id, input.asset, newState[input.asset].total_raw, newState[input.asset].held_raw);

    /* Snapshot mechanism — every N events the whole account state is
     * frozen so cold recovery is bounded. */
    const totalSinceSnap = db.prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) as c FROM wallet_events WHERE account_id = ?
        AND seq > COALESCE((SELECT MAX(up_to_seq) FROM snapshots WHERE account_id = ?), 0)`,
    ).get(input.account_id, input.account_id)?.c ?? 0;
    if (shouldSnapshot(totalSinceSnap)) {
      const r = rebuildAccount(input.account_id);
      writeSnapshot(db, input.account_id, r.eventsReplayed > 0 ? next : next, r.state);
      publish('wallet.snapshot', { account_id: input.account_id, up_to_seq: next }, 'wallet');
      log.info(`snapshot taken for ${input.account_id.slice(0, 8)} @seq=${next}`);
    }

    /* Tell the world. */
    publish('wallet.event', {
      account_id: input.account_id, asset: input.asset, kind: input.kind,
      amount_raw: amount, seq: next, related_order_id: input.related_order_id, related_fill_id: input.related_fill_id,
    }, 'wallet', input.traceparent ?? null);

    writeHistogram.observe((Date.now() - t0) / 1000, { kind: input.kind });
    return { seq: next, state: newState[input.asset] };
  }, { waitMs: 5000, ttlMs: 5000 });
}

/* ── Routes ──────────────────────────────────────────────────────── */

app.post('/accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { display_name, email, opening_deposits } = req.body ?? {};
    if (!display_name) bad(422, 'display_name required');
    if (!email)        bad(422, 'email required');
    const id = uuid(); const pid = publicId('ACC');
    db.prepare(`INSERT INTO accounts (id, public_id, display_name, email) VALUES (?, ?, ?, ?)`).run(id, pid, display_name, email);
    /* Optional opening deposits: array of { asset, amount } */
    for (const dep of (opening_deposits ?? [])) {
      await appendEvent({ account_id: id, asset: dep.asset, kind: 'Deposited', amount_raw: Decimal.parse(dep.amount, scaleOf(dep.asset)).toDb().v });
    }
    log.info(`opened account ${pid} (${display_name})`);
    res.status(201).json({ account: db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) });
  } catch (e) { next(e); }
});

app.get('/accounts', (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM accounts ORDER BY created_at DESC`).all();
  res.json({ accounts: rows, total: rows.length });
});

app.get('/accounts/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = db.prepare(`SELECT * FROM accounts WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!a) bad(404, 'account not found');
    const balances = db.prepare(`SELECT * FROM balances WHERE account_id = ?`).all((a as any).id);
    res.json({ account: a, balances: balances.map((b: any) => {
      const scale = scaleOf(b.asset);
      const total = Decimal.fromDb(b.total_raw, scale);
      const held  = Decimal.fromDb(b.held_raw,  scale);
      return { ...b, available_raw: total.sub(held).toDb().v };
    }) });
  } catch (e) { next(e); }
});

app.get('/accounts/:id/events', (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = db.prepare(`SELECT * FROM accounts WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!a) bad(404, 'account not found');
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const events = db.prepare(`SELECT * FROM wallet_events WHERE account_id = ? ORDER BY seq DESC LIMIT ?`).all((a as any).id, limit);
    res.json({ events, total: events.length });
  } catch (e) { next(e); }
});

app.get('/accounts/:id/snapshots', (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = db.prepare(`SELECT * FROM accounts WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!a) bad(404, 'account not found');
    const snaps = db.prepare(`SELECT id, up_to_seq, ts FROM snapshots WHERE account_id = ? ORDER BY up_to_seq DESC LIMIT 50`).all((a as any).id);
    res.json({ snapshots: snaps });
  } catch (e) { next(e); }
});

/** POST /events — single append.  Body: AppendInput (without traceparent). */
app.post('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await appendEvent({ ...req.body, traceparent: req.locals.traceparent });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

/** POST /hold — convenience: append FundsHeld. */
app.post('/hold', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account_id, asset, amount, order_id } = req.body ?? {};
    if (!account_id || !asset || amount == null) bad(422, 'account_id, asset, amount required');
    const amt = Decimal.parse(amount, scaleOf(asset));
    if (!amt.isPos()) bad(422, 'amount must be > 0');
    const r = await appendEvent({
      account_id, asset, kind: 'FundsHeld',
      amount_raw: amt.toDb().v, related_order_id: order_id ?? null,
      traceparent: req.locals.traceparent,
    });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

app.post('/release', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account_id, asset, amount, order_id } = req.body ?? {};
    const amt = Decimal.parse(amount, scaleOf(asset));
    const r = await appendEvent({ account_id, asset, kind: 'FundsReleased', amount_raw: amt.toDb().v, related_order_id: order_id ?? null, traceparent: req.locals.traceparent });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

app.post('/debit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account_id, asset, amount, fill_id } = req.body ?? {};
    const amt = Decimal.parse(amount, scaleOf(asset));
    const r = await appendEvent({ account_id, asset, kind: 'TradeDebited', amount_raw: amt.toDb().v, related_fill_id: fill_id ?? null, traceparent: req.locals.traceparent });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

app.post('/credit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account_id, asset, amount, fill_id } = req.body ?? {};
    const amt = Decimal.parse(amount, scaleOf(asset));
    const r = await appendEvent({ account_id, asset, kind: 'TradeCredited', amount_raw: amt.toDb().v, related_fill_id: fill_id ?? null, traceparent: req.locals.traceparent });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

/** POST /accounts/:id/rebuild — operator action: throws away the cache
 *  and rebuilds from snapshot+events.  Proves event-sourcing recovery. */
app.post('/accounts/:id/rebuild', (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = db.prepare(`SELECT * FROM accounts WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!a) bad(404, 'account not found');
    db.prepare(`DELETE FROM balances WHERE account_id = ?`).run((a as any).id);
    const r = rebuildAccount((a as any).id);
    writeBalances((a as any).id, r.state);
    log.info(`manual rebuild of ${(a as any).public_id}: snapshot@${r.snapshotSeq} + ${r.eventsReplayed} events in ${r.ms}ms`);
    res.json({ ok: true, snapshot_seq: r.snapshotSeq, events_replayed: r.eventsReplayed, recovery_ms: r.ms });
  } catch (e) { next(e); }
});

app.get('/stats', (_req: Request, res: Response) => {
  const accounts = (db.prepare(`SELECT COUNT(*) as c FROM accounts`).get() as { c: number }).c;
  const events   = (db.prepare(`SELECT COUNT(*) as c FROM wallet_events`).get() as { c: number }).c;
  const snaps    = (db.prepare(`SELECT COUNT(*) as c FROM snapshots`).get() as { c: number }).c;
  const byAsset  = db.prepare(`SELECT asset, COUNT(*) as c FROM wallet_events GROUP BY asset`).all();
  res.json({ accounts, events, snapshots: snaps, by_asset: byAsset, snapshot_every: Number(process.env.QT_SNAPSHOT_EVERY ?? 500) });
});

start(app, port, 'wallet');
