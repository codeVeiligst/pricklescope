# External architecture, security, and release audit

Reviewed on 2026-08-11 against commit `f131d93f79a68c8c36197dba26d1817434bac2ba`
(`v0.1.2-1-gf131d93`).

## 1. Executive summary

**Verdict: `Conditional go`.** The repository is unusually complete for an AI-heavy first
release: builds, tests, deployment fixtures, security checks, backup restoration, SBOM
generation, and a million-row storage benchmark all succeeded. However, the release contains
several verified security and monitoring-correctness defects that should be fixed before broader
production use.

The five most important risks are:

1. Login throttling is bypassable by rotating an invalid session cookie.
2. OIDC role changes do not demote or promote existing users.
3. Grafana resources are adopted, modified, or deleted by mutable names rather than durable
   ownership identifiers.
4. Built-in health alerts frequently measure historical failure rather than current state.
5. The release scanner reports success despite fixed Critical vulnerabilities in runtime base
   images and excludes a runtime-installed Grafana plugin from the SBOM.

Strong aspects include the Postgres/QuestDB responsibility split, TypeBox contracts, encrypted
credential handling, CSRF/origin controls, constrained production network exposure,
restore-tested backups, meaningful integration/E2E coverage, pinned CI actions, and a clean
first-party API image.

Verified: all documentation, code inventory, build/lint/type/format/docs checks, 102 unit tests,
14 integration tests, 129 security tests, 57 E2E tests, container builds/runtime checks,
production-origin security fixture, dependency/security scans, restore testing, SBOM generation,
and a 1,000,000-row benchmark.

Not verified: deployment with the owner's private production configuration, real OIDC providers,
real SNMP fleets and legacy devices, sustained outage/soak behavior, disk-full recovery, external
GitHub protection settings, or the published registry artifacts themselves.

## 2. System overview

PrickleScope is a sensible single-node monitoring stack:

- **React/Vite web UI**, served by Caddy.
- **Fastify API/controller**, also running authentication, reconciliation, jobs, storage
  management, and Grafana provisioning.
- **Postgres** for users, sessions, desired configuration, jobs, audit records, and encrypted
  secrets.
- **Telegraf** for SNMP and ping collection, writing ILP into QuestDB.
- **QuestDB** for raw telemetry, aggregations, and controller-health history.
- **Grafana** for dashboards and alert evaluation, proxied through the application rather than
  embedded directly.
- Shared contract, database, adapter, and UI packages.

Primary flow:

`browser → Caddy → API/Postgres` for control-plane state, and
`device → Telegraf → QuestDB → Grafana/API` for telemetry.

Important trust boundaries are the browser/API session boundary, stored SNMP and notification
credentials, the API's Grafana administrator bootstrap credential, SNMP targets supplied by
operators, and third-party container/plugin supply chains.

## 3. Documentation-versus-implementation matrix

| Documented claim                                                  | Implementation evidence                                                         | Status                | Consequence                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| First release has not happened                                    | README and SECURITY still say pre-release, while tags and CHANGELOG reach 0.1.2 | **Contradictory**     | Operators cannot reliably determine support and release state              |
| Postgres owns desired state; QuestDB owns telemetry               | Separate Kysely schema/migrations and QuestDB management code                   | **Aligned**           | Clear persistence responsibility                                           |
| Hand-built Grafana resources are never overwritten or deleted     | Contact points and service accounts are found by name and then changed/deleted  | **Contradictory**     | User-owned Grafana resources can be adopted accidentally                   |
| Grafana is proxied, not embedded                                  | Caddy/API gateway and production-origin tests enforce the boundary              | **Aligned**           | Avoids many iframe/cookie/CORS problems                                    |
| OIDC groups map to application roles                              | Role is computed each login, but existing `users.role` is not synchronized      | **Partially aligned** | Removed administrators retain privileges                                   |
| Medium tier supports roughly 500 sources                          | Buffer is 10,000 metrics with zero collection or flush jitter                   | **Partially aligned** | A single synchronized poll can exceed the outage buffer                    |
| Health alerts detect dependencies staying down and silent sources | Queries use historical maxima and telemetry-only source discovery               | **Partially aligned** | Transient failures can alert after recovery; some silent sources disappear |
| Release gate repeats every PR check                               | Release workflow omits formatting, docs, E2E, and image runtime tests           | **Contradictory**     | A tag can publish code not subjected to the claimed gate                   |
| Restore procedure is executable                                   | Restore fixture passed all eight assertions                                     | **Aligned**           | Strong operational recovery baseline                                       |
| Storage retention is centrally managed                            | `controller_health` is omitted from managed raw-table lists                     | **Partially aligned** | Its TTL does not follow later policy changes                               |

