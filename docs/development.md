# Development environment

Everything here runs from the repository root.

## Prerequisites

| Tool     | Version                    | Why                                                |
| -------- | -------------------------- | -------------------------------------------------- |
| Node     | 24 (see `.nvmrc`)          | The API and the build; 22 and 25 both fail         |
| corepack | ships with Node 24         | Runs the pinned pnpm; `corepack enable` if missing |
| Docker   | Engine 24+ with Compose v2 | PostgreSQL, QuestDB, Telegraf, and Grafana         |
| OpenSSL  | any                        | Generates the credential key on first start        |

`./scripts/dev-up.sh` checks all four before it changes anything, and says what
to do about each one it cannot find.

## Starting

```bash
nvm use
./scripts/dev-up.sh
```

First run creates `.env` and `infra/.env` from their examples, generates a
credential key, starts four containers, applies migrations, creates an
administrator, and starts both dev servers. Later runs skip whatever already
exists. It is safe to run repeatedly.

| Command                          | What it does                                        |
| -------------------------------- | --------------------------------------------------- |
| `./scripts/dev-up.sh`            | Everything, ending with the API and web dev servers |
| `./scripts/dev-up.sh --infra`    | Containers only — what the test suites need         |
| `./scripts/dev-up.sh --no-serve` | Everything except the dev servers                   |
| `corepack pnpm dev`              | API and web only, assuming the containers are up    |

When it finishes:

| Service         | Address               | Credentials                       |
| --------------- | --------------------- | --------------------------------- |
| PrickleScope    | http://localhost:5173 | `admin`, password in `.env`       |
| API             | http://localhost:3001 | same session                      |
| Grafana         | http://localhost:3000 | `admin`, password in `infra/.env` |
| QuestDB console | http://localhost:9000 | none                              |
| PostgreSQL      | localhost:5432        | in `infra/.env`                   |

Every container binds to `127.0.0.1` only. Use `localhost`, never `127.0.0.1`, in
URLs and origins — the API's origin check compares them literally and the two
spellings do not match (D-018).

## Stopping and resetting

```bash
# Stop the containers, keep the data
docker compose --env-file infra/.env -f infra/compose.yaml down

# Stop and delete the data as well — metrics, dashboards, users, everything
docker compose --env-file infra/.env -f infra/compose.yaml down --volumes
```

Nothing in the scripts ever removes a volume; `--volumes` is always something you
type on purpose.

To start over completely, add the generated configuration:

```bash
rm -f .env infra/.env
rm -rf infra/runtime/telegraf/active/*.conf infra/runtime/telegraf/revisions/*.conf
./scripts/dev-up.sh
```

Deleting `.env` discards the credential key with it, so anything already encrypted
under it — SNMP credentials, the OIDC client secret, the Grafana token, mail
credentials — becomes unreadable. That is the intended outcome when resetting, and
the reason the key is worth backing up when it is not.

## Logs

```bash
# Dev servers: whatever terminal ./scripts/dev-up.sh is running in
docker compose --env-file infra/.env -f infra/compose.yaml logs -f grafana
docker compose --env-file infra/.env -f infra/compose.yaml logs --tail 50 telegraf
```

The API logs at `debug` in development. Request logs redact cookies,
authorization headers, and every secret-bearing field; the list lives in
`apps/api/src/logging.ts` and a test holds it to the fields the contracts declare.

