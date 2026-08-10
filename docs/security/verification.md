# PrickleScope Security Verification Report

Status: Complete for Milestone 9
Date: 2026-08-08
Revised: 2026-08-10 — three of this report's gaps existed only because the project
was not yet a Git repository and had no CI. Milestone 11 supplied both, so the
commit-history secret scan, the CI review, and the tested-commit record are now
filled in rather than deferred. Each is marked **Revised 2026-08-10** below.
Tested commit: `b87c499`, released as `v0.1.1`
(`ghcr.io/codeveiligst/pricklescope/api@sha256:33bb8dd4…`,
`web@sha256:f8188615…`).
Scope: the PrickleScope controller — its API, its collector pipeline, its browser
application, and the container stack it ships with.
Companion to [threat-model.md](threat-model.md), which is the threat model this verifies
against.

A verification report is only worth the evidence behind it. Every claim below
names the check that produced it, and the checks are all runnable.

## What was tested, and with what

| Surface                       | Method                                | Where                                                  |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Authorization, every route    | Matrix sweep, four roles              | `apps/api/tests/security/authorization.test.ts`        |
| Privilege boundaries          | Aggregate-vs-direct comparison        | `apps/api/tests/security/privilege-boundaries.test.ts` |
| Injection, traversal, SSRF    | Adversarial requests                  | `apps/api/tests/security/adversarial.test.ts`          |
| CSRF, CORS, headers, sessions | Forged and malformed requests         | `apps/api/tests/security/browser-protections.test.ts`  |
| Resource exhaustion           | Limits driven to their ceiling        | `apps/api/tests/security/limits.test.ts`               |
| Secret disclosure             | Planted values, checked on every path | `apps/api/tests/security/disclosure.test.ts`           |
| Config and SQL rendering      | Seeded fuzzing                        | `packages/adapters/src/fuzz.test.ts`                   |
| First-party code              | Semgrep, project rules + community    | `./scripts/security-scan.sh sast`                      |
| Secrets, tree and history     | gitleaks, two passes                  | `./scripts/security-scan.sh secrets`                   |
| Dependencies and images       | pnpm audit, Trivy                     | `./scripts/scan.sh`                                    |
| Running deployment            | ZAP baseline, authenticated           | see "Dynamic testing"                                  |
| TLS, cookies, gateway         | 24 assertions against a real origin   | `./infra/verify-production-origin.sh`                  |

Versions: Semgrep 1.145.0, gitleaks v8.30.1, Trivy 0.73.0, ZAP 2.16.1, all pinned
by digest in the scripts that run them. Node 24.19.0, pnpm 11.20.0.

Images as tested: `postgres:17.10-alpine`, `questdb/questdb:9.4.3`,
`telegraf:1.39.2-alpine`, `grafana/grafana:13.1.3`, `caddy:2.11.4-alpine`,
`node:24.19.0-alpine`, each pinned by tag and digest in `infra/compose.yaml` and
the two Dockerfiles.

## Results

```
Security suite          127 passed    apps/api/tests/security, 6 files
Fuzzing                   8 passed    packages/adapters/src/fuzz.test.ts
Unit                     83 passed
Integration              14 passed
Production origin        24 passed    0 failed
ZAP baseline (auth'd)    65 passed    0 failed, 2 warnings (both addressed)
Semgrep                   clean       2 findings allowed with reasons
gitleaks                  clean
Dependencies              clean       1 advisory allowed with a reason
Container images          clean       inherited base-image findings reported
```

## Findings

Nine were found. Eight are fixed with a regression test; one is accepted with a
stated reason.

### C-1 (Critical, fixed) — Naming a source executed code on the collector host

`renderCheck` interpolated a source name into a TOML **comment**, which is the one
place a value is not quoted. A newline ends a comment, so a source named

```
Evil\n[[inputs.exec]]\n  commands = ["/bin/sh -c id"]\n#
```

rendered a real `[[inputs.exec]]` block. Telegraf's exec input runs commands, so
any **operator** — the role that creates sources — could run arbitrary commands
on the collector host. Confirmed by rendering it.

Fixed in four places, none of which is the only guard:

1. `comment()` strips control characters from the comment line.
2. `validateTelegrafDesiredState` refuses control characters in a name, target, or
   tag before rendering starts.
3. `validateTelegrafCandidate` refuses any rendered table that the renderer cannot
   itself emit — a backstop that does not depend on knowing which field was unsafe.
