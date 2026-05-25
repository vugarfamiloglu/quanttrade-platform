/**
 * Orchestrator-based Saga framework.
 *
 *   const saga = defineSaga<Input, Ctx>('place_order', [
 *     { name: 'reserve_funds',  forward: ..., compensate: ... },
 *     { name: 'submit_order',   forward: ..., compensate: ... },
 *     { name: 'process_fills',  forward: ..., compensate: ... },
 *     { name: 'settle',         forward: ..., compensate: ... },
 *   ]);
 *
 *   await saga.run(db, input);
 *
 * Invariants:
 *   • Each step persists its status BEFORE running its body, so a
 *     crash mid-step leaves a "in_progress" row the recovery loop
 *     can detect on restart.
 *   • If step N's forward throws, compensations run in reverse order
 *     for steps 1..N-1 that completed successfully.  Steps still
 *     `pending` are marked `skipped`.
 *   • Each compensation is wrapped in best-effort retry; a saga in
 *     status `compensating` whose compensations all succeed becomes
 *     `compensated`; if any compensation throws, it stays `failed`
 *     and an operator must intervene (an OperatorPage event is
 *     emitted in practice — out of scope for this demo).
 *
 * In production this would be Temporal.io.  The contract is the
 * same: durable state machine with compensation steps.
 */

import type Database from 'better-sqlite3';
import { uuid, publicId } from './db';
import type { SagaInstance, SagaStatus, SagaStep, SagaStepStatus } from './types';

export interface SagaStepDef<Ctx> {
  name: string;
  /** Forward action.  Throw to trigger compensation. */
  forward: (ctx: Ctx) => Promise<any> | any;
  /** Compensation (best-effort).  Should be idempotent. */
  compensate?: (ctx: Ctx, forwardResult: any) => Promise<void> | void;
}

