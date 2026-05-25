# QuantTrade Platform

High-throughput trading infrastructure built around the three concerns that decide whether a real venue lives or dies: **event-sourced money**, **distributed transactions that don't leak**, and **idempotent everything** so retries never double-spend. Five microservices behind an asymmetric-JWT gateway, with circuit breakers, dead-letter queues and W3C trace context threaded end to end.

The goal isn't to be a sandbox demo. The goal is to prove — with a 19-step smoke test — that the contracts hold under the failure modes that get senior engineers fired.

---

## What lives inside

```
                ┌───────────────────────────────────┐
                │      Operator Terminal (Next.js)  │
                │   Order book · Tape · Sagas · …   │
                └──────────────────┬────────────────┘
                                   │  /api/<service>/...
                                   ▼
            ┌──────────────────────────────────────────┐
            │ API Gateway (ED25519 JWT inline · 5121) │
            │ idempotency dedup · token bucket · trace │
            └──────────┬───────────┬────────┬──────────┘
                       │           │        │
        ┌──────────────┘           │        └──────────────┐
        ▼                          ▼                       ▼
┌───────────────┐         ┌─────────────────┐     ┌───────────────────┐
│   Wallet      │         │ Matching Engine │     │  Clearing /        │
│   5122        │         │      5123        │     │  Saga Orchestrator│
│ event-sourced │         │ in-memory book   │     │  5124              │
│  + snapshots  │         │ price-time pri.  │     │ place_order saga   │
└───────┬───────┘         └────────┬─────────┘     └─────────┬─────────┘
        │                          │                         │
        └──────────────┬───────────┴─────────────────────────┘
                       ▼
        ┌──────────────────────────────────┐         ┌──────────────────┐
        │ Event Bus (Kafka-shape, broker.db│◀───────▶│  Market Data 5125│
        │ DLQ after 5 failures · offsets   │         │  ticks · OHLC    │
        │ traceparent threaded             │         │  SSE stream      │
        └──────────────────────────────────┘         └──────────────────┘
```

Six components run in their own processes. Each one owns its own SQLite database. Inter-service traffic goes over HTTP carrying a `traceparent` header so the asynchronous chain joins one Jaeger trace. State changes are events on the broker; consumers register with a `consumer_group` and the broker tracks per-(group, topic) offsets exactly like Kafka.

---

## The three hardcore parts

### 1. Distributed ACID via Orchestrator-Based Saga

`POST /sagas/place-order` runs four steps with one compensation each:

| Step             | Forward                                  | Compensation                       |
|------------------|------------------------------------------|------------------------------------|
| 1 reserve_funds  | `wallet.hold(account, amount)`           | `wallet.release(...)`              |
| 2 submit_order   | `matching.placeOrder(...)`               | `matching.cancel(orderId)`         |
| 3 process_fills  | per-fill debit/credit on both sides       | mirror credit/debit on both sides  |
| 4 settle         | record `trade_settlement` + release excess | mark settlement reversed           |

If step N throws, compensations run in reverse for steps 1..N-1. Every state transition is persisted **before** the body runs, so a `kill -9` mid-step leaves an `in_progress` row that `recoverInFlight(db)` picks up on boot. This is the Temporal.io contract — durable state machine with compensation — implemented in 200 lines of TypeScript in `lib/saga.ts`.

The platform deliberately ships an `inject_failure_step` hook on the saga input so the smoke test can prove the compensation chain works without disabling anything in production code:

```bash
curl -X POST .../sagas/place-order -H "Idempotency-Key: …" -d '{
  "account_id": "...", "instrument": "AAPL", "side": "BUY",
  "type": "LIMIT", "price": "180.00", "qty": "5",
  "inject_failure_step": "process_fills"
}'
# → status=compensated, hold released, order cancelled
```

### 2. Event Sourcing + Snapshot Recovery

Every balance change is an event in `wallet_events`, append-only with triggers. The balance projection lives in `balances` as a materialised cache. The interesting part is **cold recovery**:

