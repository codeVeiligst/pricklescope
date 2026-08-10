# Container stack

The `infra/` directory starts the standard services used by the proposed architecture.
All published ports bind to `127.0.0.1` by default. Images are pinned by both
human-readable version tag and registry digest.

## Start

Requirements:

- Docker Engine or Docker Desktop
- Docker Compose v2 or newer

From the repository root:

```bash
./scripts/dev-up.sh --infra
```

The script creates `infra/.env` from `.env.example` on first use, validates the
rendered Compose model, starts the services, waits for health checks, and prints
the local URLs. It also creates the isolated `pricklescope_test` database used by
the integration suite. The suite refuses any database name that does not end in
`_test` before it can reset fixtures.

## Services

| Service    |       Version | Local endpoint                   | Purpose                                  |
| ---------- | ------------: | -------------------------------- | ---------------------------------------- |
| PostgreSQL |  17.10 Alpine | `localhost:5432`                 | Controller metadata                      |
| QuestDB    |         9.4.3 | <http://localhost:9000>          | Metrics storage and Web Console          |
| Telegraf   | 1.39.2 Alpine | `localhost:1234`                 | Initial collector and Remote Write relay |
| Grafana    |        13.1.3 | <http://localhost:3000/grafana/> | Visualization and alert evaluation       |

Those endpoints exist **in development only**. Production publishes nothing but
the gateway, so any command here that names a `localhost` port has to be run
inside the container instead — see [deployment.md](deployment.md).

Telegraf's bootstrap configuration stays in `config/telegraf`. PrickleScope
publishes GUI-managed SNMP and ping inputs atomically under
`runtime/telegraf/active`; immutable artifacts are retained under
`runtime/telegraf/revisions`. Both generated paths are ignored by Git and should
not be edited by hand. The Grafana image installs the pinned QuestDB data-source
plugin during startup; PrickleScope creates its datasource and dashboards through
the Grafana API.

Email contact points are webhooks aimed back at the controller, which sends the
mail through the provider's API (D-023). Grafana therefore needs a route to the
API: the Compose service maps `host.docker.internal` to the host gateway, and
`PRICKLESCOPE_NOTIFY_BASE_URL` names the address Grafana calls. The API must
listen on more than loopback for that to work, which is why development sets
`PRICKLESCOPE_HOST=0.0.0.0`.

PrickleScope draws its own graphs from QuestDB and never embeds Grafana in the
page. Grafana serves the identical dashboards behind the session-checked
`/grafana` gateway, which is what the in-app **Open in Grafana** links target.

Development credentials are in `infra/.env`. They are intentionally local-only
defaults and must never be reused for another environment.

## Current bootstrap data flow

```text
Telegraf internal metrics --------------------------> QuestDB

SNMP and ping checks -> Telegraf -> QuestDB ILP/HTTP

Grafana -> read-only QuestDB PostgreSQL-wire user -> QuestDB
```

Grafana is configured for Auth Proxy and subpath serving. Normal browser access
uses PrickleScope's authenticated `/grafana` gateway; the published loopback port
exists only for development and bootstrap diagnostics. The production overlay
removes that direct port:

```bash
docker compose --env-file infra/.env -f infra/compose.yaml -f infra/compose.production.yaml config
```

The static output and relay files remain development bootstrap artifacts. SNMP,
ping, counter normalization, QuestDB schema, and retention are controller-owned;
users do not maintain their generated configuration.

QuestDB has separate PGWire identities: the PrickleScope controller owns DDL and
retention reconciliation, while Grafana uses the read-only identity. Their
development-only credentials live in the ignored `infra/.env` and `.env` files.

## QuestDB OSS backup and restore

QuestDB Community Edition backup is a checkpoint plus an external copy of the
complete QuestDB root. **On a deployment, use the whole-stack scripts** — they
take all three stores in one consistent pass and are the ones
[deployment.md](deployment.md) and [operations.md](operations.md) document:

```bash
./infra/backup.sh /path/to/new-backup
./infra/restore-test.sh /path/to/new-backup
```

They always release the checkpoint, including after a copy failure. Store the
result on different durable storage and protect it like the monitoring data it
contains.

`infra/questdb-backup.sh` and `infra/questdb-restore-test.sh` prototyped this
technique during the storage spike and are **development-only**: they read
`infra/.env`, which a production host does not have, and reach QuestDB on a host
port that production deliberately does not publish. They cannot back up a
deployment.

> **Deprecated — scheduled for removal in 0.1.2.** Use `infra/backup.sh` and
> `infra/restore-test.sh` instead; they cover QuestDB and the other two stores in
> one consistent pass. Nothing depends on the prototypes, and they are kept only
> so that 0.1.1 is not changed after release.

The restore test creates a uniquely named temporary volume and container, adds
QuestDB's `_restore` marker, boots the exact pinned image with telemetry disabled
for the recovery boot, verifies canonical table row counts, and removes only its
temporary resources. A production restore must use the same QuestDB version as
the backup before any planned upgrade.

## Storage benchmark

Run the repeatable one-million-row raw/rollup benchmark with:

```bash
pnpm storage:benchmark
```

By default its `_pricklescope_benchmark*` tables are removed after the run. Pass
`-- --keep` only when inspecting the temporary tables manually.

## Common commands

Run these from the repository root:

```bash
docker compose --env-file infra/.env -f infra/compose.yaml ps
docker compose --env-file infra/.env -f infra/compose.yaml logs --follow
docker compose --env-file infra/.env -f infra/compose.yaml down
```

`down` preserves named volumes. Removing volumes is destructive and is therefore
not included in the development script.

## Verification queries

After startup, open the QuestDB Web Console and list the tables:

```sql
tables();
```

Telegraf should create internal metric tables and the controller should own the
`network_*` schema plus its 5-minute and hourly materialized views.

## Version updates

The Compose file records the pulled multi-architecture registry digest alongside
the readable tag, and an update must change both together.

[upgrades.md](upgrades.md) covers the procedure per component, including which
rollbacks are just the old pin and which need a restore.
