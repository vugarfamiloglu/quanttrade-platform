/**
 * Idempotency engine.
 *
 *   const r = await withIdempotency(db, key, requestBody, () => doWork());
 *
 * Race-safe: the first request wins via UNIQUE constraint; concurrent
 * duplicates wait for the in-flight worker to settle and then receive
 * the same cached response.  Same key + different payload → 409.
 *
 * Trading systems care about idempotency at two layers — the client
 * supplies X-Idempotency-Key to make order placement safe to retry,
 * AND the saga orchestrator uses idempotency keys to make every step
 * safe to replay during recovery.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface IdempotentResponse<T> { status: number; body: T; }

const DEFAULT_TTL_HOURS = Number(process.env.QT_IDEMPOTENCY_TTL_HOURS ?? 24);

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      status TEXT NOT NULL DEFAULT 'in_flight' CHECK(status IN ('in_flight','completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);
  `);
}

function hashRequest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export class IdempotencyConflictError extends Error {
  constructor(public reason: string) { super(reason); this.name = 'IdempotencyConflictError'; }
}

export async function withIdempotency<T>(
  db: Database.Database,
  key: string,
  payload: unknown,
  worker: () => Promise<IdempotentResponse<T>> | IdempotentResponse<T>,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<IdempotentResponse<T>> {
  ensureSchema(db);
  const hash = hashRequest(payload);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

  db.prepare(`DELETE FROM idempotency_keys WHERE expires_at < datetime('now')`).run();

  let reserved = false;
  try {
    db.prepare(
      `INSERT INTO idempotency_keys (key, request_hash, status, expires_at) VALUES (?, ?, 'in_flight', ?)`,
    ).run(key, hash, expiresAt);
    reserved = true;
  } catch (e: any) {
    if (!String(e?.message ?? '').includes('UNIQUE')) throw e;
  }

  if (reserved) {
    try {
      const res = await worker();
      db.prepare(
        `UPDATE idempotency_keys SET response_status = ?, response_body = ?, status = 'completed', completed_at = datetime('now') WHERE key = ?`,
      ).run(res.status, JSON.stringify(res.body ?? null), key);
      return res;
    } catch (workerErr) {
      /* Worker errored — let client retry without 409. */
      db.prepare(`DELETE FROM idempotency_keys WHERE key = ? AND status = 'in_flight'`).run(key);
      throw workerErr;
    }
  }

  /* Slot already taken — inspect. */
  const existing = db.prepare<[string], any>(`SELECT * FROM idempotency_keys WHERE key = ?`).get(key);
  if (!existing) return withIdempotency(db, key, payload, worker, ttlHours);
  if (existing.request_hash !== hash) {
    throw new IdempotencyConflictError(`idempotency key reused with a different payload`);
  }
  if (existing.status === 'in_flight') {
    /* Spin-wait for the in-flight worker. */
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const fresh = db.prepare<[string], any>(`SELECT * FROM idempotency_keys WHERE key = ?`).get(key);
      if (fresh?.status === 'completed') {
        return { status: fresh.response_status, body: JSON.parse(fresh.response_body || 'null') as T };
      }
    }
    throw new IdempotencyConflictError('in-flight idempotent request did not settle in time');
  }
  return { status: existing.response_status, body: JSON.parse(existing.response_body || 'null') as T };
}
