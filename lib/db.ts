/** Per-service SQLite factory (WAL + FK + busy-timeout). */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const cache = new Map<string, Database.Database>();

export function openDb(serviceName: string): Database.Database {
  if (cache.has(serviceName)) return cache.get(serviceName)!;
  const file = resolve(process.cwd(), 'data', `${serviceName}.db`);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('busy_timeout = 5000');
  cache.set(serviceName, conn);
  return conn;
}

export function uuid(): string { return randomUUID(); }

export function publicId(prefix: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${prefix}-${out}`;
}

export function loadEnvLocal(): void {
  const p = resolve(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
