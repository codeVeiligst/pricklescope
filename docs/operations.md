# Operations

Running PrickleScope once it is deployed: how big a host it needs, what to watch,
and what to do on a normal day.

## Supported deployment size

PrickleScope is a **single-host** product. Every container runs on one machine,
PostgreSQL and QuestDB are not clustered, and there is no horizontal scaling
story. That is a deliberate scope, not an oversight — it suits the installations
this is built for, and it keeps the operational surface small enough to reason
about.

| Size       | Sources | Interfaces per source | vCPU | RAM   | Disk            |
| ---------- | ------: | --------------------: | ---: | ----- | --------------- |
| Evaluation |     ≤10 |                   ≤24 |    2 | 4 GB  | 20 GB           |
| Small      |    ≤100 |                   ≤48 |    4 | 8 GB  | 100 GB + growth |
| Medium     |    ≤500 |                   ≤48 |    8 | 16 GB | 500 GB + growth |

Beyond roughly 500 sources at a one-minute interval, nothing is known — it has not
been tested, and the honest answer is to measure rather than to extrapolate from
this table.

### Where those numbers come from

The baseline is measured. On an idle development stack with two sources, the four
infrastructure containers sit at:

| Container  | Memory | CPU  |
| ---------- | ------ | ---- |
| QuestDB    | 579 MB | 17%  |
| Grafana    | 413 MB | 2%   |
| Telegraf   | 163 MB | 1%   |
| PostgreSQL | 47 MB  | 0.1% |

Add roughly 150 MB for the API and 20 MB for the gateway. So about **1.4 GB of
resident memory before a single production source is added**, which is why 4 GB is
the floor rather than 2.

QuestDB is the component that grows. It is also the one already doing most of the
CPU work at two sources, because ingestion and the materialized-view refresh both
land there.

### Estimating your own storage

The row rate follows directly from the polling model. Per source, per poll:

- 1 availability row
- 1 system row
- 1 interface row **per interface**, plus 1 derived rate row per interface

At a 60-second interval, a 24-port switch produces about `2 + 48 = 50` rows a
minute, or **72,000 rows a day**. A hundred of them is 7.2 million rows a day.

The rollups compress that sharply. The storage spike measured 1,000,000 raw rows
reducing to 213,385 five-minute rows and 17,792 hourly rows — so what survives the
raw retention window is roughly a fifth, and what survives the five-minute window
roughly a hundredth.

**Per-row disk cost is deliberately not quoted here.** It was not measured at
scale, and a small instance reports figures dominated by something other than
data.

Be ready for that when you look: `du` on a live table is mostly write buffers.
QuestDB pre-extends every column file in the partition it is currently writing to
16 MiB, so a twenty-column table shows ~320 MB for today regardless of how few
rows it holds. Yesterday's partition, once closed, is a few hundred kilobytes.
Measured on a development instance: today 337 MB, yesterday 336 KB, the day before
212 KB — for the same table. Size your disk from the closed partitions.

Measure the real cost on your own hardware:

```bash
corepack pnpm storage:benchmark
```

That generates a million rows through the real ingestion path and reports what
they cost. Ingestion throughput is not the constraint — the same benchmark
accepted 2.6 million rows a second — so size for disk and for QuestDB's memory,
not for write rate.

### Retention is the control

Disk growth is bounded by the retention policy, not by the fleet size. Three tiers
are configurable in **Settings → Storage**:

| Tier        | Default | Holds                     |
| ----------- | ------- | ------------------------- |
| Raw         | 30 days | Every sample as collected |
| Five-minute | 1 year  | Downsampled rollup        |
| Hourly      | 5 years | Long-term trend           |

Shortening a tier drops data on the next reconcile and cannot be undone. The
application asks for confirmation; there is no second chance after that.

## Watching the monitor

PrickleScope reports on itself in three places.

**Overview** shows fleet reachability and the background jobs, named by what they
do.

**System → Health** shows each dependency with its latency: PostgreSQL, QuestDB,
Grafana, and Telegraf. The sweep behind it is cached for five seconds, so
refreshing hard does not stampede the dependencies.

**The pending-changes badge** in the top bar compares what the controller would
write against what it last wrote, for each reconciled engine. "Up to date" means
the artifact is byte-identical, not that a timestamp looks recent (D-025).

For orchestrators:

| Endpoint        | Meaning                                                   |
| --------------- | --------------------------------------------------------- |
| `/health/live`  | The process is up. Never touches a dependency.            |
| `/health/ready` | Every critical dependency answers. 503 when one does not. |

Both are unauthenticated and return only a status and a version.

Grafana also carries a **Pipeline health** dashboard that the controller
provisions — Telegraf's own internal metrics, ingestion rates, and write errors.
That one lives only in Grafana; the controller does not draw it (D-019).

## Routine tasks

```bash
# Health at a glance
docker compose --env-file infra/.env.production \
  -f infra/compose.yaml -f infra/compose.production.yaml ps

# Follow the API
docker compose --env-file infra/.env.production \
  -f infra/compose.yaml -f infra/compose.production.yaml logs -f api

# Nightly backup
./infra/backup.sh /var/backups/pricklescope/$(date +%F)

# Prove the backup restores — on a schedule, not once
./infra/restore-test.sh /var/backups/pricklescope/$(date +%F)

# Re-check the origin after any change to TLS, DNS, or the gateway
./infra/verify-production-origin.sh

# Dependency and image advisories
./scripts/scan.sh
```

## What grows without being asked

- **Jobs** accumulate a row each. The list endpoint is capped at 25, so the table
  grows without the UI noticing. Nothing prunes it yet.
- **Collector revisions** keep every rendered configuration under
  `infra/runtime/telegraf/revisions/`, deliberately, so a rollback target always
  exists. They are small text files, but there is no retention on them either.
- **Audit events** accumulate a row per credential, retention, collector,
  dashboard, and alert change.
- **Grafana's SQLite database** grows with alert-state history.

None of these is large enough to matter in the first year of a small
installation, and none has automatic pruning. If disk becomes tight, they are the
first places to look after QuestDB.

## Rotating the credential encryption key

There is no bulk re-encryption yet. The key is versioned, and `decrypt` refuses a
version it does not hold, so an unavailable key fails closed rather than returning
nonsense — but changing it today means re-entering every stored secret by hand:
SNMP credentials, the OIDC client secret, the Grafana token, and every
mail-provider credential.

Plan accordingly: generate the key once, back it up separately from the database,
and treat losing it as losing every credential.

## When something is wrong

[deployment.md](deployment.md#troubleshooting) covers the deployment-time
failures. For runtime:

**A source stops reporting.** Check Telegraf is running and reading current
configuration, then whether the pending badge shows an unapplied change. A source
edited but never reconciled is still being polled with the old settings.

**Graphs are empty but the device is reachable.** QuestDB has the tables only
after the retention policy is applied at least once. **Settings → Storage** shows
whether it has been.

**An alert did not fire.** Grafana evaluates, so check its rule state first — the
Alerts screen shows what Grafana reports back. A rule that never reconciled does
not exist in Grafana at all, which the pending badge would be showing.

**Mail is not being delivered.** The Alerts screen records the last delivery
outcome per contact, in the provider's own words. Grafana calls the controller
back to send mail (D-023), so Grafana must be able to reach
`PRICKLESCOPE_NOTIFY_BASE_URL` — inside the container network that is the service
name, not the public URL.