4. `SafeText` in the contracts rejects them at the API, so an operator gets a 400
   on the form rather than a job that fails later.

Held by `packages/adapters/src/fuzz.test.ts` and a project Semgrep rule.

### H-1 (High, fixed) — An operator could take a mail provider's credential

Found during Milestone 8 and recorded here because its regression test lives with
the others. `providerConfig.apiBaseUrl` survived validation — a nested object does
not inherit `additionalProperties: false` — and the email adapter honoured it, so
an operator could redirect the provider call and receive the API key. Fixed at the
schema, the write path, and the send path.

### H-2 (High, fixed) — `/sync/apply` let an operator run administrator reconciles

The aggregate "apply pending changes" endpoint required `operator`, and enqueued
`storage.questdb.reconcile`, `grafana.reconcile`, and `alerts.reconcile` — all
three of which require `administrator` on their own routes. An operator could
enact a retention policy an administrator had set but not applied, rewrite the
managed dashboards, and push alert rules. Classic privilege escalation by
aggregation (OWASP API1:2023).

Fixed: the route requires `administrator`, and the UI control is gated to match
rather than offering a shortcut past it. Nothing is lost — the one target an
operator may reconcile has its own route. Held by
`privilege-boundaries.test.ts`, which compares the aggregate against the direct
routes rather than restating a level.

### H-3 (High, fixed) — A published encryption key shipped in `.env.example`

`.env.example` is committed and contained a working AES-256 key
(`pricklescope-dev-credential-key!`), and `scripts/dev-up.sh` copies that file to
create `.env`. An installation could therefore be encrypting every SNMP
credential, OIDC secret, Grafana token, and mail credential under a key published
in the repository, without anyone having chosen it.

Fixed at three levels: the example carries a placeholder and the command to
generate a real key; `dev-up.sh` generates a fresh key when it creates `.env`; and
the API refuses to start in production if it finds the published key, matched by
fingerprint so the bad key is not itself in the source.

### M-1 (Medium, fixed) — Rate limiting reported itself as a server fault

Making the error handler actually run (Milestone 8) left the rate limiter's 429
unrecognised, so every throttled request became a 500 with no `Retry-After` and a
log line reading "Unhandled request error". The request was still refused, but a
caller could not tell "slow down" from "the server is broken", and the noise would
bury a real fault. Fixed by honouring any 4xx an upstream plugin raises; body-too-
large and unsupported-media-type were in the same bucket.

### M-2 (Medium, fixed) — The whole API description was public

`GET /api/openapi.json` had no guard, handing an unauthenticated caller a complete
map of every route, parameter, and response shape. It carries no secrets, and
nothing in the browser fetches it. Now requires a session.

### M-3 (Medium, fixed) — Unauthenticated readiness probing hit every dependency

From Milestone 8: `/health/ready` queried PostgreSQL and opened connections to
QuestDB, Grafana, and Telegraf on every call, with no session and no cache. Sweeps
are now cached for five seconds and concurrent callers share one.

### L-1 (Low, fixed) — The storage policy request accepted any field

`UpdateStoragePolicyRequestSchema` was a `Type.Intersect`, and neither branch can
close itself to unknown properties without rejecting the other's — so the endpoint
accepted anything a caller added. Changed to `Type.Composite`, which merges into
one closable object. Held by a schema audit that walks every request schema's
whole tree, not just its top level.

### L-2 (Low, fixed) — API responses were cacheable

Found by the ZAP baseline. Authenticated JSON was served without `Cache-Control`,
so an intermediary or the browser could store it. Now `no-store` on every `/api`
response.

### A-1 (Accepted) — Schema validation runs before authentication

Fastify validates a request body before it runs a `preHandler`, so an
unauthenticated caller sending a malformed body to a guarded route gets 400 rather
than 401. Two consequences: untrusted input is parsed and validated before the
caller is known, and the 400-versus-401 difference reveals that a route exists and
takes a body.

Accepted, because:

- The request is refused either way; nothing runs.
- The work is bounded by the 1 MB body limit and the rate limiter, and the deepest
  JSON that fits inside that limit was tested (150,000 levels) without a crash.
- The generic validation message does not name the field that failed, so the
  disclosure is that a route exists — which the OpenAPI document already tells any
  signed-in user.

Changing it means moving authentication to an `onRequest` hook with a public-route
allowlist, which trades a real refactor of every guard for a small information
difference. Revisit if the API is ever exposed to an untrusted network directly
rather than behind the gateway.