## 4. Findings

### F1 — High / High confidence — Security

**Login throttling is bypassable with attacker-controlled cookies.**

Affected: `apps/api/src/app.ts:74`, `apps/api/src/auth/routes.ts:65`, and
`apps/api/tests/security/browser-protections.test.ts:266`.

Evidence: rate-limit keys use any raw session-cookie value before authentication verifies it. The
login route inherits this key and applies five attempts per key. A dedicated probe sent 20 invalid
logins with 20 invalid cookie values: all 20 returned `401`; none returned `429`.

Scenario and impact: an attacker rotates `pricklescope_session=fake-N` and performs effectively
unthrottled password guessing. Today this defeats an advertised security control; future internet
exposure materially increases credential-stuffing risk.

Remediation: key login and other unauthenticated routes solely by trusted client address. Use
session-based keys only after successful session validation. Add a regression test rotating
invalid cookies.

**Effort: Small.**

### F2 — High / High confidence — Authorization

**OIDC group changes do not update existing users' roles.**

Affected: `apps/api/src/auth/oidc.ts:147` and `apps/api/src/auth/store.ts:316`.

Evidence: each OIDC login computes `profile.role`. New users receive it, but the existing-user
update changes claims, email, display name, and last-login time without updating `users.role`.

Scenario and impact: a user removed from the IdP administrator group remains a PrickleScope
administrator indefinitely. Future centralized role governance will be unreliable.

Remediation: explicitly define whether IdP or local administration owns the role. If IdP-owned,
synchronize it during login, preserve last-administrator safeguards, revoke existing sessions,
and audit role changes. Test promotion, demotion, and removal from all mapped groups.

**Effort: Medium.**

### F3 — High / High confidence — Grafana/security

**Grafana reconciliation lacks durable resource ownership.**

Affected: `packages/adapters/src/grafana.ts:101`, `apps/api/src/grafana/service.ts:299`, and
`apps/api/src/alerts/service.ts:293`.

Evidence: the bootstrap service account is found by the fixed name `PrickleScope provisioning`
and changed to `Admin`. Contact points are located by name, overwritten, and later deleted using a
locally reconstructed registry identifier. Stable remote UIDs are not persisted as ownership
evidence.

Scenario and impact: an existing same-name service account or hand-created contact point can be
escalated, overwritten, or deleted. Renaming can also orphan the previous remote resource. This
contradicts the documented non-interference guarantee.

Remediation: persist remote IDs, add an immutable installation ownership marker, use create-only
semantics for bootstrap resources, refuse ambiguous name collisions, and cover
collision/rename/delete scenarios in integration tests.

**Effort: Medium–Large.**

### F4 — High / High confidence — Monitoring correctness

**Built-in health alerts model historical observations rather than current lifecycle state.**

Affected: `packages/adapters/src/alert-query.ts:130`,
`packages/db/migrations/010_health_alerts.ts:37`, and
`packages/adapters/src/health-alerts.test.ts:57`.

Evidence:

- `dependency_down` selects failures over a five-minute range and reduces them with `max`; a
  transient failure remains true long enough to satisfy the two-minute pending period after
  recovery.
- Collector-buffer alerting similarly evaluates historical maximum occupancy.
- `source_silent` discovers sources only from telemetry seen in the last 24 hours and groups by
  mutable `source_name`.
- Never-seen sources are invisible; renamed/deleted sources can become phantoms; a source silent
  for over 24 hours drops out entirely.

Scenario and impact: operators receive stale alerts, miss never-seen devices, or lose a
long-silent device from evaluation. Growth and rename/delete activity make this progressively
less predictable.

Remediation: query the latest dependency and buffer state; evaluate silence from active
desired-state inventory keyed by stable source ID; explicitly handle never-seen, renamed,
disabled, deleted, and long-silent sources. Add state-transition tests against QuestDB/Grafana.

