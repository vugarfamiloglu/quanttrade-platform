/**
 * Distributed-lock primitive — Redlock-shape contract.
 *
 *   await withLock(key, async () => { ...critical section... });
 *
 * In a production deployment the implementation would be Redis with
 * SET NX PX (Redlock algorithm).  The contract here is identical:
 * one holder per key at a time, with a TTL guard so a crashed holder
 * doesn't deadlock the key forever.
 *
 * The single-process implementation is a per-key promise chain — any
 * caller asking for the same key waits for the previous holder's
 * promise to settle.  Multi-process is simulated via a SQLite advisory
 * row that includes an expiry; this works as a baseline correctness
 * check across processes on the same host.
 */

import { openDb, uuid } from './db';
import { setTimeout as sleep } from 'node:timers/promises';

/* In-process fast path: per-key promise chain. */
const inflight = new Map<string, Promise<void>>();

/* Cross-process baseline: shared SQLite table with TTL expiry. */
let _db: ReturnType<typeof openDb> | null = null;
function lockDb() {
  if (_db) return _db;
  _db = openDb('locks');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS locks (
      key         TEXT PRIMARY KEY,
      holder      TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );
  `);
  return _db;
}

export interface LockOptions {
  /** Max time to block waiting for the lock before giving up (ms). */
  waitMs?: number;
  /** How long the holder may hold it before it's considered dead (ms). */
  ttlMs?: number;
}

const DEFAULTS = { waitMs: 5000, ttlMs: 10_000 };

export class LockTimeoutError extends Error {
  constructor(key: string) { super(`lock acquisition timed out for "${key}"`); this.name = 'LockTimeoutError'; }
}

/** Try to acquire the lock; on success return a release fn.  On
 *  failure (after waitMs of trying) throw LockTimeoutError. */
export async function acquire(key: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const { waitMs, ttlMs } = { ...DEFAULTS, ...opts };
  const deadline = Date.now() + waitMs;

  /* In-process gate first — cheap. */
  const existing = inflight.get(key);
  if (existing) await existing;

  /* Cross-process gate via SQLite row. */
  const holder = uuid();
  const db = lockDb();
  while (true) {
    /* Sweep expired rows so a crashed process can't deadlock us. */
    db.prepare(`DELETE FROM locks WHERE expires_at < datetime('now')`).run();
    try {
      db.prepare(
        `INSERT INTO locks (key, holder, acquired_at, expires_at)
         VALUES (?, ?, datetime('now'), datetime('now', ?))`,
      ).run(key, holder, `+${Math.ceil(ttlMs / 1000)} seconds`);
      break;            // got the row
    } catch (e: any) {
      if (!String(e?.message ?? '').includes('UNIQUE')) throw e;
      if (Date.now() > deadline) throw new LockTimeoutError(key);
      await sleep(15);
    }
  }

  /* Install in-process barrier so colocated callers cooperate. */
  let releaseInProcess!: () => void;
  const inProcessP = new Promise<void>((resolve) => { releaseInProcess = resolve; });
  inflight.set(key, inProcessP);

  return async () => {
    try {
      db.prepare(`DELETE FROM locks WHERE key = ? AND holder = ?`).run(key, holder);
    } finally {
      inflight.delete(key);
      releaseInProcess();
    }
  };
}

export async function withLock<T>(key: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const release = await acquire(key, opts);
  try { return await fn(); }
  finally { await release(); }
}

export function activeLocks(): Array<{ key: string; holder: string; acquired_at: string; expires_at: string }> {
  return lockDb().prepare(`SELECT * FROM locks WHERE expires_at >= datetime('now') ORDER BY acquired_at DESC`).all() as any;
}