## OWASP ASVS 5.0

Level 1 as the baseline, with Level 2 requirements taken where the threat model
says they matter: authentication, sessions, credentials, collectors,
administrative operations, and internal APIs.

| Chapter                          | Assessment | Evidence                                                                                                                        |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| V1 Encoding and sanitization     | Met        | No dynamic evaluation, no subprocesses, no SQL string building on the request path. Config and SQL rendering fuzzed.            |
| V2 Validation and business logic | Met        | Every request schema closed to unknown properties, verified by a tree-walking audit. Range, size, and identifier bounds tested. |
| V3 Web frontend security         | Met        | CSRF token bound to the session, Origin match, `SameSite=Lax`, CSP and HSTS from the gateway, no CORS headers ever emitted.     |
| V4 API and web service           | Met        | Every route carries a stated access level, enforced and swept for all four roles. No route may be added without one.            |
| V5 File handling                 | N/A        | The product accepts no uploads. The only file it writes is generated collector configuration.                                   |
| V6 Authentication                | Met (L2)   | Argon2id, throttled 5/minute, no user enumeration, OIDC with PKCE + state + nonce.                                              |
| V7 Session management            | Met (L2)   | Server-side sessions, HttpOnly + Secure + `SameSite=Lax`, immediate revocation on logout, password change, and disable.         |
| V8 Authorization                 | Met (L2)   | Role order enforced per route; account state re-read every request; the aggregate endpoint held to its parts.                   |
| V9 Self-contained tokens         | N/A        | No JWTs. The cookie holds an opaque token, not a claim.                                                                         |
| V10 OAuth and OIDC               | Met (L2)   | PKCE, state, nonce, and a redirect allowlist; the client secret is encrypted and never returned.                                |
| V11 Cryptography                 | Met (L2)   | AES-256-GCM with a random nonce and record-bound AAD; a versioned key that fails closed. Bulk rotation is a stated gap.         |
| V12 Secure communication         | Met        | HTTPS verified against a real origin; nothing behind the gateway is published.                                                  |
| V13 Configuration                | Met        | Secure cookies required in production; the published example key refused; images pinned by digest.                              |
| V14 Data protection              | Met        | Secrets write-only across the API, proven with planted values; `no-store` on API responses.                                     |
| V15 Secure coding                | Partial    | SAST runs, but see the note below on community rule coverage.                                                                   |
| V16 Logging and error handling   | Met        | One error shape with a request id and no internal detail; redaction list held to the schemas by a test.                         |
| V17 WebRTC                       | N/A        | Not used.                                                                                                                       |

## OWASP API Security Top 10 (2023)

| Risk                                        | Assessment                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| API1 Broken object level authorization      | **Found and fixed** — H-2. Now held by a test that compares an aggregate against its parts.                      |
| API2 Broken authentication                  | Covered — throttling, no enumeration, immediate revocation, PKCE.                                                |
| API3 Broken object property level auth      | **Found and fixed** — H-1 and L-1. Every request schema is now closed, audited to its leaves.                    |
| API4 Unrestricted resource consumption      | **Found and fixed** — M-3, plus the rate-limit ceiling. Lists, ranges, timeouts, and body size all bounded.      |
| API5 Broken function level authorization    | Covered — the route matrix fails when a route has no stated level.                                               |
| API6 Unrestricted access to sensitive flows | Covered — reconciles are administrator-gated; SNMP tests and inventory are metered background jobs.              |
| API7 Server-side request forgery            | Bounded by design — operator-chosen hosts are the product's purpose; responses are never returned to the caller. |
| API8 Security misconfiguration              | **Found and fixed** — H-3, M-2, L-2. Images pinned; nothing behind the gateway published.                        |
| API9 Improper inventory management          | Covered — one versioned API surface, described by an authenticated OpenAPI document.                             |
| API10 Unsafe consumption of third parties   | Covered — provider base URLs are no longer caller-settable (H-1); outbound calls carry timeouts.                 |

## Static analysis: what it is worth

The community Semgrep rulesets are close to inert on this codebase. Seventy-nine
rules from `p/typescript`, `p/nodejs`, and `p/owasp-top-ten` ran against a file
containing `eval(userInput)`, a shell injection, and `rejectUnauthorized: false`
and reported **nothing**; `p/security-audit`, `p/javascript`, and
`p/command-injection` also reported nothing. The free registry says as much when
it suggests logging in for more rules.

