/**
 * Seed — populate the platform with instruments + accounts + an
 * active order book so the UI has something to render.  Run AFTER
 * `npm run dev` is up.
 *
 *   npm run seed
 */

import { call, baseUrl } from '../lib/http';

async function waitFor(service: 'gateway' | 'wallet' | 'matching' | 'clearing' | 'market-data'): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { await call('gateway', '/health'); return; } catch { /* not yet */ }
    try { await call(service, '/health'); return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${service} did not come up at ${baseUrl(service)} within 20s`);
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

const INSTRUMENTS = [
  { symbol: 'AAPL',    base: 'AAPL', quote: 'USD', price_tick: '0.01', qty_step: '1', min_qty: '1', display_name: 'Apple Inc.' },
  { symbol: 'MSFT',    base: 'MSFT', quote: 'USD', price_tick: '0.01', qty_step: '1', min_qty: '1', display_name: 'Microsoft Corp.' },
  { symbol: 'NVDA',    base: 'NVDA', quote: 'USD', price_tick: '0.01', qty_step: '1', min_qty: '1', display_name: 'NVIDIA Corp.' },
  { symbol: 'BTC-USD', base: 'BTC',  quote: 'USD', price_tick: '0.01', qty_step: '0.00000001', min_qty: '0.00000001', display_name: 'Bitcoin' },
  { symbol: 'ETH-USD', base: 'ETH',  quote: 'USD', price_tick: '0.01', qty_step: '0.00000001', min_qty: '0.00000001', display_name: 'Ethereum' },
];

const REF_PRICES: Record<string, number> = { AAPL: 187.42, MSFT: 412.18, NVDA: 825.50, 'BTC-USD': 67500, 'ETH-USD': 3450 };

async function main(): Promise<void> {
  console.log('waiting for services…');
  await Promise.all([waitFor('gateway'), waitFor('wallet'), waitFor('matching'), waitFor('clearing'), waitFor('market-data')]);
  console.log('all services up.\n');

  /* ── 1. Instruments ────────────────────────────────── */
  console.log('[1/4] creating instruments…');
  for (const i of INSTRUMENTS) {
    try { await call('matching', '/instruments', { method: 'POST', body: JSON.stringify(i) }); }
    catch (e: any) { if (!String(e?.message).includes('UNIQUE')) console.warn(`  ! ${i.symbol}: ${e?.message}`); }
  }
  console.log(`  ✓ ${INSTRUMENTS.length} instruments`);

  /* ── 2. Accounts with opening deposits ─────────────── */
  console.log('\n[2/4] opening accounts…');
  const accounts: any[] = [];
  const profiles = [
    { display_name: 'Alice Quantitative',  email: 'alice@quanttrade.io',  deposits: [{ asset: 'USD', amount: '1000000.00' }, { asset: 'AAPL', amount: '500' }, { asset: 'BTC', amount: '2.50000000' }] },
    { display_name: 'Bob Market Maker',    email: 'bob@quanttrade.io',    deposits: [{ asset: 'USD', amount: '2500000.00' }, { asset: 'MSFT', amount: '1200' }, { asset: 'NVDA', amount: '800' }] },
    { display_name: 'Carol HFT Desk',      email: 'carol@quanttrade.io',  deposits: [{ asset: 'USD', amount: '5000000.00' }, { asset: 'BTC', amount: '15.00000000' }, { asset: 'ETH', amount: '120.00000000' }] },
    { display_name: 'Dan Retail',          email: 'dan@quanttrade.io',    deposits: [{ asset: 'USD', amount: '50000.00' }] },
  ];
  for (const p of profiles) {
    const r = await call<{ account: any }>('wallet', '/accounts', { method: 'POST', body: JSON.stringify(p) });
    accounts.push(r.account);
  }
  console.log(`  ✓ ${accounts.length} accounts with opening deposits`);

  /* ── 3. Seed a realistic two-sided book per instrument ─ */
  console.log('\n[3/4] building order books…');
  let resting = 0;
  for (const inst of INSTRUMENTS) {
    const ref = REF_PRICES[inst.symbol];
    /* Bids ladder under the reference; asks ladder above. */
    for (let i = 1; i <= 8; i++) {
      const acct = pick(accounts);
      const price = (ref * (1 - i * 0.0015)).toFixed(2);
      const qty = inst.base === 'BTC' || inst.base === 'ETH' ? (Math.random() * 0.5 + 0.1).toFixed(4) : Math.floor(Math.random() * 50 + 10).toString();
      try {
        await call('matching', '/orders', { method: 'POST', body: JSON.stringify({
          account_id: acct.id, instrument: inst.symbol, side: 'BUY', type: 'LIMIT', tif: 'GTC',
          price, qty,
        })});
        resting++;
      } catch { /* swallow — some seeds fail when fills happen */ }
    }
    for (let i = 1; i <= 8; i++) {
      const acct = pick(accounts);
      const price = (ref * (1 + i * 0.0015)).toFixed(2);
      const qty = inst.base === 'BTC' || inst.base === 'ETH' ? (Math.random() * 0.5 + 0.1).toFixed(4) : Math.floor(Math.random() * 50 + 10).toString();
      try {
        await call('matching', '/orders', { method: 'POST', body: JSON.stringify({
          account_id: acct.id, instrument: inst.symbol, side: 'SELL', type: 'LIMIT', tif: 'GTC',
          price, qty,
        })});
        resting++;
      } catch { /* swallow */ }
    }
  }
  console.log(`  ✓ ${resting} resting orders across ${INSTRUMENTS.length} books`);

  /* ── 4. Run a few sagas so the dashboards show full lifecycle ─ */
  console.log('\n[4/4] running place-order sagas…');
  let completed = 0, compensated = 0;
  for (let i = 0; i < 6; i++) {
    const inst = pick(INSTRUMENTS);
    const buyer = pick(accounts);
    const ref = REF_PRICES[inst.symbol];
    const qty = inst.base === 'BTC' || inst.base === 'ETH' ? '0.10000000' : '5';
    try {
      const r = await call<any>('clearing', '/sagas/place-order', {
        method: 'POST',
        headers: { 'Idempotency-Key': `seed-saga-${Date.now()}-${i}` },
        body: JSON.stringify({
          account_id: buyer.id, instrument: inst.symbol, side: 'BUY', type: 'LIMIT', tif: 'IOC',
          price: (ref * 1.002).toFixed(2), qty,
        }),
      });
      if (r.saga?.status === 'completed') completed++;
      else if (r.saga?.status === 'compensated') compensated++;
    } catch (e: any) { console.warn(`  ! saga ${i}: ${e?.message}`); }
  }
  /* Deliberate compensation demo. */
  try {
    await call<any>('clearing', '/sagas/place-order', {
      method: 'POST',
      headers: { 'Idempotency-Key': `seed-comp-${Date.now()}` },
      body: JSON.stringify({
        account_id: accounts[3].id, instrument: 'AAPL', side: 'BUY', type: 'LIMIT', tif: 'GTC',
        price: '187.42', qty: '5', inject_failure_step: 'process_fills',
      }),
    });
    compensated++;
  } catch { /* expected — saga returns 422 on compensation */ }
  console.log(`  ✓ ${completed} completed, ${compensated} compensated (1 planted via inject_failure_step)`);

  /* ── Summary ──────────────────────────────────────── */
  console.log('\nsummary:');
  const [w, m, c] = await Promise.all([
    call<any>('wallet',   '/stats'),
    call<any>('matching', '/stats'),
    call<any>('clearing', '/stats'),
  ]);
  console.log(`  wallet:   ${w.accounts} accounts · ${w.events} events · ${w.snapshots} snapshots`);
  console.log(`  matching: ${m.orders} orders · ${m.fills} fills · ${m.books?.length ?? 0} active books`);
  console.log(`  clearing: ${c.sagas} sagas · ${c.settlements} settlements`);
  console.log('\nopen http://localhost:5120/terminal');
}

main().catch((e) => { console.error('seed failed:', e); process.exit(1); });