**Effort: Medium–Large.**

### F5 — High / High confidence — Capacity/reliability

**The documented medium tier can overflow its collector buffer during a short outage.**

Affected: `infra/config/telegraf/telegraf.conf:5`, `packages/adapters/src/telegraf.ts:179`, and
`docs/operations.md:14`.

Evidence: the buffer is 10,000 metrics, while collection and flush jitter are both zero. The
documented 500-source/48-interface shape generates approximately 49,000 metrics per 60-second
poll—nearly five buffer capacities in one synchronized wave. The existing interruption exercise
covered only about five additional rows, not a tier-scale outage.

Scenario and impact: a brief QuestDB outage can drop samples before operators have time to react.
Synchronized polling also produces avoidable CPU, SNMP, network, and ingestion bursts.

Remediation: phase or jitter polls and flushes; size buffering from a stated outage RPO and actual
fleet shape, or add durable spooling. Test 100/500-source polling waves with QuestDB unavailable
and verify loss/recovery behavior.

**Effort: Medium; durable queuing would be Large.**

### F6 — High / High confidence — Supply chain/release security

**The scan gate reports “clean” while exempting fixed Critical runtime vulnerabilities.**

Affected: `scripts/scan-report.py:44`, `scripts/scan.sh:1`, `infra/compose.yaml:104`, and
`scripts/sbom.sh:1`.

Evidence: the policy treats OS, Go binary, JAR, Python, and gem findings in third-party images as
inherited and nonblocking. The current run passed despite fixed Critical findings including
CVE-2025-68121 in Postgres and CVE-2026-49980 in Telegraf, plus numerous High findings. Grafana
also downloads `questdb-questdb-datasource@0.1.8` at runtime, after the image has been scanned and
its SBOM generated.

Scenario and impact: releases can remain green with actionable Critical runtime vulnerabilities,
while the deployed Grafana plugin is absent from both vulnerability evidence and the release
SBOM.

Remediation: require per-CVE triage; fail fixed High/Critical runtime findings unless covered by
explicit, dated exceptions. Bake the Grafana plugin into a derived image, verify it, and scan/SBOM
the actual immutable runtime image. Retain JSON reports as release artifacts.

**Effort: Medium.**

### F7 — Medium / High confidence — CI/CD

**The release gate does not run every check it claims to run.**

Affected: `.github/workflows/ci.yaml:54`, `.github/workflows/release.yaml:60`, and
`docs/releasing.md:75`.

Evidence: PR CI runs format, docs, browser E2E, and image runtime checks. The tag release gate
omits them while stating it repeats every PR check. Whether repository branch protection
compensates externally could not be verified.

Scenario and impact: a directly tagged commit can publish with broken docs, formatting, E2E
behavior, or runtime image startup.

Remediation: move verification into a reusable workflow invoked by both CI and release, or
require successful CI for the exact tagged SHA. Build once and promote/scan/sign those same
digests.

**Effort: Medium.**

### F8 — Medium / High confidence — Availability

**Cold startup blocks the controller on Grafana and QuestDB health.**

Affected: `infra/compose.production.yaml:46`.

Evidence: API startup depends on Postgres, QuestDB, and Grafana being healthy; the web service
then waits for API health.

Scenario and impact: after a restart during a Grafana or QuestDB outage, the UI and controller
never start, so users cannot view the degraded health the application is designed to report.

Remediation: hard-depend only on indispensable metadata storage. Start API/web in degraded mode
with retrying dependency clients, while distinguishing liveness from readiness.

**Effort: Small–Medium.**

### F9 — Medium / High confidence — Collector correctness

**A generated collector configuration is marked active before Telegraf proves it adopted it.**

Affected: `apps/api/src/collectors/service.ts:241` and
`apps/api/src/collectors/publisher.ts:7`.

Evidence: the API atomically publishes the file and immediately advances database state. Health
monitoring checks Telegraf reachability, not its loaded configuration hash or successful reload.
“Pending” compares generated content with database state rather than actual runtime state.

Scenario and impact: Telegraf can reject or fail to reload a file while the UI reports
configuration as current.

