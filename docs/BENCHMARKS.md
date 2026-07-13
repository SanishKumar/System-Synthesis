# Benchmarks

This report contains measured results, exact commands, environment details, and scope. It does not extrapolate local in-memory results into a production capacity claim.

## 1. Seeded CRDT convergence harness

Command:

```bash
npm run test:convergence
```

Run on 2026-07-13:

| Metric | Result |
| --- | ---: |
| Logical clients | 10 |
| Requested randomized operations | 1,000 |
| Generated Yjs updates | 878 |
| Duplicate deliveries injected | 1,158 |
| Delayed deliveries injected | 4,384 |
| Logical backend documents | 2 |
| Simulated backend restart | 1, halfway through |
| Canonical client/server hashes | Identical |
| Converged | Yes |
| Duration | 14,650 ms |

Operations include node add, move, rename, configuration change, connection add/delete, node delete, and user-local undo. Every participant receives updates in a different order; temporary non-delivery is reconciled later, duplicate updates are injected, and one logical backend document is reconstructed from persisted updates.

This is a deterministic in-process property harness. It proves the tested CRDT model converged for this seed; it does not measure network throughput, PostgreSQL latency, Redis capacity, or browser rendering.

Reproduce a different scale or seed:

```bash
CONVERGENCE_CLIENTS=50 CONVERGENCE_OPERATIONS=10000 CONVERGENCE_SEED=42 npm run test:convergence
```

PowerShell:

```powershell
$env:CONVERGENCE_CLIENTS=50
$env:CONVERGENCE_OPERATIONS=10000
$env:CONVERGENCE_SEED=42
npm run test:convergence
```

## 2. Live Socket.IO propagation

The custom benchmark creates an authenticated private board, joins multiple Socket.IO sessions using the owner JWT, sends real granular architecture-node Yjs updates, records every expected fan-out delivery, reconnects a new session, compares graph hashes, and deletes the temporary board.

Command, with a built/running server:

```bash
BENCHMARK_CLIENTS=10 BENCHMARK_UPDATES=50 BENCHMARK_INTERVAL_MS=20 \
BENCHMARK_STORAGE_MODE="in-memory (no Redis/PostgreSQL)" \
npm run benchmark:socket
```

Measured run on 2026-07-13:

| Metric | Result |
| --- | ---: |
| Connected sessions | 10 |
| Architecture-node updates | 50 |
| Update interval | 20 ms |
| Expected fan-out deliveries | 450 |
| Received deliveries | 450 |
| Dropped deliveries | 0 |
| Final client/server graph hashes | Identical |
| p50 propagation | 3.24 ms |
| p95 propagation | 4.83 ms |
| p99 propagation | 7.58 ms |
| Reconnect-to-full-state | 5.13 ms |
| Socket rejection events | 0 |

Environment:

| Item | Value |
| --- | --- |
| Node.js | v24.18.0 |
| OS | Windows 10.0.26200 x64 |
| CPU | AMD Ryzen 5 7535HS with Radeon Graphics |
| Logical CPUs | 12 |
| Memory | 15.19 GiB |
| Storage mode | In-memory; no Redis or PostgreSQL |
| Client/server network | Local loopback |

Interpretation: this run validates the benchmark path, message fan-out, reconnect state, and local latency at a small scale. It is not a production or multi-host result. PostgreSQL/Redis latency, TLS, reverse proxies, geographic distance, noisy neighbors, browser rendering, server CPU, and memory growth were not measured.

## Required future benchmark matrix

Before claiming a production capacity or résumé number beyond the measurements above, run and publish:

- PostgreSQL + Redis on documented versions and hardware
- Two real backend processes behind a load balancer
- 10, 50, and 100 authenticated clients
- Backend restart, Redis interruption, and PostgreSQL fail-closed scenarios
- CPU, resident memory, Redis operation rate, PostgreSQL write latency, snapshot size, and restore duration
- Multiple runs with confidence intervals, not one best run

The scripts intentionally exit non-zero on convergence failure or dropped live deliveries.
