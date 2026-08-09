# PrickleScope Threat Model

Status: Active
Last reviewed: 2026-08-07 (Milestone 8)
Scope: the controller's own credentials, its collector pipeline, and the internal
service APIs it speaks to. Companion to the security principles in
[../architecture.md](../architecture.md); this document is where those principles are
tested against specific attackers and specific code.

A threat model that only lists good intentions is not one. Every control below
names where it lives, and every finding names what was actually changed.

## What is worth stealing

| Asset                           | Where it lives                                             | Loss if taken                                                       |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `PRICKLESCOPE_CREDENTIAL_KEY`   | Environment or a mounted file, never the database          | Every stored secret at once — this is the single highest-value item |
| SNMP credentials                | `snmp_credentials`, AES-256-GCM per record                 | Read, and for v3 write, access to the monitored network             |
| OIDC client secret              | `oidc_provider_settings`, AES-256-GCM                      | Impersonation of the controller to the identity provider            |
| Grafana service-account token   | `grafana_settings`, AES-256-GCM                            | Full control of dashboards, alert rules, and notification routing   |
| Mail-provider credentials       | `contact_points`, AES-256-GCM                              | Ability to send mail as the operator's own domain                   |
| Session cookies                 | PostgreSQL server-side, HttpOnly cookie holds only a token | Impersonation of one user for the remaining session lifetime        |
| Rendered Telegraf configuration | `infra/runtime/telegraf/`, mode 0600                       | SNMP credentials in cleartext — the one place they are unencrypted  |
| Metrics history                 | QuestDB volume                                             | Network topology and traffic patterns; no credentials               |

The credential key is deliberately the only thing not stored beside what it
protects. A database dump alone is not enough to decrypt anything.

## Who is attacking

- **A1 Unauthenticated network caller** who can reach the published port.
- **A2 Authenticated viewer** — a real account with read-only intent.
- **A3 Authenticated operator** — can create sources, rules, and contacts, and so
  can make the controller talk to hosts of their choosing. Trusted with the
  monitored network, _not_ trusted with the controller's own secrets.
- **A4 A monitored device** answering SNMP with hostile data.
- **A5 A compromised engine** — Telegraf, QuestDB, or Grafana under someone
  else's control, on the internal network.
- **A6 Someone holding a database backup** but not the credential key.

Administrators are not modelled as attackers: an administrator can change OIDC,
rotate the Grafana token, and create accounts, so the boundary they would cross is
the one they already own. The relevant control for them is the audit log.

## Trust boundaries

```text
A1/A2/A3  browser ──HTTPS──▶ [ web gateway ]  ← TLS terminates, identity headers stripped
                                   │
                     /api ─────────┼───────── /grafana (session checked, headers reconstructed)
                                   ▼
                            [ Fastify API ]  ← the only process holding the credential key
                          ╱        │        ╲
                  PostgreSQL   QuestDB     Grafana        ← internal network, never published
                                   ▲          │
                            [ Telegraf ] ◀────┘ (config on disk, mode 0600)
                                   │
                                   ▼
                            A4 monitored devices (SNMP/ICMP)
```

The boundary that matters most is the second one: **nothing behind the API is
published in production**. PostgreSQL, QuestDB, Grafana, and the Telegraf listener
are reachable only on the Compose network. In development they are bound to
`127.0.0.1` and never to `0.0.0.0`.

## Surfaces, threats, and controls

### Authentication and session handling

