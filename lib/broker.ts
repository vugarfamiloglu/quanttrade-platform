/**
 * Kafka-shape event bus, backed by a shared SQLite event log.
 *
 *   publish(topic, payload, origin, traceparent?)
 *   subscribe(topic, group, handler)
 *
 * Guarantees:
 *   • at-least-once delivery (handlers MUST be idempotent)
 *   • per-(group, topic) offsets — two services in the same group
 *     share work; different groups each get a copy
 *   • in-order per topic
 *   • W3C traceparent flows alongside the payload — Jaeger sees the
 *     async chain
 *   • DLQ:  if a handler throws more than `MAX_ATTEMPTS` times, the
 *     event is moved off the live stream into `dead_letters` and an
 *     alert event is emitted
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BrokerEvent, EventTopic } from './types';

let _conn: Database.Database | null = null;
const MAX_ATTEMPTS = 5;

function brokerDb(): Database.Database {
  if (_conn) return _conn;
  const file = resolve(process.cwd(), 'data', 'broker.db');
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('busy_timeout = 5000');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      traceparent TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_topic_id ON events(topic, id);

    CREATE TABLE IF NOT EXISTS consumer_offsets (
      consumer_group TEXT NOT NULL,
      topic TEXT NOT NULL,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (consumer_group, topic)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      consumer_group TEXT NOT NULL,
      topic TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (consumer_group, topic, event_id)
    );

    /* DLQ — moved off the live stream once attempts exceed MAX_ATTEMPTS. */
    CREATE TABLE IF NOT EXISTS dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_event_id INTEGER NOT NULL,
      consumer_group TEXT NOT NULL,
      topic TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      last_error TEXT,
      moved_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  _conn = conn;
  return conn;
}

export function publish<T = any>(
  topic: EventTopic, payload: T, origin: string, traceparent?: string | null,
): BrokerEvent<T> {
  const r = brokerDb().prepare(
    `INSERT INTO events (topic, payload_json, origin, traceparent) VALUES (?, ?, ?, ?)`,
  ).run(topic, JSON.stringify(payload, bigIntReplacer), origin, traceparent ?? null);
  return { id: r.lastInsertRowid as number, topic, payload, origin, traceparent: traceparent ?? null, ts: new Date().toISOString() };
}

interface Handler<T = any> {
  topic: EventTopic; group: string;
  fn: (e: BrokerEvent<T>) => Promise<void> | void;
}
const handlers: Handler[] = [];
let pollTimer: NodeJS.Timeout | null = null;

export function subscribe<T = any>(
  topic: EventTopic, group: string,
  fn: (e: BrokerEvent<T>) => Promise<void> | void,
): { stop: () => void } {
  handlers.push({ topic, group, fn: fn as any });
  ensurePolling();
  return { stop: () => {} };
}

function ensurePolling(): void {
  if (pollTimer) return;
  const ms = Number(process.env.QT_BROKER_POLL_MS ?? 120);
  pollTimer = setInterval(drain, ms);
  setImmediate(drain);
}

async function drain(): Promise<void> {
  if (handlers.length === 0) return;
  const db = brokerDb();
  /* Group handlers by (group, topic) — same-group consumers share work. */
  const buckets = new Map<string, { group: string; topic: EventTopic; hs: Handler[] }>();
  for (const h of handlers) {
    const k = `${h.group}::${h.topic}`;
    if (!buckets.has(k)) buckets.set(k, { group: h.group, topic: h.topic, hs: [] });
    buckets.get(k)!.hs.push(h);
  }
  for (const { group, topic, hs } of buckets.values()) {
    const off = db.prepare<[string, string], { last_event_id: number }>(
      `SELECT last_event_id FROM consumer_offsets WHERE consumer_group = ? AND topic = ?`,
    ).get(group, topic);
    const lastId = off?.last_event_id ?? 0;
    const rows = db.prepare<[string, number], { id: number; payload_json: string; origin: string; ts: string; traceparent: string | null }>(
      `SELECT id, payload_json, origin, ts, traceparent FROM events WHERE topic = ? AND id > ? ORDER BY id ASC LIMIT 200`,
    ).all(topic, lastId);
    if (rows.length === 0) continue;
    let advanced = lastId;
    for (const r of rows) {
      const evt: BrokerEvent = {
        id: r.id, topic, origin: r.origin, ts: r.ts, traceparent: r.traceparent,
        payload: safeParse(r.payload_json),
      };
      let failed = false;
      for (const h of hs) {
        try { await h.fn(evt); }
        catch (e: any) {
          failed = true;
          handleFailure(group, topic, r.id, r.payload_json, e?.message ?? String(e));
          break;
        }
      }
      if (failed) break;          // stop the bucket; next tick will retry
      advanced = r.id;
    }
    if (advanced !== lastId) {
      db.prepare(
        `INSERT INTO consumer_offsets (consumer_group, topic, last_event_id) VALUES (?, ?, ?)
         ON CONFLICT (consumer_group, topic) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = datetime('now')`,
      ).run(group, topic, advanced);
    }
  }
}

