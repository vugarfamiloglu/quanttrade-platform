# Architectural Specification: QuantTrade Platform

This document describes the platform's missions, SLAs and the engineering challenges it was built to solve. The code in this repository implements every concept below — the storage choices are local-demo-grade (SQLite simulating Postgres + Kafka + Cassandra + Redis) but the contracts are identical to a production swap.

## 1. Mission and Non-Functional Requirements

The platform is designed to process hundreds of thousands of trading operations per second on global financial markets. Every technical decision must satisfy the following metrics:

* **Throughput:** minimum **100,000 TPS** (transactions per second).
* **Latency:** P99 (99th percentile) **< 5 ms** end-to-end; inside the Order Matching path **< 500 μs**.
* **Availability:** **99.999%** (five 9s). Maximum 5 minutes downtime per year.
* **Data Consistency:** *eventual consistency* is acceptable for read projections; balance and clearing operations require **strong consistency**.

## 2. Service Architecture and Technology Commitments

The system is **polyglot** (multiple languages in production: Java for wallet, Rust/Go for matching, etc.) and **polyglot persistence** (PostgreSQL, RocksDB, Cassandra). In this repository the runtime is unified TypeScript and the storage is SQLite, but every contract is designed to be swapped:

```
                  +-------------------+
                  |   API Gateway     |   KrakenD / Kong in prod
                  +---------+---------+   (TypeScript + Express here)
                            |
            +---------------+---------------+
            | (gRPC in prod, HTTP+JSON here)|
            v                               v
  +-------------------+           +-------------------+
  |  Wallet Service   |           |  Matching Engine  |
  |  Java/.NET (prod) |           |   Rust/Go (prod)  |
  +---------+---------+           +---------+---------+
            |                               |
            +---------------+---------------+
                            |
                            v (Kafka in prod, broker.db here)
                  +-------------------+
                  | Clearing Service  |   Saga Orchestrator
                  +-------------------+   (Temporal.io in prod)
```

### A. API Gateway

**Responsibilities:** client request entry, JWT-based authentication, mTLS verification, dynamic routing, rate limiting.

**Challenge:** at 100k RPS the gateway must not become a bottleneck. Token verification cannot round-trip to a central database — tokens are verified inline using **asymmetric cryptography (RSA / ED25519)** with the public key cached in memory.

### B. Order Matching Engine

**Responsibilities:** match buy and sell orders by price-time priority.

**Storage:** in-memory data structures (B-tree, red-black tree, or skip list) + RocksDB for ultra-fast local disk writes.

**Challenge:** GC pauses are unacceptable. Rust gives direct memory management; Go requires careful GC optimisation. Pre-allocated structures and no per-call allocation in the hot path.

### C. Wallet & Account Service

**Responsibilities:** user balances, deposits, withdrawals.

**Storage:** PostgreSQL (strict relational model for financial reporting).

**Challenge:** race conditions when two operations simultaneously modify the same account.

## 3. Hardcore Problems and Solutions

### Problem 1: Distributed ACID Transactions (Saga Pattern)

When a user buys a share, the sequence is:

1. `Wallet Service` holds the cash on the account.
2. `Matching Engine` executes the order and transfers the share to the counterparty.
3. `Clearing Service` calculates commission and confirms the final balance.

**Edge case:** the third step fails because of a network outage. The user's funds cannot remain frozen indefinitely.

**Solution: Orchestrator-Based Saga Pattern.** Either **Temporal.io** or a custom orchestrator tracks every step. On failure, compensating transactions undo prior steps in reverse: *release the held funds, send "Rolled Back" to the matching engine.*

### Problem 2: Event Sourcing + Zero Data Loss

Deletes and direct updates are forbidden. Everything is an event.

* When the balance changes we don't write `balance = balance + 100`. We append a `MoneyDeposited` event to Kafka.
* **State reconstruction (replayability):** if the Wallet database is wiped, the service rebuilds balances from scratch by reading the entire event stream.

**Edge case:** millions of events in Kafka. Replaying one by one takes hours and destroys the RTO budget.

**Solution: snapshotting.** Every 10,000 messages (configurable via `QT_SNAPSHOT_EVERY`) the current balance is snapshotted to a NoSQL store (Cassandra / ScyllaDB in production). On recovery the service loads the latest snapshot and only replays events newer than the snapshot.

### Problem 3: Distributed Race Conditions

A user sends two identical purchase requests in the same second (deliberately or because of network latency).

**Edge case:** both requests reach different Wallet pods (Kubernetes replicas) simultaneously. Both pods check the balance, see sufficient funds, and both deduct — **double spend**.

**Solution:**
1. **Idempotency Key.** Every request carries an `X-Idempotency-Key` (UUID v4). Replays with the same key are blocked without re-execution (cached in Redis).
2. **Distributed Lock (Redlock algorithm).** A `Redis`-based per-user lock serialises balance modifications across pods. One pod must finish before another can touch the same user's balance.

## 4. Resilience Engineering

The system follows Chaos Engineering principles:

* **Circuit Breaker (Istio Service Mesh in prod).** If `Notification Service` slows down and stops responding, `Wallet Service` stops calling it (trips the circuit). Otherwise Wallet's thread pool fills up and Wallet itself collapses (cascading failure).
* **Dead-Letter Queue (DLQ).** Kafka messages that cannot be processed (malformed payloads) must not infinite-loop. They are automatically routed to `order-matching-dlq` and trigger an alert.

## 5. Observability Requirements

* **W3C Trace Context.** Every request acquires a `traceparent` header at the Gateway. The header travels with Kafka messages so **Jaeger** can render the whole asynchronous chain.
* **Prometheus Custom Metrics.** Per-service custom metrics, e.g. `order_matching_duration_seconds` (histogram). Visible in real time on Grafana.

---

## How this repository implements the spec

The implementation in this repository is single-host TypeScript with SQLite-backed substitutes for the heavy infrastructure. Every contract was preserved so the swap to the production technologies is a drop-in replacement of one module at a time:

| Spec component | Production tech | This repository |
|---|---|---|
| API Gateway | KrakenD / Kong | Express in `services/gateway/index.ts` |
| Wallet | Java + PostgreSQL | `services/wallet/index.ts` + SQLite |
| Matching Engine | Rust + RocksDB | `services/matching/index.ts` + in-memory + SQLite |
| Clearing Saga | Temporal.io | `lib/saga.ts` + `services/clearing/index.ts` |
| Event Bus | Apache Kafka | `lib/broker.ts` + `data/broker.db` |
| Snapshot store | Cassandra / ScyllaDB | `lib/snapshot.ts` + `snapshots` table |
| Distributed Lock | Redis Redlock | `lib/distributed-lock.ts` + `data/locks.db` |
| Circuit Breaker | Istio Service Mesh | `lib/circuit-breaker.ts` (per-process) |
| DLQ | Kafka topic | `dead_letters` table in `broker.db` |
| Tracing | Jaeger | `lib/trace.ts` (W3C traceparent header) |
| Metrics | Prometheus | `lib/metrics.ts` (`/metrics` exposition) |
| Auth | ED25519 JWT | `lib/jwt.ts` (Node `node:crypto`) |

Every smoke check in `scripts/smoke.ts` exercises one of these mechanisms end-to-end. **19/19** pass on a clean boot.