| Threat                                  | Control                                                                                 | Where                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| Credential stuffing (A1)                | Argon2id, 5 attempts per minute per address                                             | `security.ts`, `auth/routes.ts:68`     |
| Session theft via script                | HttpOnly, `SameSite=Lax`, `Secure` in production; the cookie holds a token, not a claim | `auth/routes.ts` `sessionCookie`       |
| Stale authorization after a role change | Account state is re-read on every request, not carried in the cookie                    | `auth/guards.ts` `authenticate`        |
| Cross-site request forgery              | CSRF header compared with `timingSafeEqual`, plus an Origin match on every mutation     | `auth/guards.ts` `csrf`, `app.ts` hook |
| Open redirect after login               | `safeReturnTo` rejects anything not a single-slash relative path                        | `security.ts:41`                       |
| Authorization-code interception (OIDC)  | PKCE, `state`, and `nonce` all generated and verified                                   | `auth/oidc.ts:94`                      |
| Administrator locking themselves out    | Self-disable, self-demote, and self-delete are refused                                  | `users/service.ts`                     |

`SameSite=Lax` and the Origin hook are independent: either alone would stop a
cross-site POST. That redundancy is why the Grafana gateway does not add a third
CSRF check of its own — Grafana's own protections sit behind it.

### Secrets at rest

Every secret uses AES-256-GCM with a random 12-byte nonce and AAD binding the
ciphertext to both its record id and the key version
(`pricklescope:snmp-credential:<id>:v<n>`). Moving a ciphertext to another row
fails to decrypt rather than silently decrypting as that row's secret. A6 —
someone with only a backup — gets nothing.

Key rotation is versioned but not yet automated: `decrypt` refuses a version it
does not hold, so an unavailable key fails closed instead of returning garbage.
Bulk re-encryption remains unbuilt and is recorded as an accepted gap below.

Secrets are write-only across the API: no endpoint returns a stored value, and
submitting a new one rotates it. Logging redaction is centralised in the Fastify
logger's `redact.paths`, which must be extended when a new secret-bearing field
is added.

### The collector pipeline

| Threat                                           | Control                                                                                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOML injection through a source name or tag (A3) | Every interpolated value goes through `JSON.stringify`, whose escaping is valid for TOML basic strings — `packages/adapters/src/telegraf.ts:46`                                               |
| Argument injection into `ping` (A3)              | `inputs.ping` uses `method = "exec"`, so targets are process arguments. `validateTarget` requires a leading alphanumeric, which rejects `-f` and every other flag — `inventory/service.ts:65` |
| SNMP credentials readable on disk (A5)           | Rendered configuration is written mode 0600 into a 0700 directory, atomically via rename                                                                                                      |
| A hostile device poisoning storage (A4)          | Telegraf's Starlark processor derives rates with explicit rollover, reset, and discontinuity handling; SNMP values become tagged fields, never identifiers or SQL                             |
| Rollback to a tampered revision                  | Revisions are immutable, written with `flag: 'wx'` so an existing id cannot be overwritten                                                                                                    |

The rendered configuration is the one place SNMP credentials exist unencrypted.
That is inherent — Telegraf must read them — and is why the directory is 0600 and
Git-ignored, and why `redactedContent` exists for anything shown in the UI.

### Internal service APIs

| Surface                         | Exposure                                    | Control                                                                                                      |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| QuestDB PGWire                  | Internal network only                       | Server-side only, parameterized queries, `statement_timeout`, row limit. No SQL pass-through endpoint exists |
| Grafana HTTP API                | Internal network only                       | Scoped service-account token, encrypted at rest                                                              |
| Grafana UI via `/grafana`       | Same-origin, session-checked                | Inbound identity headers deleted and reconstructed from the session — `grafana/gateway.ts:9`                 |
| Telegraf remote-write           | Internal network; loopback in development   | No authentication; relies on the network boundary. Accepted gap below                                        |
| `/api/v1/alerts/notify/:ref`    | Reachable by Grafana, therefore semi-public | 32-byte generated bearer token compared with `timingSafeEqual`, length-checked first                         |
| `/health/live`, `/health/ready` | Unauthenticated by necessity                | Status and version only; the sweep behind readiness is cached — see F2                                       |

Alert rule SQL is generated by the controller, never accepted from a caller. Scope
values are passed through an allowlist regex (`/^[A-Za-z0-9_.:-]{1,128}$/`) and
rejected rather than escaped — `packages/adapters/src/alert-query.ts:41`.