```
              snapshot (Cassandra in prod, sqlite here)
              up_to_seq=2_500_000
                       │
                       ▼
events: ───────────────●─────●─●─●─────●─────●●─────────────
          0    seq=1M  2.5M (last 17 events to replay)
```

Without snapshots, recovering an account from seq 0 means replaying every event ever. With `QT_SNAPSHOT_EVERY=500` events, recovery is bounded: load latest snapshot, replay only events since. The dashboard exposes a one-button **Rebuild from event log** on every account so you can prove identical state every time.

Proof in `scripts/smoke.ts`:
```
✓ append 50 events to drive cache projection
✓ after 50 × $1 deposits balance is $10,050.00
✓ rebuild from event log produces identical state
✓ balance still $10,050.00 after rebuild
```

### 3. Idempotency + Distributed Lock

Two layers protect against double-spend:

**Idempotency-Key (X-Idempotency-Key header).** First request wins via UNIQUE constraint in `idempotency_keys`. Concurrent duplicates spin-wait for the in-flight worker to settle and receive the same cached response. Same key + different payload → 409. `lib/idempotency.ts` (~80 lines).

**Distributed Lock per (account, asset).** `lib/distributed-lock.ts` exposes a Redlock-shape contract — `await withLock(key, async () => { … })`. Implementation is SQLite-backed with a TTL expiry so a crashed holder doesn't deadlock the key forever. The wallet's `appendEvent` always runs inside the lock so two concurrent writers cannot both read `MAX(seq)`, both pass validation, and both insert at the same seq:

```ts
return withLock(`wallet:${account}:${asset}`, async () => {
  const next = computeNextSeq();
  validate(input, currentState);   // read-modify-write atomic per key
  insertEvent(...);
  publishToBroker(...);
});
```

Smoke proof:
```
✓ two concurrent over-holds: exactly one succeeds, one is rejected
```

---

## Service map

| Service       | Port | Owns                                                                                  |
|---------------|------|---------------------------------------------------------------------------------------|
| Gateway       | 5121 | ED25519 JWT verification inline, idempotency dedup, token-bucket rate limit, routing  |
| Wallet        | 5122 | Event-sourced balances, snapshots, distributed lock, hold/release/debit/credit         |
| Matching      | 5123 | In-memory price-time priority order book, fills, crash-replay from disk               |
| Clearing      | 5124 | `place_order` saga with compensations, settlements, broker introspection              |
| Market Data   | 5125 | Ticks aggregation, 1m candles, SSE stream for live UI                                  |
| Frontend      | 5120 | SSR operator console (Next.js 15) + `/api/*` gateway proxy                            |

---

## Quickstart

```bash
# 1. Install
npm install
cp .env.example .env.local
# (the JWT keypair auto-generates on first boot if you leave QT_JWT_* blank)

# 2. Run all five services + the operator console
npm run dev

# 3. Populate realistic demo data (multi-instrument order books + sagas)
npm run seed

# 4. Verify everything end-to-end
npm run smoke

# 5. Open the terminal
#    http://localhost:5120/terminal
```

Or run each service in its own shell:
```bash
npm run dev:gateway       # 5121
npm run dev:wallet        # 5122
npm run dev:matching      # 5123
npm run dev:clearing      # 5124
npm run dev:market-data   # 5125
npm run dev:frontend      # 5120
```

---

## Observability

- **W3C Trace Context.** Every inbound request gets a fresh span under whatever trace-id arrived; the same `traceparent` is forwarded to upstream HTTP calls AND attached to broker events. Jaeger sees the whole async chain even when a payment ripples through wallet → matching → clearing → market-data.
- **Prometheus metrics.** Every service exposes `/metrics` (text exposition) and `/metrics.json` (parsed). Histograms with sub-millisecond buckets capture matching latency at the tail.
- **Circuit breakers.** `lib/circuit-breaker.ts` — three-state machine (`closed` → `open` → `half_open`). Tripping a breaker on `wallet` prevents `clearing` from cascading-failing when wallet is sick. Visible per-service in `/services` page.
- **Dead-letter queue.** `lib/broker.ts` keeps a `dead_letters` table. After 5 failed attempts a message moves out of the live stream so the bus doesn't deadlock on poison messages.

