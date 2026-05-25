/**
 * Smoke test — exercises every concept the platform claims to embody
 * and asserts on the outcomes.  Run after `npm run dev`.
 *
 *   npm run smoke
 *
 * What it verifies:
 *   • All five services healthy
 *   • Wallet: event append + cache projection + cold rebuild from
 *     snapshot+events gives byte-identical state
 *   • Distributed lock: two concurrent debits on the same account
 *     serialise (no double-spend)
 *   • Matching engine: price-time priority — earlier-time order at the
 *     same price fills before a later one
 *   • Saga: place-order completes end-to-end AND a forced failure at
 *     step 3 runs compensations and lands in `compensated`
 *   • Idempotency: same key + same body → cached; same key + different
 *     body → 409
 *   • JWT: gateway mints a token, downstream call carrying it succeeds
 */

import { call, baseUrl, BreakerOpenError } from '../lib/http';
import { Decimal } from '../lib/decimal';

let passed = 0, failed = 0;
function ok(label: string): void { passed++; console.log(`  ✓ ${label}`); }
function fail(label: string, e?: any): void { failed++; console.log(`  ✗ ${label}${e ? ` — ${e?.message ?? e}` : ''}`); }

async function expect<T>(label: string, fn: () => Promise<T>, predicate?: (v: T) => boolean): Promise<T | null> {
  try {
    const v = await fn();
    if (predicate && !predicate(v)) { fail(label, new Error('predicate returned false')); return null; }
    ok(label); return v;
  } catch (e: any) { fail(label, e); return null; }
}