### Outbound requests the controller can be made to send

A3 chooses several addresses the controller then connects to: a webhook contact
point URL, an SNMP target, and (administrator only) the OIDC issuer. This is
server-side request forgery by design — reaching operator-chosen hosts is the
product's purpose — and is bounded rather than prevented:

- Responses are never returned to the caller; only success, an HTTP status, or a
  sanitised error message is.
- Every outbound call carries a timeout (`AbortSignal.timeout`).
- Error text is stripped of secrets and newlines and truncated before display.

An operator who can already reach the monitored network gains little by pointing a
webhook at it. What they must **not** gain is the controller's own secrets — which
is exactly what F1 below was.

## Findings from this review

### F1 — An operator could redirect a mail-provider call and take its credential (fixed)

`packages/adapters/src/email.ts` lets a caller override each provider's base URL
so the adapter's tests can assert the request it builds.
`UpsertContactPointRequestSchema` closes itself with `additionalProperties: false`,
but a **nested** object does not inherit that, so `providerConfig.apiBaseUrl`
survived validation, was stored verbatim by `upsertContactPoint`, and was spread
straight back into `sendEmail`. An operator could point SendGrid at a host they
controlled and receive the API key — or, for Graph and Gmail, the client secret
and refresh token. Confirmed against the real Fastify validator before fixing.

Fixed in three places, none of which is the only guard:

1. `EmailProviderConfigSchema` and `EmailCredentialsSchema` now set
   `additionalProperties: false`, so Ajv strips unknown keys.
2. `upsertContactPoint` copies only `EMAIL_PROVIDER_CONFIG_KEYS`, so the write
   path is narrow regardless of the schema.
3. The send path filters again, so a row written before this change cannot
   redirect a call either.

Held by `apps/api/src/alerts/schema.test.ts`.

### F2 — Unauthenticated readiness probing amplified into every dependency (fixed)

`/health/ready` has no session to check, and each call queried PostgreSQL and
opened connections to QuestDB, Grafana, and Telegraf. Anyone who could reach the
port could make the controller hammer its own dependencies at any rate. Sweeps are
now cached for five seconds and concurrent callers share one, which a probe
running every few seconds cannot tell apart from the old behaviour. `checkedAt`
reports the age. Held by `apps/api/src/health/service.test.ts`.

### F3 — No ceiling on authenticated request volume (fixed)

Rate limiting was registered with `global: false` and opted into by exactly two
routes, so a stolen session could grind QuestDB or the SNMP stack unchecked. There
is now a global 600/minute ceiling keyed by session — hashed, since the key is
stored — falling back to the client address for anonymous callers. QuestDB-backed
routes (the three graph endpoints and alert preview) are metered at 120/minute.
The login limit of 5/minute per address is unchanged.

## Accepted gaps

These are decisions, not oversights. Each names what would change it.

- **No bulk credential-key rotation.** Versioning exists and unavailable keys fail
  closed, but re-encrypting every record under a new key is manual. Revisit when
  an installation has enough records for that to be impractical.
- **Telegraf's remote-write listener is unauthenticated.** It relies on the
  container network boundary. Revisit if collectors are ever run off-host, which
  is also when D-024's Alloy seam would matter.
- **The session cookie has no `__Host-` prefix.** It already meets every condition
  for one (Secure, `Path=/`, no `Domain`). Adding the prefix is a one-line change
  worth making the next time cookie handling is touched.
- **A monitored device can fill storage with high-cardinality interface names.**
  Retention TTLs bound it in time but not in cardinality. Revisit if a real
  deployment hits it.
- **Administrators are not constrained by the model.** Their actions are audited,
  not prevented.

## Reviewing this document

Re-run this review when a new outbound call is added, when a new secret-bearing
field is introduced, when a route stops requiring a session, or when a nested
request schema is added — F1 was all four of those in one small change.