## Tests

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test              # unit, every workspace
corepack pnpm test:integration  # real PostgreSQL
corepack pnpm test:security     # real PostgreSQL
corepack pnpm test:e2e          # starts the dev servers itself
```

**Integration and security tests silently skip when `TEST_DATABASE_URL` is
unset.** A passing run proves nothing until you have confirmed they executed —
look for the test count, not the colour. `./scripts/dev-up.sh --infra` creates the
`pricklescope_test` database they expect, and `.env` points at it.

The URL must name a database ending in `_test`. The suite throws otherwise,
because it truncates every table it finds.

End-to-end tests need the pinned browser once:

```bash
corepack pnpm --filter @pricklescope/web exec playwright install chromium
```

## Test data

There is no fixture loader. The fastest way to something worth looking at:

1. **Credentials** → add an SNMP v2c credential. Any community string works for a
   device that does not answer; the point is to have one to attach.
2. **Sites** → add a site.
3. **Devices** → add a source. `127.0.0.1` will not answer SNMP but exercises the
   whole path; a real switch or a `snmpsim` instance gives you graphs.
4. **Collectors** → reconcile. Telegraf picks the file up within a poll interval.
5. **Storage** → apply the retention policy so QuestDB has its tables.

For metrics without hardware, point a source at any host running an SNMP agent —
`snmpd` on a spare machine is enough for interface counters.

## Working on a package

`apps/*` consume the `dist/` output of `packages/*`, not their sources.

```bash
corepack pnpm --filter @pricklescope/contracts build
```

After editing a package, rebuild it — or rerun `corepack pnpm dev`, which builds
contracts, db, adapters, and ui first. Skipping this means the apps typecheck
against stale declarations, and the error will point somewhere unrelated.

## Configuration overrides

`.env` holds application settings and `infra/.env` holds container settings. Both
are Git-ignored and generated on first start. Anything in the environment wins
over the file, so a one-off override is:

```bash
PRICKLESCOPE_JOB_CONCURRENCY=1 corepack pnpm --filter @pricklescope/api dev
```

Bounds are enforced where they are read. `PRICKLESCOPE_JOB_CONCURRENCY=1000` does
not start with a warning — it refuses to start at all.

## Troubleshooting

**`./scripts/dev-up.sh` says Node 22.**
`nvm use` in the repository. `.nvmrc` pins 24.19.0.

**Containers will not become healthy.**

```bash
docker compose --env-file infra/.env -f infra/compose.yaml ps
docker compose --env-file infra/.env -f infra/compose.yaml logs --tail 50
```

Grafana takes up to a minute on first start because it installs the QuestDB
plugin.

**Telegraf restarts, or collects nothing.**
It reads configuration the API writes at mode 0600, so both must run as the same
account. `./scripts/dev-up.sh` exports your uid; if you started the containers by
hand, export `TELEGRAF_UID` and `TELEGRAF_GID` first.

**The API starts but every request is 401.**
The session cookie is rejected when the origin does not match. Check that
`PRICKLESCOPE_APP_ORIGIN` in `.env` is exactly the URL in the browser — including
`localhost` rather than `127.0.0.1`.

**A mutation returns 403 with `csrf_invalid`.**
The `x-csrf-token` header is missing or belongs to a different session. The web
application handles this; a hand-rolled `curl` needs the token from
`GET /api/v1/auth/session`.

**Login returns 429.**
Five attempts a minute per address, deliberately. Wait a minute.

**Integration tests pass suspiciously fast.**
They skipped. `TEST_DATABASE_URL` is unset or does not end in `_test`.

**Typecheck fails on a package you just changed.**
Rebuild it. See "Working on a package" above.

**A pending badge will not clear.**
The probe compares what the controller would write against what it last wrote. If
applying does not clear it, the probe and the reconciler disagree — that is a bug
worth reporting, not a display quirk (D-025).

## Where things live

```text
apps/api           Fastify API, auth, jobs, reconcilers
apps/web           React 19 + Vite administration SPA
packages/contracts TypeBox schemas — the shared API contract
packages/db        Kysely schema types and migrations
packages/adapters  SNMP, Telegraf, Grafana, email, health probes
packages/ui        Shared React primitives, including the chart engine
infra              Pinned containers, Dockerfiles, backup and verification scripts
scripts            Startup, scanning
docs               This directory
```

[architecture.md](architecture.md) explains how they fit together, and
[implementation.md](implementation.md) records why each decision was made.