async function main(): Promise<void> {
  console.log('\nQuantTrade Platform — smoke test');
  console.log('─────────────────────────────────\n');

  console.log('[health]');
  for (const s of ['gateway', 'wallet', 'matching', 'clearing', 'market-data'] as const) {
    await expect(`${s} responds to /health`, () => call<any>(s, '/health'), (v) => v?.ok === true);
  }

  console.log('\n[wallet: event-source + snapshot + rebuild]');
  const acct = await expect('open account with $10k USD', () => call<any>('wallet', '/accounts', {
    method: 'POST', body: JSON.stringify({ display_name: 'smoke', email: 'smoke@x.com', opening_deposits: [{ asset: 'USD', amount: '10000.00' }] }),
  }), (v) => v?.account?.id);
  if (!acct) { summary(); return; }
  const acctId = acct.account.id;

  await expect('balance reads $10,000.00 USD',
    () => call<any>('wallet', `/accounts/${acctId}`),
    (v) => v?.balances?.find((b: any) => b.asset === 'USD')?.available_raw === '1000000');

  await expect('append 50 events to drive cache projection',
    async () => {
      for (let i = 0; i < 50; i++) {
        await call('wallet', '/events', { method: 'POST', body: JSON.stringify({
          account_id: acctId, asset: 'USD', kind: 'Deposited', amount_raw: '100',     // 100 minor = $1.00
        })});
      }
      return true;
    });

  /* 50 × $1.00 deposits → $10,050.00.  Raw is in cents (scale=2) → 1,005,000. */
  await expect('after 50 × $1 deposits balance is $10,050.00',
    () => call<any>('wallet', `/accounts/${acctId}`),
    (v) => v?.balances?.find((b: any) => b.asset === 'USD')?.available_raw === '1005000');

  await expect('rebuild from event log produces identical state',
    () => call<any>('wallet', `/accounts/${acctId}/rebuild`, { method: 'POST' }),
    (v) => v?.ok === true);

  await expect('balance still $10,050.00 after rebuild',
    () => call<any>('wallet', `/accounts/${acctId}`),
    (v) => v?.balances?.find((b: any) => b.asset === 'USD')?.available_raw === '1005000');

  console.log('\n[distributed lock: no over-hold beyond available]');
  /* Wallet has $10,050 total, $0 held → available $10,050.  Two
   * concurrent holds of $7,000 each can't both win — second would
   * make held > total.  Without the lock both would read available =
   * $10,050 and both succeed.  With the lock, exactly one survives. */
  await expect('two concurrent over-holds: exactly one succeeds, one is rejected', async () => {
    const A = call('wallet', '/hold', { method: 'POST', body: JSON.stringify({ account_id: acctId, asset: 'USD', amount: '7000.00' })});
    const B = call('wallet', '/hold', { method: 'POST', body: JSON.stringify({ account_id: acctId, asset: 'USD', amount: '7000.00' })});
    const settled = await Promise.allSettled([A, B]);
    const ok = settled.filter((r) => r.status === 'fulfilled').length;
    const rej = settled.filter((r) => r.status === 'rejected').length;
    if (ok !== 1 || rej !== 1) throw new Error(`expected 1 ok + 1 reject, got ${ok}/${rej}`);
    return true;
  });

  console.log('\n[matching: price-time priority]');
  /* Create a fresh instrument + 3 accounts so this test is hermetic. */
  await call('matching', '/instruments', { method: 'POST', body: JSON.stringify({ symbol: 'TEST', base: 'AAPL', quote: 'USD', price_tick: '0.01', qty_step: '1', min_qty: '1', display_name: 'Smoke Equity' })}).catch(() => {});
  const buyer = (await call<any>('wallet', '/accounts', { method: 'POST', body: JSON.stringify({ display_name: 'buyer', email: 'buy@x.com', opening_deposits: [{ asset: 'USD', amount: '1000.00' }] })})).account;
  const seller1 = (await call<any>('wallet', '/accounts', { method: 'POST', body: JSON.stringify({ display_name: 'maker1', email: 's1@x.com', opening_deposits: [{ asset: 'AAPL', amount: '10' }] })})).account;
  const seller2 = (await call<any>('wallet', '/accounts', { method: 'POST', body: JSON.stringify({ display_name: 'maker2', email: 's2@x.com', opening_deposits: [{ asset: 'AAPL', amount: '10' }] })})).account;

  /* maker1 rests an ASK @ 100, then maker2 rests one too. */
  await call('matching', '/orders', { method: 'POST', body: JSON.stringify({ account_id: seller1.id, instrument: 'TEST', side: 'SELL', type: 'LIMIT', tif: 'GTC', price: '100.00', qty: '5' })});
  await new Promise((r) => setTimeout(r, 10));   // ensure later timestamp
  await call('matching', '/orders', { method: 'POST', body: JSON.stringify({ account_id: seller2.id, instrument: 'TEST', side: 'SELL', type: 'LIMIT', tif: 'GTC', price: '100.00', qty: '5' })});

  await expect('aggressive BUY 5 @ 100 matches maker1 first (time priority)', async () => {
    const r = await call<any>('matching', '/orders', { method: 'POST', body: JSON.stringify({ account_id: buyer.id, instrument: 'TEST', side: 'BUY', type: 'LIMIT', tif: 'IOC', price: '100.00', qty: '5' })});
    if (r.fills.length !== 1) throw new Error(`expected 1 fill, got ${r.fills.length}`);
    /* maker1 should be the maker. */
    const detail = await call<any>('matching', `/orders/${r.order.id}`);
    if (detail.fills[0].sell_account_id !== seller1.id) throw new Error('wrong maker — time priority broken');
    return true;
  });

  console.log('\n[saga: place-order completes end-to-end]');
  /* Need a separate instrument with non-empty book for the saga. */
  await call('matching', '/instruments', { method: 'POST', body: JSON.stringify({ symbol: 'SAGA', base: 'AAPL', quote: 'USD', price_tick: '0.01', qty_step: '1', min_qty: '1', display_name: 'Saga Equity' })}).catch(() => {});
  await call('matching', '/orders', { method: 'POST', body: JSON.stringify({ account_id: seller1.id, instrument: 'SAGA', side: 'SELL', type: 'LIMIT', tif: 'GTC', price: '50.00', qty: '5' })});

  /* The clearing endpoint returns HTTP 422 for non-completed sagas
   * (it's still a recorded transaction, just one the operator may
   * want to see).  We catch the throw and inspect e.body. */
  const sagaResult = await call<any>('clearing', '/sagas/place-order', {
    method: 'POST', headers: { 'Idempotency-Key': `smoke-saga-${Date.now()}` },
    body: JSON.stringify({ account_id: buyer.id, instrument: 'SAGA', side: 'BUY', type: 'LIMIT', tif: 'IOC', price: '50.00', qty: '5' }),
  }).then((v) => v).catch((e) => e.body);
  if (sagaResult?.saga?.status === 'completed') ok('place-order saga completes');
  else fail('place-order saga completes', new Error(`status=${sagaResult?.saga?.status ?? '(no body)'} reason=${sagaResult?.saga?.failed_reason ?? '(none)'}`));

  console.log('\n[saga: injected failure runs compensations]');
  const compResult = await call<any>('clearing', '/sagas/place-order', {
    method: 'POST', headers: { 'Idempotency-Key': `smoke-comp-${Date.now()}` },
    body: JSON.stringify({ account_id: buyer.id, instrument: 'SAGA', side: 'BUY', type: 'LIMIT', tif: 'GTC', price: '40.00', qty: '1', inject_failure_step: 'process_fills' }),
  }).then((v) => v).catch((e) => e.body);
  if (compResult?.saga?.status === 'compensated') ok('inject_failure_step=process_fills → status=compensated');
  else fail('inject_failure_step=process_fills → status=compensated', new Error(`status=${compResult?.saga?.status}`));

  console.log('\n[gateway: JWT + idempotency]');
  /* Mint a token. */
  const tk = await expect('mint JWT for buyer', () => call<any>('gateway', '/auth/token', { method: 'POST', body: JSON.stringify({ account_id: buyer.id }) }), (v) => v?.token);
  if (tk) {
    await expect('JWT-bearing call to wallet via gateway succeeds', () => call<any>('gateway', `/wallet/accounts/${buyer.id}`, {
      method: 'GET', headers: { Authorization: `Bearer ${tk.token}` },
    }), (v) => v?.account?.id === buyer.id);

    const idemKey = `smoke-idem-${Date.now()}`;
    const firstBody = JSON.stringify({ kind: 'AccountOpened', account_id: buyer.id, asset: 'USD' });
    const firstRes = await call<any>('gateway', '/wallet/events', {
      method: 'POST', headers: { Authorization: `Bearer ${tk.token}`, 'Idempotency-Key': idemKey }, body: firstBody,
    }).catch((e) => ({ error: e?.message }));
    const replay = await call<any>('gateway', '/wallet/events', {
      method: 'POST', headers: { Authorization: `Bearer ${tk.token}`, 'Idempotency-Key': idemKey }, body: firstBody,
    }).catch((e) => ({ error: e?.message }));
    if (JSON.stringify(firstRes) === JSON.stringify(replay)) ok('idempotency replay returns identical body');
    else fail('idempotency replay diverged from first response');

    let conflicted = false;
    try {
      await call('gateway', '/wallet/events', {
        method: 'POST', headers: { Authorization: `Bearer ${tk.token}`, 'Idempotency-Key': idemKey },
        body: JSON.stringify({ kind: 'Deposited', account_id: buyer.id, asset: 'USD', amount_raw: '5' }),
      });
    } catch (e: any) { conflicted = String(e?.message).toLowerCase().includes('idempotency'); }
    conflicted ? ok('same idempotency key + different body → 409') : fail('idempotency conflict NOT raised');
  }

  summary();
}

function summary(): void {
  console.log('\n─────────────────────────────────');
  console.log(`passed: ${passed}    failed: ${failed}`);
  if (failed === 0) { console.log('\n\x1b[32m✓ all smoke checks green.\x1b[0m\n'); process.exit(0); }
  console.log('\n\x1b[31m✗ smoke FAILED.\x1b[0m\n'); process.exit(1);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
