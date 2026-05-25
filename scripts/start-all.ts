/**
 * Orchestrator — spawn every backend service + the Next.js frontend
 * and tag their output by colour.  Ctrl-C stops them all cleanly.
 *
 *   npm run dev
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const RESET = '\x1b[0m';

interface ServiceDef { name: string; cmd: string; args: string[]; color: string; }

const SERVICES: ServiceDef[] = [
  { name: 'gateway',     cmd: 'tsx',  args: ['services/gateway/index.ts'],     color: '\x1b[36m' },
  { name: 'wallet',      cmd: 'tsx',  args: ['services/wallet/index.ts'],      color: '\x1b[33m' },
  { name: 'matching',    cmd: 'tsx',  args: ['services/matching/index.ts'],    color: '\x1b[35m' },
  { name: 'clearing',    cmd: 'tsx',  args: ['services/clearing/index.ts'],    color: '\x1b[34m' },
  { name: 'market-data', cmd: 'tsx',  args: ['services/market-data/index.ts'], color: '\x1b[31m' },
  { name: 'frontend',    cmd: 'next', args: ['dev', 'frontend', '-p', '5120'], color: '\x1b[95m' },
];

const procs: ChildProcess[] = [];

function pipe(name: string, color: string, stream: NodeJS.ReadableStream, isErr: boolean): void {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) {
        const out = isErr ? process.stderr : process.stdout;
        out.write(`${color}[${name.padEnd(12)}]${RESET} ${line}\n`);
      }
    }
  });
}

function start(def: ServiceDef): void {
  const child = spawn(def.cmd, def.args, {
    cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1' },
    shell: process.platform === 'win32',
  });
  procs.push(child);
  pipe(def.name, def.color, child.stdout!, false);
  pipe(def.name, def.color, child.stderr!, true);
  child.on('exit', (code) => process.stdout.write(`${def.color}[${def.name.padEnd(12)}]${RESET} exited (code ${code})\n`));
}

console.log('\n\x1b[36mQuantTrade Platform\x1b[0m — booting 5 services + frontend');
console.log('-----------------------------------------------------------\n');

SERVICES.forEach((s, i) => setTimeout(() => start(s), i * 350));

const shutdown = () => {
  console.log('\nshutting down…');
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 800);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
