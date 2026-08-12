# Production deployment

PrickleScope runs as six containers on one host, behind a gateway that is the only
thing reachable from outside.

```text
        :80 :443
           │
    ┌──────▼──────┐
    │  web (Caddy)│  TLS, the built SPA, and routing
    └──────┬──────┘
           │  /api  /health  /grafana
    ┌──────▼──────┐
    │     api     │  the only process holding the credential key
    └──┬────┬───┬─┘
       │    │   └──────────────┐
 ┌─────▼┐ ┌─▼──────┐    ┌──────▼──┐      ┌──────────┐
 │ pg   │ │questdb │    │ grafana │      │ telegraf │
 └──────┘ └────▲───┘    └─────────┘      └────┬─────┘
               └────────────────────────────── ┘
```

`/grafana` goes to the **API**, not to Grafana. The API checks the session and
reconstructs the Auth Proxy identity headers; pointing the gateway straight at
Grafana would skip the only thing that makes that traffic safe.

## Before you start

| Requirement | Detail                                                                              |
| ----------- | ----------------------------------------------------------------------------------- |
| Host        | Linux with Docker Engine 24+ and Compose v2                                         |
| Resources   | See [operations.md](operations.md#supported-deployment-size)                        |
| DNS         | An A/AAAA record for your hostname pointing at the host                             |
| Ports       | 80 and 443 reachable from the internet if you want an automatic certificate         |
| Storage     | Persistent volumes for PostgreSQL, QuestDB, Grafana, and the gateway's certificates |
| Backups     | Somewhere off this host, and somewhere separate again for the key                   |

Nothing else needs to be open. PostgreSQL, QuestDB, Grafana, and Telegraf are not
published at all.

## First deployment

### 1. Configuration

```bash
cp infra/.env.production.example infra/.env.production
$EDITOR infra/.env.production
```

Every password in the example is a placeholder, and `./scripts/prod-up.sh`
refuses to start while any of them survives. Generate real ones:

```bash
openssl rand -base64 24
```

The two that need care:

- **`PRICKLESCOPE_SITE_ADDRESS`** — the name Caddy serves and obtains a
  certificate for.
- **`PRICKLESCOPE_APP_ORIGIN`** — the same name as a URL. The API matches request
  origins against it, so if the two disagree nobody can sign in.

### 2. TLS

The site address alone decides how TLS is handled. Caddy has no separate switch:

| `PRICKLESCOPE_SITE_ADDRESS` | Result                                                |
| --------------------------- | ----------------------------------------------------- |
| `monitor.example.com`       | A public certificate over ACME, renewed automatically |
| `localhost`                 | A certificate from Caddy's own local CA               |
| `:80`                       | Plain HTTP, for terminating TLS somewhere else        |

For ACME the name must resolve to this host and ports 80 and 443 must be
reachable. If you already have a load balancer or reverse proxy doing TLS, set
`:80` and keep `PRICKLESCOPE_APP_ORIGIN` as the public `https://` URL — the API
still marks cookies `Secure`, so the outer hop must be HTTPS or nobody can sign
in.

### 3. Secrets

Two secrets are files rather than environment variables, because an environment
variable is readable from `docker inspect` and from every process in the
container.

```bash
mkdir -p infra/secrets
openssl rand -base64 32 > infra/secrets/credential_key
openssl rand -base64 24 | tr -d '\n' > infra/secrets/bootstrap_admin_password

# The API container does not run as root and cannot read root's files.
chown "$(id -u):$(id -g)" infra/secrets/credential_key infra/secrets/bootstrap_admin_password
chmod 400 infra/secrets/credential_key infra/secrets/bootstrap_admin_password
```

Set `TELEGRAF_UID` and `TELEGRAF_GID` in `infra/.env.production` to that same
account. Telegraf and the API share a uid because the API writes the collector
configuration at mode 0600 and Telegraf has to read it.

> **Back up `credential_key` now, somewhere other than this host and other than
> your database backups.** It encrypts every SNMP credential, the OIDC client
> secret, the Grafana service-account token, and every mail-provider credential.
> Without it a restored database is unreadable; beside them, it defeats the point
> of having a key at all.

### 4. Choose where the images come from

**The released images**, which is the normal case. Uncomment
`PRICKLESCOPE_IMAGE_PREFIX` in `infra/.env.production` and set
`PRICKLESCOPE_VERSION` to a published release. Verify the signatures before you
run them — every release names its own command, and it fails on an image that
this project's release workflow did not build:

```bash
cosign verify ghcr.io/codeveiligst/pricklescope/api:0.1.3 \
  --certificate-identity-regexp '(?i)^https://github\.com/codeVeiligst/pricklescope/\.github/workflows/release\.yaml@refs/tags/v.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Or build them from this checkout**, which is the default: leave
`PRICKLESCOPE_IMAGE_PREFIX` commented out. You then get whatever the working copy
contains, which is right for a change you are testing and wrong for a
deployment you intend to keep.

### 5. Start

```bash
./scripts/prod-up.sh --check      # validate, change nothing
./scripts/prod-up.sh --no-build   # released images: pull and start
./scripts/prod-up.sh              # local build: build and start
```

`--check` refuses rather than warns: an https origin that is not https, a site
address that disagrees with it, an example password, a secret file the API cannot
read, and the published example key are each a hard stop. Nothing starts until
they are all fixed.

Use `--no-build` with the released images. Compose builds any image it cannot
find whenever a build section exists, so without it a registry that is
unreachable, or a version that does not exist, is silently replaced by a local
build of this checkout — running something other than what you asked for, under
the name of the thing you asked for.

### 6. Verify

```bash
./infra/verify-production-origin.sh --env-file infra/.env.production --no-build
```

Twenty-four assertions against the real origin: HTTP redirects to HTTPS, the
session cookie is `Secure`, `HttpOnly`, and `SameSite=Lax`, HSTS and CSP are
served, `/grafana` without a session is 401 and with one carries the session's own
identity, a client cannot supply its own identity headers, a foreign origin cannot
mutate, and nothing but the gateway is published.

It signs in as the bootstrap administrator, so run it before you remove that
account in step 7.

Run with no arguments it uses its own fixture (`infra/.env.verification`,
deliberately weak passwords) and builds a throwaway stack instead — useful for
testing the checks themselves, not for checking your deployment.

### 7. Sign in and finish setup

Open `PRICKLESCOPE_APP_ORIGIN` and sign in as the bootstrap administrator. Then,
in the application:

1. **Settings → Storage** — set retention and apply it, which creates the QuestDB
   tables and materialized views.
2. **Settings → Credentials** — add the SNMP credentials for your fleet.
3. **Workspace → Devices** — add sources.
4. **Settings → Collectors** — reconcile so Telegraf starts polling.
5. **System → Users** — create real accounts, then remove or disable the bootstrap
   one.

## Day-to-day operations

```bash
# Health
docker compose --env-file infra/.env.production \
  -f infra/compose.yaml -f infra/compose.production.yaml ps

# Logs
docker compose --env-file infra/.env.production \
  -f infra/compose.yaml -f infra/compose.production.yaml logs --tail 100 api

# Stop, keeping data
docker compose --env-file infra/.env.production \
  -f infra/compose.yaml -f infra/compose.production.yaml down

# Restart after a configuration change, reusing the image already there
./scripts/prod-up.sh --no-build
```

`down` never removes volumes. Only `down --volumes` does, and nothing in this
project types that for you.

## Backup

```bash
./infra/backup.sh /var/backups/pricklescope/$(date +%F)
```

It backs up the stack described by `infra/.env.production` when that file exists,
and `infra/.env` otherwise; `PRICKLESCOPE_ENV_FILE` names one explicitly. It
prints which it chose before it starts.

Three stores, three consistency requirements, handled for you: a logical dump for
PostgreSQL, a `CHECKPOINT` for QuestDB, and a brief stop of Grafana because SQLite
cannot be copied safely from under a running writer. Alert evaluation pauses for
those few seconds.

Not in the backup, on purpose:

- **The credential key.** Keeping it beside the ciphertext it opens would undo the
  reason for having it.
- **Telegraf configuration**, which a reconcile regenerates.
- **Grafana dashboards and alert rules**, which the controller owns and rewrites.

### Verify the backup

```bash
./infra/restore-test.sh /var/backups/pricklescope/2026-08-09
```

Restores all three into throwaway containers and checks the data is really there —
the tables read back, the encrypted credentials survive still sealed, QuestDB
returns its rows, and Grafana comes back with its dashboards. Nothing touches the
running stack.

An untested backup is a guess about the future. Run this on a schedule, not once.

### Restore

1. Stop the stack.
2. Restore PostgreSQL with `pg_restore` into a fresh database.
3. Replace the QuestDB and Grafana volume contents with the backup copies.
4. Put the **credential key** back in `infra/secrets/credential_key`.
5. Start with `./scripts/prod-up.sh`.
6. Reconcile collectors, storage, Grafana, and alerts — the controller rewrites
   everything it owns from its own desired state.

Step 4 is the one that decides whether the rest was worth doing.

## Upgrades and rollback

See [upgrades.md](upgrades.md). The short version: every image is pinned by tag
**and** digest, upgrades move one component at a time, and rollback is putting the
previous pin back — except where a migration has run, which the guide flags per
component.

## Troubleshooting

**Caddy cannot get a certificate.**
The name must resolve to this host and ports 80 and 443 must be reachable from
the internet. `docker compose ... logs web` names the ACME failure. Until it
succeeds Caddy serves nothing on 443.

**Nobody can sign in, and the browser shows no error.**
`PRICKLESCOPE_APP_ORIGIN` does not match the URL in the address bar. The API
refuses mutations from a mismatched origin and the cookie will not be returned
over plain HTTP.

**The API will not start: "PRICKLESCOPE_CREDENTIAL_KEY is the example key".**
`infra/secrets/credential_key` holds the key that once shipped in
`.env.example`, which everyone has. Generate a new one — but note that anything
already encrypted under the old one becomes unreadable, so do this before the
installation holds real credentials.

**Telegraf restarts, or collects nothing.**
The API writes its configuration at mode 0600. If `TELEGRAF_UID` does not match
the owner of `infra/runtime/telegraf`, Telegraf cannot read it.
`./scripts/prod-up.sh` sets that ownership; check it if you moved the directory.

**A pending badge will not clear after applying.**
The probe compares what the controller would write against what it last wrote. If
applying cannot clear it, the probe and the reconciler disagree — a bug, not a
display quirk (D-025).

**Grafana shows "Powered by Grafana" or its own login.**
You reached it directly rather than through `/grafana`. It is not published in
production; if you can reach it, check the overlay is actually in the command.
