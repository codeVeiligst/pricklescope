# Upgrades and rollback

Every component is pinned by **tag and digest together**. An upgrade changes both,
one component at a time, and is recorded in
[implementation.md](implementation.md).

## Before any upgrade

```bash
./infra/backup.sh /var/backups/pricklescope/pre-upgrade-$(date +%F)
./infra/restore-test.sh /var/backups/pricklescope/pre-upgrade-$(date +%F)
```

The second command is the one that matters. A backup nobody has restored is a
guess, and an upgrade is exactly when you find out.

## Finding the new digest

```bash
docker buildx imagetools inspect postgres:17.11-alpine | grep -m1 Digest
```

Put both values in `infra/compose.yaml`:

```yaml
image: postgres:17.11-alpine@sha256:<digest>
```

Changing one without the other leaves a pin that says one thing and pulls
another.

## Per component

### PostgreSQL — controller metadata

|                           |                                                                        |
| ------------------------- | ---------------------------------------------------------------------- |
| **Patch** (17.9 → 17.10)  | Safe in place. Stop, change the pin, start.                            |
| **Minor/major** (17 → 18) | Requires a dump and reload; the data directory format changes.         |
| **Rollback**              | Patch: put the old pin back. Major: restore from the pre-upgrade dump. |
| **Watch**                 | `pg_isready` health, then that the application signs in.               |

For a major version, do not point the new image at the old volume — it will
refuse to start, which is the correct behaviour. Dump with `./infra/backup.sh`,
start the new version on an empty volume, and `pg_restore`.

Application schema migrations are separate and run on start when
`PRICKLESCOPE_AUTO_MIGRATE` is true. They only move forward: there is no `down`
step, so rolling the API back past a migration means restoring the database.

### QuestDB — metrics

|                           |                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Patch** (9.4.2 → 9.4.3) | Safe in place.                                                                                       |
| **Minor** (9.4 → 9.5)     | Read the release notes for storage-format changes first.                                             |
| **Major** (9 → 10)        | Treat as a migration. Back up, upgrade on a copy, verify row counts before committing.               |
| **Rollback**              | Restore the volume from the checkpoint copy. QuestDB does not downgrade a converted format in place. |
| **Watch**                 | `/health/ready`, then that graphs still draw and the row counts match.                               |

Verify after any QuestDB change:

```bash
curl -s -G http://localhost:9000/exec \
  --data-urlencode "query=select table_name, table_row_count from tables()"
```

The controller owns the `network_*` tables and the `_5m` and `_1h` materialized
views. If a view is missing after an upgrade, apply the retention policy again —
the reconcile recreates what it owns.

### Grafana — dashboards and alert evaluation

|                             |                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| **Patch** (13.1.0 → 13.1.3) | Safe in place.                                                                            |
| **Minor** (13.1 → 13.2)     | Check the provisioning API; it has changed under us before.                               |
| **Major** (13 → 14)         | Expect provisioning changes. Upgrade on a copy first.                                     |
| **Rollback**                | Restore the volume. Grafana migrates its own database on start and does not migrate back. |
| **Watch**                   | The four managed dashboards, then that an alert rule still evaluates.                     |

The controller owns its dashboards, alert rules, and contact points, so a
reconcile rebuilds them from desired state — the volume matters for user-created
dashboards, alert history, and the service account.