They are still run — they cost nothing and they did catch real supply-chain
configuration gaps — but they are not the check. `scripts/semgrep-rules.yml`
carries project rules for the sinks this codebase actually has, most written from
a real finding. Three more were written, run, and **removed** because they were
noisier than they were useful; the file records which and why.

Both scanners have a `selftest` mode, because on their first run here one of them
reported a clean repository while silently finding nothing at all — the report was
being written where it could not be read. A scanner that cannot be shown to catch
a planted secret is not evidence.

## Dynamic testing

ZAP 2.16.1 baseline, authenticated with a real session cookie, against the API in
the production-like stack: **65 passes, 0 failures**, two warnings, both since
addressed (L-2, and ZAP's own version).

One limitation, stated plainly: ZAP could not complete a TLS handshake with
Caddy's local certificate authority, so the scan ran against the API on the
container network rather than through the gateway. The gateway's own behaviour —
TLS, redirects, cookie flags, header stripping, identity reconstruction — is
covered instead by the 24 assertions in `./infra/verify-production-origin.sh`,
which do go through it. A public certificate would let ZAP take the same path.

## Deployment and CI configuration

- Nothing but the gateway is published in production; verified by asserting no
  host binding exists for postgres, questdb, grafana, telegraf, or the API.
- The API container does not run as root, and its uid is shared with Telegraf only
  because the rendered configuration is mode 0600 and Telegraf must read it.
- Secrets reach the container as a read-only bind mount, not environment
  variables, so they are not visible in `docker inspect`.
- The API image carries no npm, no TypeScript sources, and no test files.

**Revised 2026-08-10 — CI now exists and was reviewed.** Two workflows, both with
`permissions: contents: read` by default and widened per job only where needed:

- Every third-party action is pinned to a commit SHA, not a tag, because a tag is
  mutable and whoever owns it can change what runs.
- Only a `v*` tag starts the release workflow, so a pull request — including one
  from a fork — never receives the registry credential or reaches the signing
  identity. Publishing takes a tag; the release itself takes a person.
- Signing is keyless. The certificate comes from the workflow's OIDC identity, so
  there is no signing key stored anywhere to leak.
- The release gate runs every check against the tagged commit before anything is
  built, and refuses when the tag, `package.json`, the workspace packages, or the
  changelog disagree.
- Both workflows check out with `fetch-depth: 0` where they scan for secrets. A
  shallow clone has no history, and a history scan of nothing passes.

**Revised 2026-08-10 — the commit history is scanned.** This report originally
covered the working tree only, because there was no history to scan. gitleaks now
runs twice, and the second pass reads the commit graph: 24 commits, clean. Its
self-test commits a secret, deletes it, and requires the history pass to find what
the working-tree pass cannot — otherwise the second pass could be reading nothing
and reporting clean, which is how the first gitleaks integration failed.

## Release criteria

Derived from the threat model, and all currently met:

1. `corepack pnpm test:security` passes, and no route exists without a stated
   access level.
2. `./scripts/security-scan.sh` passes, including both self-tests.
3. `./scripts/scan.sh` reports no blocking advisory in code the project controls.
4. `./infra/verify-production-origin.sh` passes every assertion.
5. Every confirmed finding is fixed with a regression test, or accepted here with
   a reason and the condition that would reopen it.
6. No critical finding is open. C-1 was the only one, and it is closed.

## Residual risk

Carried from the threat model's accepted gaps, unchanged by this review:

- No bulk credential-key rotation; versioning exists and unavailable keys fail
  closed.
- Telegraf's remote-write listener is unauthenticated, relying on the container
  network boundary.
- The session cookie has no `__Host-` prefix, though it meets every condition.
- A monitored device can fill storage with high-cardinality interface names.
- Administrators are audited, not constrained.

Added by this review:

- A-1, schema validation before authentication.
- Dynamic testing has not been run through the gateway itself (see above).
- Semgrep's community coverage is weak enough that the project rules are doing
  nearly all of the static-analysis work; they cover known sinks, not unknown ones.

## Re-running all of it

```bash
corepack pnpm test:security          # 127 assertions, needs TEST_DATABASE_URL
corepack pnpm test                   # includes the fuzzing
./scripts/security-scan.sh           # SAST and secrets, with self-tests
./scripts/scan.sh                    # dependencies and every pinned image

# TLS, cookies, gateway, exposure — needs a running production-like stack
./infra/verify-production-origin.sh --env-file infra/.env.production --no-build
```
