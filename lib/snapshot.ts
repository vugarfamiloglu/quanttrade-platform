/**
 * Snapshot — bounded-recovery helper for event-sourced state.
 *
 * The Wallet service keeps every state change as an event in an
 * append-only log.  Replaying from scratch is correct but O(N) in
 * total events — at a million events per account, recovery would be
 * minutes per cold start and our RTO budget would blow up.
 *
 * The fix is the classic event-sourcing pattern:
 *   • every N events, write a snapshot of the current state to a
 *     companion table (in production: Cassandra / ScyllaDB)
 *   • on cold start, load the latest snapshot for the account and
 *     replay only the events with seq > snapshot.up_to_seq
 *
 * This module is the orchestration around that — the actual
 * `applyEvent(state, event)` projection lives in the service.
 */

import type Database from 'better-sqlite3';
import { uuid } from './db';

export interface SnapshotRow<S = any> { id: string; account_id: string; up_to_seq: number; state: S; ts: string; }

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      up_to_seq  INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      ts         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_snap_account_seq ON snapshots(account_id, up_to_seq DESC);
  `);
}

export function latestSnapshot<S>(db: Database.Database, accountId: string): SnapshotRow<S> | null {
  ensureSchema(db);
  const row = db.prepare<[string], { id: string; account_id: string; up_to_seq: number; state_json: string; ts: string }>(
    `SELECT * FROM snapshots WHERE account_id = ? ORDER BY up_to_seq DESC LIMIT 1`,
  ).get(accountId);
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state_json) as S };
}

export function writeSnapshot<S>(db: Database.Database, accountId: string, upToSeq: number, state: S): void {
  ensureSchema(db);
  db.prepare(
    `INSERT INTO snapshots (id, account_id, up_to_seq, state_json) VALUES (?, ?, ?, ?)`,
  ).run(uuid(), accountId, upToSeq, JSON.stringify(state));
}

/**
 * Recover an account's state cold:
 *   1. Load the latest snapshot (or use the zero state).
 *   2. Replay every event with seq > snapshot.up_to_seq through the
 *      projection function.
 *   3. Return both the rebuilt state and the seq it's current at, so
 *      callers can decide whether to take a fresh snapshot.
 */
export function rebuildState<S>(
  db: Database.Database,
  accountId: string,
  zero: () => S,
  events: (sinceSeq: number) => Array<{ seq: number; event: any }>,
  apply: (state: S, event: any) => S,
): { state: S; seq: number; eventsReplayed: number; snapshotSeq: number } {
  const snap = latestSnapshot<S>(db, accountId);
  let state = snap ? snap.state : zero();
  let seq = snap?.up_to_seq ?? 0;
  const snapshotSeq = snap?.up_to_seq ?? 0;
  const rows = events(seq);
  for (const e of rows) {
    state = apply(state, e.event);
    seq = e.seq;
  }
  return { state, seq, eventsReplayed: rows.length, snapshotSeq };
}

export function shouldSnapshot(sinceSnapshot: number): boolean {
  return sinceSnapshot >= Number(process.env.QT_SNAPSHOT_EVERY ?? 500);
}
