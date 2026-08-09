# QuestDB Storage Spike

Status: Accepted  
Verified: 2026-08-05  
Stack: QuestDB 9.4.3, Telegraf 1.39.1, Node.js 24.19, `pg` 8.22

## Decision

QuestDB is accepted as PrickleScope's initial metrics store. The acceptance is
bounded by a controller-owned schema, purpose-specific PGWire identities,
lossless counter conversion, and reset-aware rates. PostgreSQL remains the
metadata database and does not duplicate metrics.

The decision should be reopened if Grafana integration cannot query these tables
reliably, expected production cardinality is materially above the benchmarked
shape, remote ingestion requires unsupported security, or backup recovery cannot
meet the deployment's recovery objectives.

## Accepted schema

| Object                      | Kind              | Default TTL | Purpose                                 |
| --------------------------- | ----------------- | ----------: | --------------------------------------- |
| `network_system`            | Raw WAL table     |     30 days | System identity and uptime gauges       |
| `network_interface`         | Raw WAL table     |     30 days | Exact SNMP counters and interface state |
| `network_interface_rate`    | Raw WAL table     |     30 days | Reset-aware rates emitted by Telegraf   |
| `network_availability`      | Raw WAL table     |     30 days | Reachability and latency                |
| `collector_health`          | Raw WAL table     |     30 days | Collector pipeline health               |
| `network_interface_rate_5m` | Materialized view |    365 days | Normal interface history                |
| `network_availability_5m`   | Materialized view |    365 days | Normal availability history             |
| `network_interface_rate_1h` | Materialized view |   1825 days | Long-term interface history             |
| `network_availability_1h`   | Materialized view |   1825 days | Long-term availability history          |

All tables are shared measurement families. `source_id`, `check_id`, and
`if_index` provide stable query scope; human descriptions are not primary series
identity.

## Counter correctness

QuestDB ILP integers are signed 64-bit, but SNMP Counter64 is unsigned. The
proven path is:

1. Telegraf's Starlark processor observes the original Counter32/Counter64 value
   and derives a floating-point rate.
2. It discards the first sample, resets, reboots, and explicit discontinuities.
3. It treats a decrease as rollover only near the declared 32-bit or 64-bit
   boundary.
4. Telegraf's converter then writes the raw counter as a string.
5. The predeclared QuestDB column casts it into `DECIMAL(20,0)`.

The synthetic maximum `18446744073709551615` was ingested through Telegraf and
read back exactly. Live SNMPv3 polling wrote all four counter columns as
`DECIMAL(20,0)` and emitted non-zero interface rates. Unit tests cover ordinary
rates, resets, reboots, discontinuities, and both Counter32 and Counter64
rollovers.

This representation follows QuestDB's documented ILP and decimal type behavior
and avoids `LONG256`, which is not an arithmetic counter type:
[ILP column types](https://questdb.com/docs/ingestion/ilp/columnset-types/),
[QuestDB data types](https://questdb.com/docs/query/datatypes/overview/), and
[decimal arithmetic](https://questdb.com/docs/query/datatypes/decimal/).

## Retention and rollups

The controller reconciled all raw tables with daily partitioning, WAL, and a
30-day TTL. Both 5-minute views reported a 365-day TTL and both hourly views an
1825-day TTL. Live polling populated 49 interface-rate series in each rollup tier
after the second valid sample.

The GUI owns these values. Shortening any tier requires an explicit confirmation
because QuestDB expires complete partitions. The server translates the policy
into fixed DDL; no arbitrary SQL endpoint exists. See QuestDB's
[TTL](https://questdb.com/docs/concepts/ttl/) and
[materialized-view](https://questdb.com/docs/concepts/materialized-views/)
documentation.

## Adapter boundary

Only Fastify receives the QuestDB controller URL. Its pool uses a dedicated DDL
identity, a connection timeout, per-session statement timeout, maximum pool size,
bound query values, and a hard result limit. Grafana has a separate read-only
PGWire identity. The React application calls only status, retention, and
reconciliation operations and receives neither credentials nor a SQL surface.

QuestDB PGWire supports prepared bind parameters and server-side statement
timeouts through connection options; large result sets must be bounded or
streamed. QuestDB PGWire itself is not TLS-enabled, so production placement must
keep it on a trusted private network or add a transport-secure proxy. See the
[PGWire overview](https://questdb.com/docs/query/pgwire/overview/).

## Representative benchmark

The repeatable `pnpm storage:benchmark` command generated one million raw rows
across 64 interface identities on the local development machine:

| Measurement                   |           Result |
| ----------------------------- | ---------------: |
| Raw rows visible              |        1,000,000 |
| 5-minute rollup rows          |          213,385 |
| Hourly rollup rows            |           17,792 |
| WAL write accepted            |        379.12 ms |
| Raw plus both rollups visible |       2522.90 ms |
| Accepted write throughput     | 2,637,687 rows/s |
| Full raw aggregate query      |        240.70 ms |
| 5-minute aggregate query      |         54.66 ms |
| Hourly aggregate query        |         23.86 ms |

These are acceptance measurements rather than a production capacity guarantee;
hardware, cardinality, concurrent dashboard load, and storage media must be
benchmarked for a real deployment.

## Interruption and recovery

Immediately before a targeted QuestDB container recreation, Telegraf's `mem`
table had 1,856 rows. After the database became healthy under its new controller
identity, the same persisted table had 1,861 rows and a newer timestamp. Telegraf
logged the refused write during the interruption, retained the batch, resumed
without manual intervention, and continued live SNMP ingestion. No live volume
was replaced.

## OSS backup and restore

The tested Community Edition procedure is implemented in
`infra/questdb-backup.sh` and `infra/questdb-restore-test.sh`:

1. `CHECKPOINT CREATE`.
2. Copy the complete QuestDB root to external storage.
3. Always run `CHECKPOINT RELEASE`.
4. Copy the backup into a fresh isolated volume and add `_restore`.
5. Start the exact same QuestDB image with telemetry disabled for the recovery
   boot, then query the restored tables.

The isolated restored database reported 343 raw interface rows, 196 rate rows,
and populated 5-minute/hourly views. It also returned the exact full-range
Counter64 value `18446744073709551615`. The temporary 9.8 GB backup, restore
container, restore volume, and disposable benchmark tables were removed after
verification; they are not recoverable.

QuestDB documents this checkpoint/full-root-copy flow for OSS deployments; its
built-in backup command is an Enterprise feature. See
[Backup and restore](https://questdb.com/docs/operations/backup).

## Remaining integration gates

Milestone 5 must reconcile Grafana's read-only data source, prove reusable
dashboard queries, and embed panels through the authenticated gateway. Milestone
6 must prove Grafana alert evaluation. Milestone 7 would separately have validated Alloy
normalization through the relay. Those gates can reopen the decision, but they do
not invalidate the storage behaviors proven here.