Remediation: validate generated files with the pinned Telegraf binary, observe reload success and
an applied revision/hash before activation, and retain/restore the previous known-good revision
on failure.

**Effort: Medium.**

### F10 — Medium / High confidence — Data lifecycle

**`controller_health` is outside normal QuestDB retention management.**

Affected: `apps/api/src/storage/questdb.ts:27`, `apps/api/src/storage/questdb.ts:152`, and
`apps/api/src/storage/questdb.ts:367`.

Evidence: the table is created with an initial TTL but omitted from `rawTables` and
`managedTables`. Later retention changes do not update it, and storage status does not report it.

Scenario and impact: operators believe retention policy applies uniformly while controller-health
data retains the original setting.

Remediation: add it to the managed raw-table inventory and test policy changes and status
reporting.

**Effort: Small.**

### F11 — Medium / High confidence — Runtime reliability

**Background job failures can become unhandled promise rejections.**

Affected: `apps/api/src/jobs/runner.ts:26` and `apps/api/src/jobs/runner.ts:54`.

Evidence: interval ticks are invoked with `void` and no terminal catch. Job promises and their
derived `finally()` promises are similarly discarded. If claiming a job or recording failure
itself rejects, there is no top-level containment or backoff.

Scenario and impact: a temporary Postgres failure can create unhandled rejections and potentially
terminate or destabilize the API process.

Remediation: give every fire-and-forget entry point a final catch/log path, apply bounded backoff,
and test claim/complete/fail-store outages.

**Effort: Medium.**

### F12 — Medium / High confidence — SNMP compatibility

**Interface collection lacks Counter32 fallback.**

Affected: `packages/adapters/src/telegraf.ts:225` and `packages/adapters/src/snmp.ts:150`.

Evidence: discovery tolerates devices without `ifXTable`, but generated collection uses only
`ifHCInOctets` and `ifHCOutOctets`. Legacy agents exposing only `ifInOctets`/`ifOutOctets` can be
discovered successfully yet produce no interface traffic measurements.

Scenario and impact: apparently supported devices show interfaces but silently lack rate graphs.

Remediation: add an explicit Counter32-compatible profile/fallback, handle wraps according to
interface speed and interval, and test against a legacy SNMP fixture.

**Effort: Medium.**

### F13 — Medium / High confidence — Documentation/provenance

**Authoritative release and assurance documentation is internally inconsistent.**

Affected: `README.md:78`, `SECURITY.md:17`, `docs/implementation.md:1`,
`docs/security/verification.md:3`, and `CHANGELOG.md:57`.

Evidence: documents still describe the project as unreleased, contain conflicting milestone
states and stale architecture decisions, and report old test counts. The security verification
document names a commit that no longer resolves after history rewriting. CHANGELOG records that
older tags no longer match published-image commits.

Scenario and impact: operators cannot reproduce historical assurance claims or confidently
identify which evidence applies to 0.1.2.

Remediation: generate a single release/status block from package/tag metadata; publish
verification results for every release with exact commit and image digests; never rewrite
released history again. Document older provenance as permanently incomplete.

**Effort: Medium.**

### F14 — Medium / High confidence — Accessibility

**Accessibility remains an explicitly unmeasured release limitation.**

Affected: `CHANGELOG.md:50` and `apps/web/tests/`.

Evidence: the 0.1.2 notes explicitly removed the WCAG audit. Responsive E2E checks cover
horizontal overflow, but there is no systematic axe, keyboard, focus-order, contrast, or
reduced-motion verification.

Scenario and impact: keyboard or low-vision users may be unable to complete administrative
workflows; regulated or procurement-sensitive deployments cannot rely on an accessibility claim.

Remediation: add automated axe smoke tests plus manual keyboard, focus, contrast, zoom, and
reduced-motion review before declaring a conformance target.

**Effort: Medium.**

### F15 — Low / High confidence — Frontend robustness

**API responses have compile-time types but no runtime validation or root error boundary.**

Affected: `apps/web/src/api.ts:60`, `apps/web/src/main.tsx:13`, and `apps/web/src/app.tsx:49`.

Evidence: parsed JSON is cast to generic response types without schema validation, and no root
React error boundary contains unexpected rendering failures.