Grafana 13.1.0 removed the contact-point test endpoint the provisioning API used
(D-023's defect note). That class of change is what to look for in the release
notes: the dashboard API and the provisioning API are different surfaces and move
independently.

Also pinned: the QuestDB data-source plugin, via `GF_PLUGINS_PREINSTALL_SYNC`.
Upgrading Grafana without checking plugin compatibility is how the data source
stops working.

### Telegraf — collection

|                                   |                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Patch/minor** (1.39.1 → 1.39.2) | Safe in place. It is stateless.                                                                 |
| **Major** (1 → 2)                 | Check the SNMP input and the Starlark processor; the rate derivation lives there.               |
| **Rollback**                      | Put the old pin back and restart. Nothing persists.                                             |
| **Watch**                         | That interface rates keep arriving — the Starlark processor is where a silent break would show. |

Telegraf holds no state, so this is the safest component to move. The risk is not
the upgrade but the configuration it reads: after any major version, reconcile
collectors and confirm the rendered file is still accepted.

### Caddy — the gateway

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| **Patch/minor** | Safe in place. Update the digest in `infra/Dockerfile.web`. |
| **Major**       | Caddyfile syntax can change. Validate before deploying.     |
| **Rollback**    | Put the old pin back and rebuild.                           |
| **Watch**       | The 24 origin assertions, against your own deployment.      |

The certificate volume (`caddy-data`) holds the issued certificates and the local
CA. Keep it across upgrades; losing it means every client sees a new certificate
authority.

### Node — the API and web images

|                            |                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| **Patch** (24.19.0 → 24.x) | Safe. Update `.nvmrc`, both Dockerfiles, and `engines` in `package.json` together.             |
| **Major** (24 → 26)        | The workspace pins `>=24.19.0 <25`. Test the full suite; `@node-rs/argon2` is a native module. |
| **Rollback**               | Put the old pin back and rebuild.                                                              |
| **Watch**                  | The whole test suite, and that the container actually starts.                                  |

That last point is not boilerplate. Two container arrangements in this project
built cleanly, scanned cleanly, and failed the moment a container started —
`ls` showed the packages and Node could resolve none of them. **Always start the
image, not just build it.**

## Upgrading PrickleScope itself

Change `PRICKLESCOPE_VERSION` in `infra/.env.production` and run
`./scripts/prod-up.sh --no-build`. Rolling back is putting the old version back
and running it again; the volumes are untouched either way, so the only thing to
check first is whether the release notes mention a migration.

A version that does not exist is refused, not substituted — and because nothing
is replaced until the new images are in hand, the containers already running
keep serving through a failed pull. Verified by pointing a deployment at a
nonexistent version: it refused, the previous containers stayed up, and putting
the version back left every source, credential, and metric in place.

## Applying an upgrade

```bash
# 1. Back up and prove the backup
./infra/backup.sh /var/backups/pricklescope/pre-upgrade-$(date +%F)
./infra/restore-test.sh /var/backups/pricklescope/pre-upgrade-$(date +%F)

# 2. Change one pin, tag and digest together, in infra/compose.yaml
#    (or infra/Dockerfile.api / infra/Dockerfile.web for the images built here)

# 3. Validate before starting
./scripts/prod-up.sh --check

# 4. Start
./scripts/prod-up.sh --no-build   # released images; omit for a local build

# 5. Verify
./infra/verify-production-origin.sh --env-file infra/.env.production --no-build
./scripts/scan.sh

# 6. Record it in docs/implementation.md
```

Step 6 is not bureaucracy. The digest in the Compose file is the only record of
what is actually running, and the log is the only record of why it changed.

## Rolling back

For everything except a database format change:

```bash
# Put the previous tag and digest back, then
./scripts/prod-up.sh
```

Where a rollback is **not** just the old pin:

| Component            | Because                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| PostgreSQL major     | The data directory has been converted. Restore the dump.                  |
| QuestDB major        | Storage format converted. Restore the volume copy.                        |
| Grafana any          | It migrates its own database on start and never back. Restore the volume. |
| API past a migration | Schema migrations only move forward. Restore the database.                |

Which is why the pre-upgrade backup comes first, and why it is tested.

## Checking what is behind

```bash
./scripts/scan.sh images
```

Findings inherited from a base image are reported rather than blocking (D-033),
because the fix is a newer pin rather than a code change. The count is the signal:
a number that has grown since the last upgrade means the pin has fallen behind.