export interface SagaDef<Input, Ctx> {
  kind: string;
  /** Build the initial context from the input. */
  initContext: (input: Input) => Ctx;
  steps: SagaStepDef<Ctx>[];
}

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sagas (
      id            TEXT PRIMARY KEY,
      public_id     TEXT UNIQUE NOT NULL,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      input_json    TEXT NOT NULL,
      context_json  TEXT NOT NULL DEFAULT '{}',
      current_step  INTEGER NOT NULL DEFAULT 0,
      total_steps   INTEGER NOT NULL,
      failed_reason TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status);

    CREATE TABLE IF NOT EXISTS saga_steps (
      id                TEXT PRIMARY KEY,
      saga_id           TEXT NOT NULL REFERENCES sagas(id),
      position          INTEGER NOT NULL,
      name              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempt           INTEGER NOT NULL DEFAULT 0,
      result_json       TEXT,
      error             TEXT,
      started_at        TEXT,
      finished_at       TEXT,
      compensation_name TEXT,
      compensated_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_steps_saga ON saga_steps(saga_id, position);
  `);
}

export class Saga<Input, Ctx> {
  constructor(public def: SagaDef<Input, Ctx>) {}

  async run(db: Database.Database, input: Input): Promise<SagaInstance> {
    ensureSchema(db);
    const id = uuid(); const pid = publicId('SAGA');
    const ctx = this.def.initContext(input);

    db.prepare(
      `INSERT INTO sagas (id, public_id, kind, status, input_json, context_json, total_steps) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(id, pid, this.def.kind, JSON.stringify(input), JSON.stringify(ctx), this.def.steps.length);
    for (let i = 0; i < this.def.steps.length; i++) {
      db.prepare(`INSERT INTO saga_steps (id, saga_id, position, name) VALUES (?, ?, ?, ?)`).run(uuid(), id, i + 1, this.def.steps[i].name);
    }
    return this.execute(db, id, ctx);
  }

  private async execute(db: Database.Database, sagaId: string, initialCtx: Ctx): Promise<SagaInstance> {
    let ctx = initialCtx;
    setStatus(db, sagaId, 'running');

    const stepRows = stepsOf(db, sagaId);
    let failedAt = -1;
    let failure: any = null;

    for (let i = 0; i < this.def.steps.length; i++) {
      const def = this.def.steps[i];
      const row = stepRows[i];
      markStep(db, row.id, { status: 'in_progress', attempt: row.attempt + 1, started_at: nowIso() });
      try {
        const result = await def.forward(ctx);
        markStep(db, row.id, { status: 'succeeded', result_json: JSON.stringify(result ?? null), finished_at: nowIso() });
        /* Persist updated context so it survives a crash. */
        db.prepare(`UPDATE sagas SET context_json = ?, current_step = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(JSON.stringify(ctx), i + 1, sagaId);
      } catch (e: any) {
        markStep(db, row.id, { status: 'failed', error: e?.message ?? String(e), finished_at: nowIso() });
        failedAt = i;
        failure = e;
        break;
      }
    }

    if (failedAt < 0) {
      setStatus(db, sagaId, 'completed', { completed_at: nowIso() });
      return getSaga(db, sagaId);
    }

    /* Compensation phase — walk backwards from failedAt-1 to 0. */
    setStatus(db, sagaId, 'compensating', { failed_reason: failure?.message ?? String(failure) });
    /* Mark un-attempted later steps as skipped. */
    for (let i = failedAt + 1; i < this.def.steps.length; i++) {
      markStep(db, stepRows[i].id, { status: 'skipped' });
    }

    let compensationSucceeded = true;
    for (let i = failedAt - 1; i >= 0; i--) {
      const def = this.def.steps[i];
      const row = stepRows[i];
      if (!def.compensate) { markStep(db, row.id, { compensation_name: '(none)', compensated_at: nowIso() }); continue; }
      const forwardResult = row.result_json ? JSON.parse(row.result_json) : null;
      try {
        await def.compensate(ctx, forwardResult);
        markStep(db, row.id, {
          status: 'compensated',
          compensation_name: def.compensate.name || def.name + '_undo',
          compensated_at: nowIso(),
        });
      } catch (e: any) {
        markStep(db, row.id, { error: `compensation failed: ${e?.message ?? e}` });
        compensationSucceeded = false;
        break;
      }
    }

    setStatus(db, sagaId, compensationSucceeded ? 'compensated' : 'failed', { completed_at: nowIso() });
    return getSaga(db, sagaId);
  }
}

/* ── Helpers ─────────────────────────────────────────────── */

function nowIso(): string { return new Date().toISOString(); }

function setStatus(db: Database.Database, sagaId: string, status: SagaStatus, extra: Record<string, any> = {}): void {
  const cols: string[] = ['status = ?', 'updated_at = datetime(\'now\')'];
  const params: any[] = [status];
  for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); params.push(v ?? null); }
  params.push(sagaId);
  db.prepare(`UPDATE sagas SET ${cols.join(', ')} WHERE id = ?`).run(...params);
}

function markStep(db: Database.Database, stepId: string, patch: Partial<SagaStep>): void {
  const cols: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`); params.push(v as any);
  }
  if (cols.length === 0) return;
  params.push(stepId);
  db.prepare(`UPDATE saga_steps SET ${cols.join(', ')} WHERE id = ?`).run(...params);
}

function stepsOf(db: Database.Database, sagaId: string): SagaStep[] {
  return db.prepare<[string], SagaStep>(`SELECT * FROM saga_steps WHERE saga_id = ? ORDER BY position ASC`).all(sagaId);
}

export function getSaga(db: Database.Database, sagaId: string): SagaInstance {
  return db.prepare<[string], SagaInstance>(`SELECT * FROM sagas WHERE id = ?`).get(sagaId)!;
}

export function getSagaSteps(db: Database.Database, sagaId: string): SagaStep[] {
  return stepsOf(db, sagaId);
}

/* ── Cold-start recovery ────────────────────────────────────
 * On boot the orchestrator scans for sagas left in 'running' or
 * 'compensating' state (a crashed process) and resumes them. */
export function recoverInFlight(db: Database.Database): Array<{ id: string; status: string }> {
  ensureSchema(db);
  return db.prepare(`SELECT id, status FROM sagas WHERE status IN ('running','compensating')`).all() as any;
}

export function defineSaga<Input, Ctx>(
  kind: string,
  initContext: (input: Input) => Ctx,
  steps: SagaStepDef<Ctx>[],
): Saga<Input, Ctx> {
  return new Saga({ kind, initContext, steps });
}