Scenario and impact: version skew, proxy-generated JSON, or malformed response fields can turn a
localized API failure into a blank or broken screen.

Remediation: validate critical responses using shared schemas and add a root error boundary with
recovery/reporting behavior.

**Effort: Small–Medium.**

## 5. Architecture assessment

For the current release, the monorepo and six-container topology are appropriate. The
Postgres/QuestDB split is clear, shared contracts reduce accidental API drift, Grafana has a
distinct visualization role, and keeping the controller and jobs in one API process reduces
premature distributed-system complexity.

The first scaling limits are the single Telegraf collector, local-file configuration publication,
volatile buffering, synchronized polling, API cold-start coupling, and Grafana reconciliation by
names. These should be addressed before claiming the documented medium tier or adding multiple
collectors.

PrickleScope should deliberately remain single-tenant and single-site for now. Kafka, generalized
plugin frameworks, service decomposition, multi-region HA, and arbitrary dashboard abstraction
would add more operational risk than value until real fleet behavior demands them.

## 6. Risk register

| Risk                                  | Likelihood      | Impact | Detection                                  | Mitigation                                 | Trigger for action                  |
| ------------------------------------- | --------------- | ------ | ------------------------------------------ | ------------------------------------------ | ----------------------------------- |
| Login throttle bypass                 | High            | High   | Security regression test/log-rate analysis | Trusted IP key for public routes           | Immediate                           |
| Stale OIDC administrator role         | Medium          | High   | Compare IdP groups with local role         | Login-time synchronization and audit       | Before relying on OIDC              |
| Grafana ownership collision           | Medium          | High   | Reconciliation audit/dry run               | Persist remote IDs and ownership markers   | Before managing existing Grafana    |
| Incorrect health alerts               | High            | High   | Lifecycle integration tests                | Latest-state and desired-inventory queries | Before calling alerting dependable  |
| Collector buffer overflow             | Medium          | High   | Dropped-metric and buffer metrics          | Jitter, sizing, durable spool              | Before 100–500-source fleets        |
| Vulnerable/unscanned runtime contents | Medium          | High   | Blocking scan and immutable SBOM           | Derived images and exception policy        | Every release                       |
| Job runner rejection                  | Medium          | Medium | Process rejection telemetry                | Terminal catches and backoff               | Before unattended operation         |
| Cold-start dependency deadlock        | Medium          | Medium | Dependency-outage restart drill            | Degraded startup                           | Before stronger availability claims |
| Broken historical provenance          | Already present | Medium | Tag/digest verification                    | Immutable future releases                  | Every future tag                    |

## 7. Test-gap analysis

Highest-priority missing tests:

1. Rotate invalid session cookies during failed login and require `429`.
2. Exercise OIDC promotion, demotion, group removal, and session revocation.
3. Seed same-name Grafana service accounts/contact points; verify reconciliation refuses ownership
   collisions.
4. Evaluate health-alert state sequences: failure/recovery, never-seen source, rename,
   disable/delete, and silence beyond 24 hours.
5. Stop QuestDB under 100- and 500-source simulated poll waves; measure dropped samples and
   recovery.
6. Publish an invalid/rejected Telegraf revision and verify it never becomes active.
7. Fail job claim/complete/fail database calls and assert no unhandled rejection or tight retry
   loop.
8. Collect from a fixture exposing only IF-MIB Counter32 counters.
9. Restart the production topology with Grafana and QuestDB unavailable.
10. Add accessibility automation and manual keyboard/focus coverage.
11. Add disk-full, long soak, out-of-order ingestion, and multiple-collector collision tests before
    scaling.

## 8. Release recommendation

**Classification: `Conditional go`**, interpreted retrospectively because 0.1.2 is already
released.

Mandatory before broader production promotion or the next security patch:

- Fix login rate-limit keying.
- Define and enforce OIDC role ownership/synchronization.
- Prevent Grafana adoption by mutable name.
- Triage current fixed High/Critical runtime vulnerabilities and include the Grafana plugin in the
  immutable scanned artifact.
- Correct the built-in health-alert semantics, or clearly mark/disable those alerts until
  corrected.

Safe post-release improvements:

- Degraded startup.
- Telegraf reload acknowledgement.
- Job-runner rejection containment.
- `controller_health` retention management.
- CI/release workflow unification.
- Runtime frontend validation and error containment.