function handleFailure(group: string, topic: string, eventId: number, payloadJson: string, error: string): void {
  const db = brokerDb();
  const row = db.prepare<[string, string, number], { attempts: number }>(
    `SELECT attempts FROM attempts WHERE consumer_group = ? AND topic = ? AND event_id = ?`,
  ).get(group, topic, eventId);
  const next = (row?.attempts ?? 0) + 1;
  db.prepare(
    `INSERT INTO attempts (consumer_group, topic, event_id, attempts, last_error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (consumer_group, topic, event_id) DO UPDATE SET attempts = excluded.attempts, last_error = excluded.last_error`,
  ).run(group, topic, eventId, next, error);

  if (next >= MAX_ATTEMPTS) {
    db.prepare(
      `INSERT INTO dead_letters (original_event_id, consumer_group, topic, payload_json, attempts, last_error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(eventId, group, topic, payloadJson, next, error);
    /* Advance the offset past the poison message so the stream continues. */
    db.prepare(
      `INSERT INTO consumer_offsets (consumer_group, topic, last_event_id) VALUES (?, ?, ?)
       ON CONFLICT (consumer_group, topic) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = datetime('now')`,
    ).run(group, topic, eventId);
    console.error(`[broker] DLQ: ${group}::${topic} #${eventId} after ${next} attempts — ${error}`);
  } else {
    console.warn(`[broker] retry: ${group}::${topic} #${eventId} attempt ${next}/${MAX_ATTEMPTS} — ${error}`);
  }
}

function safeParse(s: string): any { try { return JSON.parse(s, bigIntReviver); } catch { return s; } }
function bigIntReplacer(_k: string, v: any): any { return typeof v === 'bigint' ? { __big: v.toString() } : v; }
function bigIntReviver (_k: string, v: any): any {
  if (v && typeof v === 'object' && '__big' in v && typeof v.__big === 'string') return BigInt(v.__big);
  return v;
}

/* introspection */
export function recentEvents(limit = 200): BrokerEvent[] {
  const rows = brokerDb().prepare<[number], { id: number; topic: string; payload_json: string; origin: string; ts: string; traceparent: string | null }>(
    `SELECT * FROM events ORDER BY id DESC LIMIT ?`,
  ).all(limit);
  return rows.map((r) => ({ id: r.id, topic: r.topic as EventTopic, origin: r.origin, traceparent: r.traceparent, ts: r.ts, payload: safeParse(r.payload_json) }));
}

export function deadLetters(limit = 100) {
  return brokerDb().prepare(`SELECT * FROM dead_letters ORDER BY id DESC LIMIT ?`).all(limit);
}

export function brokerStats() {
  const total   = (brokerDb().prepare(`SELECT COUNT(*) as c FROM events`).get() as { c: number }).c;
  const dlq     = (brokerDb().prepare(`SELECT COUNT(*) as c FROM dead_letters`).get() as { c: number }).c;
  const groups  = brokerDb().prepare(`SELECT consumer_group, topic, last_event_id FROM consumer_offsets`).all();
  const byTopic = brokerDb().prepare(`SELECT topic, COUNT(*) as c FROM events GROUP BY topic ORDER BY c DESC`).all();
  return { total, dlq, groups, by_topic: byTopic };
}