---

## SLA targets the design is built around

| Concern         | Target                                                                                       |
|-----------------|----------------------------------------------------------------------------------------------|
| Throughput      | 100k+ orders/sec in the matching engine (in-memory order book, no per-call disk write blocks)|
| Latency P99     | <5ms end-to-end excluding network, <500μs inside the matching engine itself                   |
| Availability    | 99.999% (5 services × independent replicas in real deployment + circuit breakers per edge)   |
| Consistency     | Strong inside the saga (per-step commit + compensation); eventual on read-only projections    |
| RTO             | <1 minute via snapshots + event replay                                                       |
| Audit           | Append-only event log + immutable saga steps + broker event tail                              |

---

## Project layout

```
quanttrade-platform/
├── lib/                          # Shared infrastructure
│   ├── decimal.ts                #   BigInt fixed-point money + qty math
│   ├── types.ts                  #   Domain vocabulary
│   ├── db.ts                     #   Per-service SQLite factory (WAL + FK)
│   ├── broker.ts                 #   Kafka-shape pub/sub on SQLite + DLQ
│   ├── snapshot.ts               #   Event-sourcing snapshot helper
│   ├── saga.ts                   #   Orchestrator framework + compensations
│   ├── idempotency.ts            #   Race-safe withIdempotency wrapper
│   ├── distributed-lock.ts       #   Redlock-shape lock with SQLite + TTL
│   ├── circuit-breaker.ts        #   Three-state breaker registry
│   ├── http.ts                   #   Service-to-service client with breaker
│   ├── trace.ts                  #   W3C traceparent context
│   ├── metrics.ts                #   Prometheus counters + histograms
│   ├── jwt.ts                    #   ED25519 JWT sign/verify (asymmetric)
│   └── service-base.ts           #   Express bootstrap, trace middleware
├── services/
│   ├── gateway/                  # 5121  inline-JWT verify + idempotency + routing
│   ├── wallet/                   # 5122  event-sourced + snapshots + lock
│   ├── matching/                 # 5123  in-memory order book + replay
│   ├── clearing/                 # 5124  saga orchestrator with compensations
│   └── market-data/              # 5125  tick aggregator + SSE stream
├── frontend/                     # Next.js 15 SSR — Trading Floor aesthetic
├── scripts/
│   ├── start-all.ts              # spawns 5 services + frontend, colour-tagged
│   ├── seed.ts                   # multi-instrument books + sagas
│   └── smoke.ts                  # 19-step end-to-end assertion suite
└── data/                         # SQLite files (git-ignored)
```

---

## Tech stack

- **Runtime:** Node.js, TypeScript strict
- **Web:** Express on the backend, Next.js 15 (App Router) on the frontend, React 19
- **Storage:** SQLite per service (WAL + FK + busy_timeout) — drop-in for Postgres
- **Broker:** SQLite event log with consumer offsets — drop-in for Kafka / Pulsar
- **Lock:** SQLite advisory rows — drop-in for Redlock / etcd
- **Crypto:** node:crypto (ED25519, `timingSafeEqual`)
- **Theme:** Trading Floor — pure black, JetBrains Mono, neon green buy / red sell / cyan accent

---

## What's intentionally not here

- Actual Kafka, Cassandra, Redis or Istio — the shared library contracts are designed so each can be swapped without changing consumer code
- Real exchange connectivity (FIX 4.4 / 5.0, BO-FIX) — the matching engine is local
- Position margin, T+1 settlement window, regulatory reporting — out of demo scope
- A full KYC / AML / sanctions integration on the wallet — same

Plenty of room to grow; the foundations underneath are honest.

See `ARCHITECTURAL_SPEC.md` for the original design document this implementation maps to.

---

Crafted in the Trading Floor aesthetic.