Reasonable deferrals for a controlled small deployment:

- Multi-tenancy and horizontal HA.
- Durable distributed queuing.
- Multiple collectors.
- Large-fleet optimization beyond measured needs.
- A formal WCAG conformance claim, provided the limitation remains explicit.

## 9. Prioritized roadmap

### Before first release — now an urgent pre-next-release list

- Patch F1, F2, and F3.
- Triage F6 and publish immutable scan/SBOM evidence.
- Correct or feature-label F4.
- Add focused regression tests for each.

### First 30 days

- Add Telegraf configuration acknowledgement.
- Contain job-runner failures.
- Permit degraded API/web startup.
- Fix `controller_health` retention.
- Reconcile release documentation and publish a new exact-SHA verification report.
- Begin the accessibility baseline.

### Before scaling

- Add polling/flush jitter and evidence-based buffer sizing.
- Perform outage/soak tests at documented fleet sizes.
- Add Counter32 support.
- Introduce stable collector ownership and duplicate-poll prevention.
- Define explicit telemetry-loss and recovery objectives.

### Later / optional

- Multi-collector coordination and HA.
- Multi-tenancy.
- External durable queues if measured outages justify them.
- More aggressive frontend code splitting; the current build produced a 550.72 kB minified main
  chunk warning.

## 10. Validation appendix

| Validation                                 | Result                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm build`                               | Passed; Vite emitted the 550.72 kB chunk warning                                                         |
| `pnpm lint`                                | Passed                                                                                                   |
| `pnpm format:check`                        | Passed                                                                                                   |
| `pnpm typecheck`                           | Passed                                                                                                   |
| `pnpm docs:check`                          | Passed: 87 links, 10 scripts, 38 documented commands                                                     |
| `pnpm test`                                | Passed: 102 unit tests                                                                                   |
| `pnpm test:integration`                    | Passed: 14 tests                                                                                         |
| `pnpm test:security`                       | Passed: 129 tests                                                                                        |
| `pnpm test:e2e`                            | 57 passed; 6 screenshot-generation cases intentionally skipped                                           |
| `scripts/security-scan.sh`                 | Passed; Semgrep and gitleaks clean, two allowed package-age findings                                     |
| `scripts/scan.sh`                          | Policy passed, but exposed the inherited-vulnerability policy problem described in F6                    |
| Six container builds/runtime smoke tests   | Passed                                                                                                   |
| Production-origin fixture                  | 24/24 passed, including TLS, headers, cookies, CSRF, origin, Grafana proxy, and spoofing checks          |
| `scripts/prod-up.sh --check`               | Prerequisites passed; actual start stopped as expected because private `infra/.env.production` is absent |
| Backup and restore test                    | 8/8 passed; encrypted secrets, 524,883 QuestDB rows, four dashboards, six rules restored                 |
| Storage benchmark                          | 1,000,000 rows; ~2.46M rows/s ingestion; raw query 289.73 ms, 5m 77.87 ms, 1h 30.09 ms                   |
| SBOM generation                            | Passed: API 131, web 180, Postgres 51, QuestDB 113, Telegraf 599, Grafana 800 components                 |
| Release-note generator/gate                | Passed for current 0.1.2 metadata                                                                        |
| Dynamic cookie-rotation probe              | Verified F1: 20 × `401`, 0 × `429`                                                                       |
| Git cleanliness before writing this report | Clean; no repository files were changed by the review                                                    |

The initial unit/integration attempts could not bind local ports inside the restricted sandbox;
approved reruns against the isolated local test services passed. `shellcheck` was unavailable, so
the documentation check used Bash syntax validation. Temporary backup, benchmark, and SBOM review
artifacts were removed after validation.

## Three highest-leverage next actions

1. Ship a focused security patch for login throttling and OIDC role synchronization, with
   adversarial regression tests.
2. Replace name-based Grafana reconciliation with durable ownership/remote IDs before it touches
   existing operator-managed Grafana instances.
3. Make the release artifact truthful and immutable: bake the Grafana plugin, scan/SBOM the actual
   runtime images, block unexcepted fixed High/Critical findings, and run one reusable CI gate for
   the exact released SHA.
