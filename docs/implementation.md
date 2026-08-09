# PrickleScope Implementation

Status: Active  
Last updated: 2026-08-07  
Architecture: Accepted baseline in [architecture.md](architecture.md)

## Purpose

This is the implementation source of truth. The architecture document explains
what the system should become; this document records the order of work, current
decisions, acceptance criteria, and verified progress.

Update this document whenever a milestone starts, a decision changes, or an item
is verified complete. An item is complete only when its acceptance criteria have
been exercised, not merely when files exist.

## Status conventions

- `[ ]` Not started
- `[~]` In progress or implemented but not verified
- `[x]` Verified complete
- **Proposed**: current preference that may still change
- **Accepted**: decision used for implementation; changing it requires updating
  the decision log and affected work

## Current focus

Milestones 0 through 5 are verified complete.

PrickleScope draws its own graphs and never embeds Grafana in the page (D-019).
Grafana remains a visualization engine of the system rather than a fallback: it
carries at least every graph PrickleScope draws and usually more, with the same
series colours pinned on both sides (D-020). Fleet and source-detail panels are native,
and the device inventory table draws a per-interface traffic graph on its own line
under each row. Interface detail and pipeline health are deliberately left to
Grafana behind a deep link.

Milestone 6 is largely implemented and verified against the live stack: rules and
contact points are controller-owned desired state, reconciled into Grafana, which
evaluates them and delivers the notification. Two items remain open — the in-app
test notification is sent by the controller rather than by Grafana, because
Grafana 13.1.0's replacement endpoint is unusable, and mute timings are deferred.

Milestone 9 is complete: the threat model's findings are now executable tests,
the application is assessed against OWASP ASVS 5.0 and the API Security Top 10,
and [security/verification.md](security/verification.md) records the tools,
findings, release criteria, and residual risk. It found one critical defect —
naming a source could execute code on the collector host — and three high ones.
Six items are partial for reasons that reduce to "there is no Git repository or CI
yet", which Milestone 11 supplies.

Milestone 10 is complete: the documentation is a tree behind an index, the README
is a product introduction with generated screenshots and an explicit AI
disclosure, the licence is AGPL-3.0, and both startup workflows exist — the
production one refusing to start on a development password or the published
encryption key.

Milestone 8 is in progress. Seven of eleven items are verified complete: the
threat model, secure-cookie and HTTPS behaviour against a production-like origin,
the vulnerability scans, the sub-400px audit, tested restore procedures, and —
closed in Milestone 10 — upgrade documentation and deployment sizing. Building
the origin required the same-origin production gateway (D-032), so that is now an
artifact rather than an open selection. Four items remain: health dashboards and
alerts, end-to-end coverage of the primary journeys, the accessibility audit, and
task-based usability tests.

## Decisions

| ID    | Decision                                                                                        | Status     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-001 | Grafana owns visualization, alert evaluation, and notification routing                          | Accepted   | It is the fixed product integration and avoids rebuilding dashboard and alert engines. Clarified on 2026-08-06: D-019 added the controller's own in-product graphs, but it did not take visualization away from Grafana. Grafana still carries at least every graph PrickleScope draws and usually more; PrickleScope is simply where a user looks first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D-002 | QuestDB is the initial metrics store                                                            | Accepted   | Exact Counter64 ingestion, reset-aware rates, tiered TTL, rollups, representative load, buffered recovery, and OSS restore all passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D-003 | Telegraf is the first collector and Alloy support follows                                       | Superseded | Telegraf gives the shortest path to SNMP and QuestDB; Alloy requires a Remote Write relay and normalization tests. Superseded by D-024: Alloy support is not built at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-004 | Use TypeScript for controller application code                                                  | Accepted   | Shared types and schemas span the frontend, API, reconciler, and adapters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-005 | React with Vite plus a Fastify API and reconciler                                               | Accepted   | The UI is an authenticated administration SPA, while reconciliation and network jobs are long-running backend work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D-006 | PostgreSQL is the application metadata database                                                 | Accepted   | Users, sessions, jobs, audit events, desired state, migrations, and concurrency need a conventional server database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-007 | Support local accounts and OIDC                                                                 | Accepted   | A bootstrap/recovery local administrator and standards-based SSO cover small and centrally managed installations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D-008 | Fastify owns QuestDB access                                                                     | Accepted   | The browser must not receive database credentials; server-side PGWire supports parameterized queries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D-009 | Embed authenticated Grafana panels through a same-origin gateway                                | Accepted   | Users get graphs in context without anonymous access, URL tokens, or a second visible login flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D-010 | Do not repeat navigation labels as visible page titles                                          | Accepted   | Active navigation and document metadata already provide generic page context; visible headings must add information.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-011 | Run SNMP inventory as persisted background jobs                                                 | Accepted   | Inventory can be slow or partial and must not block API requests or become continuous measurement polling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-012 | Use Node 24 LTS, pnpm 11, Kysely, and a SQL-backed job runner                                   | Accepted   | The selected foundation is version-locked, typed end to end, and verified against PostgreSQL and Chromium.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-013 | Encrypt controller credentials with per-record AES-256-GCM                                      | Accepted   | Authenticated encryption, record-bound AAD, a versioned external key, and write-only API fields keep secrets outside normal metadata flows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-014 | Re-evaluate account state on every session request                                              | Accepted   | Role/status changes take effect immediately; sensitive changes revoke sessions and self-lockout safeguards preserve administrator access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D-015 | Store GUI-managed OIDC settings encrypted in PostgreSQL                                         | Accepted   | PostgreSQL is the sole provider authority; configuration applies without an API restart and secrets never enter environment files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D-016 | Model sites as a cycle-safe arbitrary-depth tree                                                | Accepted   | Real environments need reusable campus/building/floor or region/site groupings without hard-coding those levels or changing device IDs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D-017 | Embed Grafana as server-rendered images, never an iframe                                        | Superseded | Replaced by D-019 the same day. Removing the iframe removed Grafana's chrome but not its identity: OSS cannot drop the "Powered by Grafana" watermark, and each image still carried Grafana's own panel title and typography.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D-018 | Use `localhost` for every development URL and origin                                            | Accepted   | A `127.0.0.1` app origin against a `localhost` browser URL fails the origin guard; one spelling keeps the API, Vite, and browser tests in agreement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-019 | PrickleScope draws its own graphs; Grafana keeps a superset of them                             | Accepted   | The product's screens carry no third-party chrome, branding, or fonts, and graphs are interactive and theme-aware. Grafana is not demoted to a fallback: it stays a visualization engine of the system and carries at least every graph PrickleScope draws, usually more, including panels the controller does not attempt at all (interface detail, pipeline health). The invariant is one-directional — Grafana may lead in coverage, never trail — so a native panel is never added without its Grafana counterpart. Cost: the controller now owns in-app charting, softening the "Grafana visualizes" split in principle 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D-020 | Series colours are Cacti green/blue, theme-tuned, with inbound filled and outbound a line       | Accepted   | Green/blue is the pair operators already read from Cacti and MRTG, and separates about twice as well as Grafana's green/yellow under red/green colour deficiency (ΔE 23.6 against 9.9). Drawing inbound as an area under an outbound line encodes direction by shape as well as hue, so the pair survives without colour and two fills never overlap into a muddy band. Light and dark carry separate steps because one list cannot clear the contrast floor on both surfaces. The managed Grafana dashboards pin the same values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D-021 | Grafana evaluates threshold rules; PrickleScope owns their desired state and shows their status | Accepted   | QuestDB has no user-defined alerting to delegate to — its only alerting ships QuestDB's own CRITICAL log lines to Alertmanager — so the real choice was Grafana or a controller-side evaluator. Alert semantics are stateful and safety-critical: pending duration, hysteresis, No Data versus Error, flapping, dedup, silences, and delivery retries are exactly what is easy to get subtly wrong, and a missed alert is a worse failure than an ugly graph. This is the asymmetry that made owning charting (D-019) reasonable and owning evaluation not. Revisit if Grafana ever stops being permanent infrastructure; migration cost grows with every provisioned rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-022 | Notifications are delivered over HTTP only; SMTP is not supported                               | Accepted   | Many deployments have no SMTP relay Grafana can reach and send mail through a provider API instead; the owner ruled SMTP out entirely. Both contact-point kinds are therefore HTTP: a webhook posts to the operator's own endpoint, and email goes through a mail provider's API. Grafana's own `email` receiver is never provisioned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D-023 | PrickleScope delivers email itself; Grafana still evaluates and routes                          | Accepted   | Grafana's webhook receiver posts one fixed JSON shape, which no mail API accepts: Gmail takes only a base64url RFC-2822 blob, Mailgun only form encoding, and Graph and Gmail need an OAuth exchange first. Grafana can neither assemble those nor hold the refresh token. So an email contact point is provisioned as a webhook aimed back at `/api/v1/alerts/notify/{ref}` with a generated bearer token, and the controller renders and sends the message through the operator's provider. This partially reverses D-021 for delivery only — evaluation, routing, grouping, and dedup stay in Grafana. Cost: Grafana must be able to reach the API, which the reconcile checks and refuses to fake, and delivery outcome now lives in controller state rather than Grafana's.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-024 | Milestone 7 (Alloy adapter) is dropped, not deferred                                            | Accepted   | Telegraf covers every collection case the product currently needs, and a second collector doubles the desired-state surface: two renderers, two revision histories, and a duplicate-ownership rule to keep them from polling the same device twice. The Alloy container, its configuration, and its health probe are removed with it — a service nothing collects through is cost without benefit, and a health check for it would report a dependency the product no longer has. What remains is the seam: `collector_selection` still accepts a kind, the capability endpoint still advertises Alloy as unavailable with the reason, and Telegraf still exposes the Prometheus Remote Write listener. So this is reversible if a Prometheus-only exporter ever forces it. Cost: no Prometheus-native collection until then.                                                                                                                                                                                                                                                                                                                                                                                                       |
| D-025 | Reconciled engines report their own drift; one control applies them all                         | Accepted   | The controller owns desired state and the engines hold applied state, so the two diverge the moment anything is edited — previously visible only per screen, or not at all until an alert failed to fire. Each domain answers for itself by comparing what it _would_ write against what it last wrote (a rendered config hash, resource hashes, per-rule revisions, an applied marker), never by inferring from timestamps, so "up to date" means the artifact is identical. Applying is a set of jobs like every other reconcile. Cost: the collector probe renders the candidate configuration on every poll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-026 | Navigation groups by what you look at, what you configure, and who may do it                    | Accepted   | Workspace held both daily screens and setup screens, so Devices sat beside Storage. Splitting configuration into its own group leaves Workspace as the four screens an operator opens daily. Credentials moved out of System into Settings but keeps its administrator gate — placement is about meaning, authorization is separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D-027 | The controller-owned identifiers are `pricklescope`, with no `modern_cacti` left anywhere       | Accepted   | The working name survived in the Postgres database and role, the Compose project (and therefore every volume and container name), and the development passwords. Renaming was done in place — `ALTER DATABASE`/`ALTER ROLE` and a volume copy — so no metrics history or Grafana state was lost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-028 | The development webhook sink is removed with Alloy                                              | Accepted   | It was kept on the belief that the end-to-end suite needed it; the suite only types the URL into a form and never asserts delivery, which was proven by running all 14 tests with the sink stopped. A container nothing depends on is cost without benefit. Hand-testing a webhook now points at any endpoint the operator already has. The production overlay no longer needs a rule to strip it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D-029 | Destructive actions confirm in an application dialog, never `window.confirm`                    | Accepted   | The browser dialog cannot be styled or themed, fits one line, and cannot name the consequence — so every prompt read "Remove X?" with no statement of what is lost. `useConfirm` keeps the same one-line call shape while the dialog matches every other surface, names the action on its button instead of "OK", and marks destructive ones. Cost: seven pages now render a dialog node; the e2e suite drives the real dialog instead of accepting a browser one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D-030 | Contacts are a screen under Settings, and are called contacts in the UI                         | Accepted   | Alerts carried two unrelated lists, so the page had to invent section headings that restated the navigation. A contact outlives any one rule and is configuration, so it belongs beside the other configuration screens. The UI says _contact_; the API, database, and Grafana keep _contact point_, which is Grafana's own term for the resource being provisioned — renaming the wire and the schema would be a migration bought for nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D-039 | Plugins ship with the product; user-authored plugins are a later question                       | Accepted   | The working notes rule out arbitrary user-authored collector configuration in the first release, and a plugin that is really a fragment of Telegraf config would be exactly that — with the added problem that the renderer's output allowlist (D-034) is what stands between a definition and command execution on the collector host. So the first cut ships a built-in catalogue, validated by the controller, with a manifest shape deliberately good enough for third-party definitions later. Cost: adding a measurement means a release, which is the wrong answer for anyone with an unusual device, and the pressure to relax this will arrive immediately. Revisit once the manifest has survived a few real plugins and the validation story is proven, not before.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D-038 | _plugin_ replaces _input_ in the glossary                                                       | Accepted   | The destination is user-authored plugins (D-039 defers them, it does not rule them out), and "input" is the wrong word for something a user writes and installs — it would have to be renamed the moment that lands. Plugin takes the glossary slot that input held: a plugin is the collection mechanism, a _check_ is still a plugin applied to a source. This costs nothing to adopt, which is why it is worth doing now: "input" never reached the interface, because with one implicit SNMP check per source no screen ever had to name the mechanism. The word only exists in CLAUDE.md and in Telegraf's own `[[inputs.*]]` tables, which stay as they are — that is Telegraf's vocabulary, not the product's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D-037 | One QuestDB table per plugin                                                                    | Accepted   | A columnar store rewards a table whose columns are known, and the product's existing strengths — per-table TTL, per-tier materialized views, the retention reconciler — all work per table and would have to be rebuilt for a single long `plugin_metric` table keyed by measurement name. The long shape never needs migrating; that is its only advantage, and it is bought by giving up rollups that can differ per measurement. Cost, and it is not small: the schema grows with the catalogue, a plugin that changes its measurement set in a later version needs a migration of the metrics store, and once user-authored plugins arrive (D-039) a plugin definition becomes something that creates a table — which is a privilege boundary that does not exist today and will need one.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D-036 | Telegraf executes every transport; the controller never collects                                | Accepted   | REST and GraphQL are tempting to fetch from the controller — the code is a `fetch` call and the data is right there. That would make the controller a collector, which the working notes explicitly rule out ("recurring monitoring remains collector work"), and would put a per-source polling loop inside the process that also serves the API. Telegraf's `inputs.http` with a JSON parser covers both transports, keeps one collection runtime, and means plugin collection inherits the buffering, retry, and rate derivation that already exist. Cost: a plugin can only ask for what Telegraf can express, so a transport needing bespoke client logic — a device with a stateful session, say — does not fit and would force this decision open again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D-035 | Static analysis is project rules first, community rulesets second                               | Accepted   | The free Semgrep registry is close to inert on this codebase: seventy-nine rules from `p/typescript`, `p/nodejs`, and `p/owasp-top-ten` ran against a file containing `eval(userInput)`, a shell injection, and `rejectUnauthorized: false` and reported nothing, and `p/security-audit`, `p/javascript`, and `p/command-injection` reported nothing either. They still run, because they cost nothing and did catch real supply-chain configuration gaps, but they are not the check. `scripts/semgrep-rules.yml` carries rules for the sinks this codebase actually has, most written from a finding: unquoted interpolation into rendered TOML, subprocesses, dynamic evaluation, TLS bypass. Three more were written, run, and removed for matching a benchmark CLI, a constant table list, and every deliberately public route — each duplicated a runtime test that proves the property properly, and a rule that cries wolf is one people learn to skip. Both scanners also carry a self-test, because on their first run one of them reported a clean repository while finding nothing at all. Cost: the rules cover known sinks, not unknown ones, so they need extending whenever a new kind of generated output appears. |
| D-034 | Generated artifacts are defended at four layers, not one                                        | Accepted   | A source name reached a TOML comment unquoted, and because a newline ends a comment, naming a source `Evil\n[[inputs.exec]]\n  commands = [...]` rendered a Telegraf input that runs commands — operator-level remote code execution on the collector host. One escape function would have fixed that instance. Four things now have to fail together: the contracts reject control characters, `validateTelegrafDesiredState` rejects them again before rendering, `comment()` strips them from the one unquoted position, and `validateTelegrafCandidate` refuses any rendered table the renderer cannot itself emit. That last one is the important one — it does not depend on knowing which field was unsafe, so it catches the next sink as well as this one. The same shape applies wherever the controller generates an artifact another engine executes. Cost: four places to keep in step, and a rendering path that can refuse data already in the database.                                                                                                                                                                                                                                                             |
| D-033 | Vulnerability scanning fails only on what the project can change                                | Accepted   | A check that cannot be made to pass is a check that gets ignored. Most findings against the stack are Go standard-library or Alpine CVEs compiled into Grafana, Telegraf, QuestDB, Postgres, and Caddy: the remedy is not a code change but a newer pin, once the maintainer publishes one. So `scripts/scan.sh` blocks on the dependency graph and on packages the project installs, and reports base-image and third-party-binary findings with a count instead. They stay visible — a pin that has fallen behind shows up immediately — without turning the check permanently red. An advisory that is genuinely inapplicable goes in `scripts/scan-exceptions.txt` with its reasoning and the condition that would make it apply again; the file currently holds one, React Router's RSC-mode CSRF bypass, which needs a data router the application does not use. Cost: a base-image CVE does not stop a release on its own, so the pin review in the upgrade procedure has to be done rather than assumed.                                                                                                                                                                                                                    |
| D-032 | The production origin is Caddy, and `/grafana` goes through the API rather than to Grafana      | Accepted   | The same-origin gateway was the last unbuilt piece of the deployment model, and secure-cookie behaviour cannot be verified without one. Caddy was chosen over nginx for automatic certificates — a real one over ACME, a local-CA one for `localhost`, chosen by the site address alone with no second switch — and for a configuration short enough to read in one screen. The gateway terminates TLS, serves the built SPA, and routes `/api`, `/health`, and `/grafana` to Fastify. `/grafana` deliberately does not go straight to Grafana: the API is what checks the session and reconstructs the Auth Proxy identity headers, so pointing the gateway at Grafana would bypass the only thing that makes that traffic safe. Caddy still strips inbound identity headers itself, so neither guard stands alone. Grafana, QuestDB, PostgreSQL, and Telegraf are unpublished in production. Cost: one more pinned image, and the API and Telegraf containers must share a uid because the rendered collector configuration is mode 0600.                                                                                                                                                                                         |
| D-031 | The TypeScript counter-normalisation module is removed, not kept as a reference                 | Accepted   | Production derives counter rates in Telegraf's Starlark processor; the TypeScript `normalizeCounterSeries` was a parallel implementation nothing ever called, exercised only by its own unit test. A second implementation that never runs cannot drift _into_ production, but its green test implies coverage of a path it does not touch — false confidence is worse than none. The rollover, reset, reboot, and discontinuity semantics stay documented in storage-spike.md and in the Starlark itself, which is what the spike verified live against QuestDB. Reversible: the module is one file if a controller-side normaliser is ever needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Accepted controller stack

The initial repository layout will be:

```text
apps/
  web/          React and Vite administration SPA
  api/          Fastify API, authentication, jobs, and initial reconciler
packages/
  contracts/    Shared schemas and API types
  db/           Metadata schema and migrations
  adapters/     Telegraf, Alloy, QuestDB, and Grafana adapters
  ui/           Shared application UI primitives
```

The Vite application and API are separate build units. Production exposes one
origin: a web gateway serves the SPA, routes `/api` to Fastify, and proxies
session-checked `/grafana` traffic to Grafana. Background modules start in the API
process initially but can become a separate worker without moving business logic.

Milestone 1 uses Node.js 24.19, pnpm 11.20, Kysely 0.29, a small SQL-backed job
runner, TypeBox contracts, Tailwind CSS 4 plus project-owned UI primitives, and
the current Fastify and React 19 releases locked in `pnpm-lock.yaml`. The
production same-origin gateway remains a later implementation selection.

## Milestone overview

| Milestone                           | Outcome                                                                 | Status      |
| ----------------------------------- | ----------------------------------------------------------------------- | ----------- |
| 0. Development infrastructure       | Reproducible local standard services                                    | Complete    |
| 1. Controller foundation            | UI/API skeleton, authentication, metadata migrations, and health        | Complete    |
| 2. Source and credential management | GUI-managed devices, credentials, profiles, and tests                   | Complete    |
| 2.1 User and identity management    | GUI-managed users, roles, passwords, access, and sessions               | Complete    |
| 2.2 OIDC provider management        | GUI-managed discovery, secrets, mappings, and activation                | Complete    |
| 3. Telegraf reconciliation          | Generated configuration with safe apply and rollback                    | Complete    |
| 4. QuestDB storage spike            | Schema, counters, TTL, rollups, and recovery proven                     | Complete    |
| 4.1 Site hierarchy                  | Cycle-safe nested sites and subtree graph scope                         | Complete    |
| 5. Grafana integration              | Native graphs plus matching provisioned Grafana dashboards              | Complete    |
| 6. Threshold alerting               | GUI rules reconciled into Grafana and notifications proven              | In progress |
| 7. Alloy adapter                    | Dropped (D-024); Telegraf covers the supported inputs                   | Dropped     |
| 8. Hardening                        | Security, backups, observability, and release workflow                  | In progress |
| 9. Security verification            | Executable security tests, OWASP coverage, and a signed-off report      | Complete    |
| 10. Documentation and deployment    | A docs tree, a product README, and startup workflows for both modes     | Complete    |
| 11. Publication and first release   | Repository, CI, release workflow, versioning; publishing is the owner's | In progress |

## Milestone 0: development infrastructure

Outcome: a new developer can start the standard services without installing them
individually or using unpinned images.

### Work items

- [x] Write the initial architecture document.
- [x] Add this implementation tracker.
- [x] Add `infra/compose.yaml` with PostgreSQL, QuestDB, Telegraf, Alloy, and
      Grafana.
- [x] Pin container and Grafana plugin versions.
- [x] Add local-only example environment values.
- [x] Add minimal Telegraf, Alloy, and Grafana provisioning configuration.
- [x] Add a development start script.
- [x] Validate the rendered Compose model.
- [x] Pull images and start the full stack.
- [x] Confirm all health checks reach healthy state.
- [x] Confirm Telegraf internal metrics arrive in QuestDB.
- [x] Confirm Alloy self-metrics traverse Prometheus Remote Write through
      Telegraf and arrive in QuestDB.
- [x] Confirm Grafana loads the pinned QuestDB data-source plugin and connects
      using the read-only QuestDB user.
- [x] Record actual image digests after the first successful pull.

### Acceptance criteria

- `infra/dev-up.sh` started the stack from a clean Docker environment. It was
  consolidated into `./scripts/dev-up.sh --infra` in Milestone 10.
- No service uses `latest` or another floating image tag.
- Published development ports bind to loopback by default.
- Persistent data is stored in named volumes.
- QuestDB, Grafana, Alloy, and PostgreSQL expose usable health or status endpoints.
- Telegraf and Alloy each produce a queryable development metric in QuestDB.
- Grafana can query QuestDB without administrator credentials.
- Startup instructions and local URLs are documented.

## Milestone 1: controller foundation

Outcome: a versioned application skeleton can persist desired state and report the
health of its dependencies, with both local and OIDC login paths.

- [x] Select React, Vite, Fastify, TypeScript, and PostgreSQL.
- [x] Select the Node LTS version and package manager.
- [x] Create the workspace layout and shared TypeScript configuration.
- [x] Scaffold the web application.
- [x] Scaffold the API and reconciler process.
- [x] Add PostgreSQL migrations for users, identities, sessions, roles, jobs,
      desired state, and audit events.
- [x] Implement the bootstrap local administrator and Argon2id password login.
- [x] Implement server-side sessions, CSRF protection, login rate limiting, and
      logout.
- [x] Implement OIDC Authorization Code with PKCE and issuer/subject identity
      matching.
- [x] Implement Viewer, Operator, and Administrator authorization in Fastify.
- [x] Scaffold persisted background jobs with progress and bounded execution.
- [x] Build the app shell, navigation, accessibility baseline, and theme without
      redundant visible page-title banners.
- [x] Verify the Devices route has an active navigation state, useful document
      title, and accessible hidden heading without a repeated visible “Devices” title.
- [x] Add structured configuration loading and secret redaction.
- [x] Add liveness and readiness endpoints with PostgreSQL, QuestDB, Grafana, and
      collector dependency status.
- [x] Add unit, integration, formatting, linting, and type-check commands.
- [x] Add a development workflow that starts application services alongside
      `infra/compose.yaml`.

### Acceptance verification

- Local administrator bootstrap, Argon2id login, server-side session lookup,
  logout, CSRF rejection, and role rejection pass against PostgreSQL.
- OIDC discovery, client authentication, PKCE, state, nonce, signed-token checks,
  issuer/subject matching, role mapping, JIT provisioning, and flow replay
  rejection pass against a signed integration provider.
- Persisted jobs are claimed with bounded concurrency and execute dependency
  checks without holding an API request open.
- PostgreSQL, QuestDB, Grafana, Telegraf, and Alloy health is reported through the
  versioned API; liveness and readiness probes are available separately.
- Production builds, formatting, strict linting, TypeScript checks, unit tests,
  five PostgreSQL integration tests, and two Chromium browser journeys pass.
- Desktop and phone-sized browser tests verify login, navigation, the Devices
  document title, visually hidden accessible heading, and usable device tools.

## Milestone 2: source and credential management

Outcome: an administrator can create a source and safely store and test an SNMP
credential entirely through the UI.

- [x] Implement sites and sources.
- [x] Implement encrypted credentials with write-only secret fields.
- [x] Implement polling profiles and check assignments.
- [x] Implement collector capability metadata and Auto selection.
- [x] Implement SNMP v2c and v3 connectivity tests.
- [x] Implement an SNMP inventory job with timeouts, retries, concurrency limits,
      progress, and partial-failure reporting.
- [x] Discover and preview basic system identity and IF-MIB information.
- [x] Store timestamped inventory snapshots and preview diffs before applying
      material changes.
- [x] Verify job payloads, results, events, and logs never contain plaintext SNMP
      secrets.
- [x] Add audit events for credential and source changes.

### Acceptance verification

- PostgreSQL integration tests exercise site, credential, profile, and source
  creation, Auto-to-Telegraf selection, queued connection testing, audit events,
  encrypted-at-rest storage, and secret-free responses and jobs.
- Local UDP agents prove both SNMPv2c and SNMPv3 `authPriv` system/IF-MIB
  discovery through the production adapter.
- AES-256-GCM tests prove round trips, ciphertext without plaintext, and
  record-bound authentication that rejects envelope swapping.
- Inventory diff tests cover first discovery plus system, added, changed, and
  removed interface changes.
- Three Chromium journeys cover desktop and phone navigation plus complete
  credential, site, and device onboarding/cleanup through the GUI.
- Formatting, strict linting, TypeScript, unit tests, six PostgreSQL integration
  tests, production builds, and all browser journeys pass.

## Milestone 2.1: user and identity management

Outcome: administrators can manage local and OIDC-provisioned users without
editing PostgreSQL or weakening the existing authentication model.

- [x] List local and OIDC users with roles, status, sign-in methods, last login,
      and active session count.
- [x] Create local users with write-only Argon2id passwords.
- [x] Edit display name, email, role, and active status.
- [x] Reset local passwords and revoke all affected sessions.
- [x] Revoke another user's sessions independently of other account changes.
- [x] Disable and delete accounts with immediate session invalidation.
- [x] Prevent self-demotion, self-disable, self-delete, and loss of the final
      active administrator.
- [x] Restrict all user-management endpoints and UI routes to administrators.
- [x] Audit account creation, changes, password resets, session revocation, and
      deletion without recording passwords.

### Acceptance verification

- PostgreSQL integration tests prove local creation, Argon2id storage,
  administrator-only access, secret-free responses, session revocation, role and
  status updates, self-lockout rejection, password reset, deletion, and audit
  events.
- OIDC integration verifies that a just-in-time provisioned identity appears in
  the same user model with its OIDC method and issuer while claims remain
  server-side.
- A Chromium journey creates a local user, changes its role, resets its password,
  and removes it entirely through the GUI.
- Formatting, strict linting, TypeScript, unit tests, seven PostgreSQL integration
  tests, production builds, and four Chromium journeys pass.

## Milestone 2.2: OIDC provider management

Outcome: administrators configure and validate the initial OIDC provider through
the application instead of maintaining authentication configuration files.

- [x] Start disabled with built-in non-secret defaults and use PostgreSQL as the
      sole OIDC provider authority.
- [x] Manage provider name, issuer URL, client ID, redirect URI, scopes, JIT
      provisioning, and administrator/operator group mappings in Settings.
- [x] Store the optional client secret as a write-only, record-bound AES-256-GCM
      envelope using the controller credential key.
- [x] Test discovery metadata before saving and require successful discovery
      before enabling the provider.
- [x] Apply provider and login-screen changes without restarting the API.
- [x] Clear stored configuration and return to the disabled built-in state from
      the UI.
- [x] Require an active local administrator before changing stored settings.
- [x] Restrict reads and mutations to administrators, require CSRF for tests and
      changes, and audit test, update, and reset operations without secrets.
- [x] Keep the storage model ready for additional provider records while exposing
      one primary provider in the initial product.

### Acceptance verification

- PostgreSQL integration tests prove administrator-only access, CSRF rejection,
  discovery against a mock provider, encrypted-at-rest secret storage, secret-free
  responses and audit metadata, live login-provider updates, authorization start,
  and clearing the stored configuration back to disabled defaults.
- Unit coverage proves client-secret encryption round trips and rejects use under
  a different provider context.
- The Chromium settings journey verifies the responsive administrator form,
  write-only password control, discovery action, and save action without mutating
  a real provider configured in the shared development database.
- Formatting, strict linting, TypeScript, 15 unit/component tests, eight
  PostgreSQL integration tests, production builds, and five Chromium journeys
  pass.

## Milestone 3: Telegraf reconciliation

Outcome: desired checks become validated Telegraf configuration without manual
file editing or unsafe partial updates.

- [x] Define the Telegraf adapter contract.
- [x] Render SNMP and ping inputs from structured desired state.
- [x] Validate candidate configuration before activation.
- [x] Publish immutable revisions atomically.
- [x] Report active revision and collector health.
- [x] Preserve the last known-good revision on failure.
- [x] Implement rollback as a new revision.
- [x] Verify secrets are redacted from API responses and logs.

### Acceptance verification

- Deterministic adapter tests cover SNMPv2c, SNMPv3 `authPriv`, IPv4/IPv6,
  system and IF-MIB fields, permission-safe executable ping, invalid desired state, structural
  candidate validation, hashes, and redacted previews.
- PostgreSQL integration coverage proves first activation, encrypted deployable
  artifacts, redacted API previews, idempotent no-op reconciliation, atomic
  publication, last-known-good preservation after a forced publication failure,
  and rollback as a new active revision.
- Viewer read and Operator mutation routes expose status and revision history
  while keeping injected credential values out of responses, job payloads,
  results, audit metadata, and logs.
- Telegraf consumes a read-only watched runtime directory and uses the image's
  permission-safe ping executable; the controller never uses the Docker socket.
- The responsive Collectors workspace reports health and current ownership,
  provides persisted apply/rollback actions, and keeps its page heading visually
  hidden instead of repeating the selected navigation label.

## Milestone 4: QuestDB storage spike

Outcome: QuestDB is either accepted as the initial metrics store or rejected with
reproducible evidence.

- [x] Decide the initial table layout and canonical metric names.
- [x] Implement the server-side QuestDB adapter over PGWire with scoped
      credentials, bind parameters, statement timeouts, and bounded result sets.
- [x] Verify the React application has no direct QuestDB route or credentials and
      the API exposes only purpose-built operations rather than arbitrary SQL.
- [x] Prove Telegraf gauge, Counter32, and Counter64 ingestion.
- [x] Simulate counter reset, reboot, rollover, and discontinuity.
- [x] Implement or select reset-aware rate normalization.
- [x] Prove raw table TTL.
- [x] Prove 5-minute and 1-hour materialized views with independent TTL.
- [x] Benchmark representative write and dashboard query loads.
- [x] Verify behavior during ingestion interruption and recovery.
- [x] Document and test OSS backup and restore.
- [x] Record the storage acceptance or rejection decision.

Verified outcome:

- QuestDB is accepted for the initial release. The reproducible evidence and
  re-evaluation triggers are recorded in [storage-spike.md](storage-spike.md).
- The controller owns five raw measurement families and four materialized views;
  the GUI manages 30-day raw, 1-year 5-minute, and 5-year hourly defaults.
- Telegraf converts raw counters to lossless decimal strings after Starlark has
  emitted reset-aware rates. Live SNMP data populated raw and both rollup tiers.
- The React Storage workspace exposes status, retention confirmation, schema,
  and spike evidence without disclosing PGWire credentials or accepting SQL.
- A one-million-row benchmark, targeted storage restart, and isolated OSS
  checkpoint restore passed against the pinned development stack.

## Milestone 4.1: site hierarchy prerequisite

Outcome: users can organize devices into a flexible tree before Grafana variables
and threshold scopes depend on site semantics.

- [x] Add optional parent relationships with stable site UUIDs.
- [x] Enforce cycle prevention in the API and PostgreSQL.
- [x] Require sibling-unique names and block deletion of parents with children.
- [x] Return stable paths, depth, direct device counts, and subtree device counts.
- [x] Allow devices at every level and preserve their identity when sites move.
- [x] Build a compact responsive tree UI with add-child and move operations.
- [x] Support direct-site and descendant-inclusive source queries.
- [x] Deep-link a selected site subtree into one reusable fleet dashboard.

Acceptance verification:

- PostgreSQL integration coverage creates a three-level hierarchy, verifies its
  returned paths, rejects a cycle, blocks parent deletion, and safely moves a
  subtree.
- The browser journey was exercised against the live development stack on
  2026-08-06: it creates a parent and child, confirms the parent's removal
  control is disabled while it has children, moves the child to the top level,
  and removes both through the UI.
- The same journey asserts the subtree graph link targets the reusable fleet
  dashboard and carries one `var-site_id` value per site in the subtree, and that
  the tree itself does not overflow horizontally at a 390px viewport.

## Milestone 5: Grafana integration

Outcome: a user can move from a source in the controller to useful, reusable
Grafana dashboards.

- [x] Implement the Grafana adapter and organization-scoped service account.
- [x] Reconcile the QuestDB data source with a stable UID.
- [x] Provision fleet, source, interface, and health dashboards.
- [x] Use site, source, and interface variables instead of per-device dashboards.
- [x] Deep-link from controller pages to preselected dashboard variables.
- [x] Add the same-origin `/grafana` gateway and Fastify session check.
- [x] Configure Grafana Auth Proxy with trusted-header stripping, a gateway
      whitelist, role mapping, and no directly published production port.
- [x] Draw fleet and source graphs in PrickleScope from purpose-built QuestDB
      endpoints, with no Grafana iframe, image, script, or stylesheet in the page
      (D-019). Grafana renders the complete set, which the controller also authors.
- [x] Draw the in-product panels natively and send deeper detail to Grafana. The
      fleet and source-detail panels are native, as is a per-interface traffic
      graph under each row of the device inventory table. Interface detail and
      pipeline health are deliberately not reimplemented: they are the deeper view
      that D-019 leaves to Grafana, reached by a deep link. Rewritten from "cover
      every managed panel natively", which described a goal the division of labour
      in D-019 does not call for.
- [x] Pin one series palette across both views, so the same measurement is the
      same colour in PrickleScope and in Grafana (D-020).
- [x] Keep anonymous access and URL token login disabled; `allow_embedding` stays
      off and the gateway does not rewrite framing headers.
- [x] Verify local and OIDC users can follow a deep link without a second visible
      login and cannot escalate their Grafana role. The local path is covered by
      the browser suite, which spoofs `x-webauth-user` and `x-webauth-role` and
      asserts the account stays Editor. The OIDC path was exercised by the owner
      against a real provider on 2026-08-06; it is not in the automated suite
      because the development stack has no provider configured.
- [x] Add **Open in Grafana** fallbacks. Every panel carries one and the browser
      suite asserts the target. Secure-cookie behaviour is a property of a
      production HTTPS origin rather than of this milestone, and is tracked under
      Milestone 8.
- [x] Distinguish application-managed and user-owned Grafana resources.
- [x] Verify compatibility of the pinned Grafana and QuestDB plugin versions.

Acceptance verification:

- Reconciliation was exercised against the live stack on 2026-08-06 through the
  route, job runner, service, and adapter. Two consecutive runs both succeed and
  leave the datasource, managed folder, and four dashboards active, so the
  operation is idempotent rather than first-run only.
- Grafana 13.1.0 needs `questdb-questdb-datasource` 0.1.8. Plugin 0.1.6 declares
  `>=9.5.0` but predates the Grafana 12.3 frontend plugin runtime, so its backend
  answered health checks and `/api/ds/query` while its frontend module failed to
  load. Panels rendered `Could not load plugin` and no data. Verified after the
  upgrade by rendering panels that contain live series.
- The gateway answers anonymous requests with 401, including
  `/grafana/render/...`, reconstructs identity from the PrickleScope session, and
  strips spoofed `x-webauth-user` and `x-webauth-role` headers, leaving the
  account at Editor and `isGrafanaAdmin` false.
- The Dashboards page contains no iframe. Its panel is an `img` whose source is a
  predefined `/grafana/render/d/...` URL carrying no token, and the browser
  journey asserts the image actually decodes.
- The OIDC deep-link path was exercised by the owner against a real provider on
  2026-08-06: an OIDC user follows a link from the controller into Grafana without
  a second visible login and cannot raise their Grafana role. This is the one
  acceptance item in the milestone that no automated check covers, because the
  development stack has no provider configured.
- A dashboard created outside the managed folder survived a reconcile untouched.
- The production overlay publishes no Grafana port; the development stack still
  publishes 3000 for bootstrap diagnostics.

Defects found and fixed during verification:

- `ensureFolder` updated the managed folder with `PUT /api/folders/{uid}` and no
  `overwrite` flag, so Grafana answered 412 on every reconcile after the first
  with the misleading message `The dashboard has been changed by someone else`.
  Reconciliation therefore only ever succeeded against a Grafana instance that
  did not yet have the folder. The adapter now sends `overwrite: true`, and a
  unit test asserts it.
- No managed dashboard had ever displayed data. Three faults stacked, and the
  browser test only asserted that the iframe element existed, so none surfaced:
  1. The QuestDB plugin frontend could not load under Grafana 13 (see above).
  2. Panel targets sent `format` as `"time_series"`/`"table"`. Plugin 0.1.7+
     rejects that with `invalid format value`; it takes the numeric sqlutil
     enum.
  3. Every All-capable variable declared `allValue: '__all'`, which Grafana
     inserts verbatim without applying `:sqlstring`, producing the unparsable
     `site_id in (__all)`. The variables also had no default selection, so a
     fresh load or a render resolved them to nothing and filtered all rows away.
     Variables now omit `allValue`, default to All, and every scoped predicate is
     a plain quoted `IN` list.
- The `source_id` and `if_index` variable queries ordered by a column that is
  aliased in the select list, which QuestDB rejects. They now order by the alias.

## Milestone 6: threshold alerting

Outcome: a user can create a sustained threshold rule in the controller and
receive a notification evaluated by Grafana.

- [x] Define the alert desired-state model.
- [x] Implement threshold, evaluation interval, pending duration, and recovery
      threshold fields.
- [x] Implement explicit No Data and Error behavior.
- [x] Reconcile Grafana-managed alert rules with stable UIDs.
- [x] Reconcile contact points and per-rule notification routing. Routing lives on
      the rule rather than in the global notification policy tree, so provisioning
      never overwrites routes a user added themselves. Mute timings are not
      implemented; see the deferred note below.
- [x] Implement a rule preview against matching QuestDB series.
- [x] Prove sustained-threshold behavior.
- [x] Prove recovery threshold reaches Grafana as an unload evaluator.
- [x] Prove source-stale behavior without treating missing data as zero.
- [~] Send a test notification from the UI. For a webhook it is sent by the
  controller, not by Grafana, and therefore proves the endpoint is reachable from
  the controller rather than from Grafana. See the defect note below. For email
  the test is the production path minus Grafana: a real message through the
  operator's provider.
- [x] Deliver email through a mail provider API rather than SMTP (D-022, D-023).
      Microsoft Graph, Gmail, SendGrid, Mailgun, Postmark, and Nylas are supported;
      the form is generated from one shared provider description so adding a
      provider does not mean editing a form.

Grafana evaluates the rules and routes the notifications; PrickleScope owns the
desired state, reconciles it, and shows the resulting status in its own screens
(D-021). Both transports are HTTP (D-022): a webhook posts to the operator's own
endpoint, and email comes back to the controller, which sends it through the
configured provider (D-023).

Acceptance verification, against the live stack on 2026-08-07:

- A rule created through the API reached Grafana with a stable uid, the pending
  period as `for`, and the contact point as per-rule `notification_settings`.
- Delivery was proven end to end rather than by a test button: a rule that fires
  by construction produced a real webhook POST carrying `status: firing`, the
  receiver name, the alert name, and the severity label.
- No Data was proven not to collapse to zero. A rule reading a nonexistent
  interface with the condition `inbound < 1 Gbit/s` — which a zero would satisfy —
  reported `health: nodata` and an instance state of `NoData`, and did not fire.
- The evaluation pipeline is query, reduce, threshold, with the threshold as the
  condition, so one rule covering several sources raises one alert per source.
  Confirmed by the alert instances carrying a `source_name` label.
- The browser journey creates a contact point and a rule, previews the condition
  before saving, applies the desired state, and waits for Grafana to report a
  state back.
- Email delivery was proven along the whole path, not stubbed. An email contact
  point reconciled into Grafana as a webhook aimed at
  `http://host.docker.internal:3001/api/v1/alerts/notify/{ref}` with a bearer
  token. A rule that fires by construction made Grafana call that endpoint; the
  controller accepted the token, rendered the message, and called the real
  SendGrid API, which rejected a deliberately invalid key with HTTP 401. The
  controller recorded the failure against the contact point and returned it to
  Grafana, whose log carries the provider's own words. A valid key is the only
  difference between that run and a delivered message.

Defect found during verification:

- Grafana 13.1.0 removed the contact-point test endpoint the provisioning API
  used (`/api/alertmanager/.../receivers/test`, now HTTP 410). Its replacement,
  `/apis/notifications.alerting.grafana.app/v1beta1/.../receivers/{name}/test`,
  rejected every documented body shape with `unknown integration type: ''` even
  though the stored receiver has `type: webhook`. This is the provisioning API
  churn architecture.md warns about. The controller therefore sends the test
  itself, and says so when the address is unreachable from where it runs: a
  container-internal or cluster-internal name may resolve for Grafana and not for
  the controller. Worth revisiting when the replacement endpoint stabilises.
- Ajv coerces types inside `anyOf`, so a nullable request field written as
  `Type.Union([Type.String(), Type.Null()])` turned an explicit `null` into `''`
  before the null branch was ever tried — and `Type.Number()` turned it into `0`.
  Clearing an interface scope stored an empty string, and clearing a recovery
  threshold stored a zero that then failed the hysteresis sanity check, so the
  Alerts form could not save a rule without one. Nullable _request_ fields are now
  a single schema with a type array (`packages/contracts/src/nullable.ts`), which
  has nothing to coerce. Response schemas keep the union: responses are serialized,
  never coerced. Only fields whose non-null branch accepts `''` or `0` were
  affected — a `format: 'uuid'` branch rejects `''` and falls through to null —
  but the uuid fields were converted too so the safety is stated rather than
  incidental. `apps/api/src/alerts/schema.test.ts` holds this against the real
  Fastify validator.

Deferred:

- Mute timings and maintenance windows. The desired-state model has no field for
  them yet, and no acceptance evidence exists, so the item is not claimed.

## Milestone 7: Alloy adapter — dropped (D-024)

Telegraf covers the collection the product needs, so a second collector is not
built, and the Alloy container was removed from the stack along with its
configuration, its published port, and its health probe.

What remains is the seam, not the service: `collector_selection` still accepts a
collector kind, the capability endpoint still advertises Alloy as unavailable with
the reason, and Telegraf still exposes the Prometheus Remote Write listener — which
is also the port the Telegraf liveness probe connects to. Reintroducing Alloy means
adding a container and an adapter, not reshaping the data model.

Not built: Alloy capabilities, Alloy configuration revisions and secret delivery,
Prometheus label normalization, counter and histogram validation through the
relay, WAL buffering and recovery, duplicate-ownership prevention between the two
collectors, and Auto recommendations for Prometheus endpoints.

## Milestone 7a: naming, navigation, and pending changes

Outcome: nothing carries the working name, the menu separates use from
configuration, and drift between desired and applied state is visible in one
place.

- [x] Remove the Alloy container, its configuration, published port, health
      probe, and data volume (D-024), and the development webhook sink with it
      (D-028). Development and production now render the same four services.
- [x] Replace every `window.confirm` with an application dialog that names the
      consequence and the action (D-029).
- [x] Give contacts their own screen under Settings, editable, with the UI
      calling them contacts (D-030).
- [x] Remove dead code and de-duplicate: the unused placeholder page and its
      styles, an unused profile-id constant, the counter module (D-031), an
      orphaned table-grid rule, and the inert global search box. `roleLabel`,
      `statusTone`, and `jobIsActive` were each defined on two screens and are now
      shared from `apps/web/src/labels.ts`.
- [x] Collapse the duplicated alert-metric catalogue into `ALERT_METRICS` in
      contracts. The rule form and the SQL builder held separate copies that had
      already drifted — the same measurement was labelled "Interface errors per
      second" in the form and "Errors per second" in the rule Grafana evaluates.
- [x] Replace the Overview placeholders: a hardcoded device count of zero
      captioned "Inventory begins in Milestone 2" now reports the real fleet, and
      background jobs are named by what they do instead of showing internal slugs
      like `collector.telegraf.reconcile`. Verified afterwards: the Compose model and
      the production overlay both still render, Telegraf restarted with its SNMP
      and ping inputs intact, and the health screen reports four dependencies
      instead of five.
- [x] Rename every `modern_cacti` identifier to `pricklescope` (D-027): the
      Postgres database and role, the Compose project name and therefore its
      volumes and containers, and the development passwords. Done in place with
      `ALTER DATABASE`, `ALTER ROLE`, and a volume copy, verified afterwards
      against live data: QuestDB row counts, the four Grafana dashboards, both
      devices, and every health check.
- [x] Regroup navigation into Workspace, Settings, and System (D-026). Polling
      moved to Settings rather than disappearing; Credentials moved from System to
      Settings and kept its administrator gate.
- [x] Show pending changes in the top bar and apply them from there (D-025).

Acceptance verification, against the live stack on 2026-08-07:

- Each target answers with the comparison its own reconciler makes. Collectors
  render the candidate Telegraf configuration and compare content hashes; Grafana
  compares managed-resource hashes; alerts compare each rule's and contact point's
  stored revision; storage compares its applied marker.
- Detection was proven by editing a rule and watching Alerts turn pending with
  "1 added or changed", then applying and watching every target return to clean.
- A probe that throws becomes a blocked target rather than a failed request, so
  one unreachable engine cannot hide the others.

Two pieces of interface were decorative rather than functional and were removed
rather than left to imply a capability: the top-bar search box had no handler of
any kind despite advertising a `/` shortcut, and the notification bell rendered
its unread dot unconditionally, so it signalled nothing. The bell now lights only
when a rule is actually firing. Global search is recorded as deferred.

Defects found during verification:

- The contact form was keyed on its kind and provider, so React remounted the
  whole form when either changed and silently cleared the name already typed.
  The key is now the contact alone, with the provider-specific fields keyed
  separately so switching provider still clears the previous provider's
  credentials rather than carrying them across.
- Adding a navigation item pushed Settings below the fold, and the sidebar had no
  overflow rule, so the last items could not be reached at all on a short
  viewport. The navigation now scrolls and its items no longer compress.
- The alerting reconcile registered every rule and contact point in
  `managed_grafana_resources` but never removed the row when one was deleted or
  disabled. Nothing read those rows before, so the leak was invisible; the pending
  check reads them, and reported 17 permanently stale resources that applying
  could never clear. The reconcile now forgets rows it no longer owns, and
  deleting a contact point removes its row. A pending indicator that cannot be
  cleared is worse than none, so this was fixed rather than filtered out of the
  probe.

## Milestone 8: hardening

- [x] Threat-model credentials, collectors, and internal service APIs.
      [security/threat-model.md](security/threat-model.md) holds the assets, actors, trust boundaries, and
      per-surface controls, each naming the code that implements it. Three
      findings, all fixed with regression tests — see the verification below.
- [x] Verify secure-cookie and HTTPS behaviour against a production-like origin,
      including `PRICKLESCOPE_COOKIE_SECURE` and the Grafana gateway. Carried here
      from Milestone 5, where it cannot be exercised: development serves plain
      HTTP by design. Required building the same-origin production gateway first
      (D-032); `./infra/verify-production-origin.sh` is the repeatable check.
- [x] Add dependency and container vulnerability scanning.
      `./scripts/scan.sh` covers the dependency graph and every pinned image, and
      fails only on what the project can act on (D-033).
- [x] Audit the topbar and inventory table below 400px. The topbar overflowed a
      390px viewport until it was fixed on 2026-08-06; the phone-viewport journey
      now guards it, but the rest of the screens have not been measured.
      `apps/web/tests/e2e/responsive.spec.ts` now measures every screen at 320,
      360, and 390px. Three real defects found and fixed.
- [x] Test metadata, QuestDB, and Grafana restore procedures.
      `./infra/backup.sh` takes all three consistently; `./infra/restore-test.sh`
      restores each into throwaway containers and checks the data is really there.
- [~] Add controller and pipeline health dashboards and alerts. **Dashboards
  done**: the controller provisions a Pipeline health dashboard in Grafana
  alongside Fleet overview, Interface detail, and Source detail, and its own
  health is on System → Health plus `/health/live` and `/health/ready`.
  **Alerts not done**: nothing watches the controller or the pipeline, so a
  collector that stops writing or a dependency that drops is visible only to
  someone looking. Confirmed 2026-08-09 against the live stack — the only
  rule in Grafana was a user's own.
- [x] Add upgrade and rollback documentation for every pinned component.
      [upgrades.md](upgrades.md), written in Milestone 10.
- [x] Add end-to-end tests for the primary user journeys. 54 tests across the
      sign-in, inventory, site hierarchy, graphs, alerting, Grafana gateway, and
      phone-viewport journeys, passing on an environment seeded from nothing.
      `apps/web/tests/e2e/global-setup.ts` applies retention so the QuestDB
      tables exist, reconciles Grafana so the deep links resolve, creates a
      credential, site, and source under its own names, and writes synthetic
      samples — idempotently, so a populated instance is left alone.
- [ ] Audit keyboard navigation, focus, contrast, reduced motion, responsive
      behavior, and WCAG 2.2 AA conformance.
- [ ] Run task-based usability tests for adding a device, inventory, graphs,
      retention, and alert creation.
- [x] Define supported deployment size and resource guidance.
      [operations.md](operations.md), written in Milestone 10 from measured
      container figures rather than estimates.

Acceptance verification, against the live stack on 2026-08-07:

- **The production origin now exists.** `infra/Dockerfile.api`,
  `infra/Dockerfile.web`, and `infra/config/caddy/Caddyfile` build the API and a
  Caddy gateway; `infra/compose.production.yaml` joins them to the stack and
  resets every other published port. `docker compose ps` confirms the gateway is
  the only service with a host binding. This closes the "same-origin production
  gateway implementation" item architecture.md still lists as open, and overlaps
  the HTTPS and production-startup items in Milestone 10 — those are not claimed
  here, only unblocked.
- **24 of 24 origin checks pass** (`./infra/verify-production-origin.sh`): plain
  HTTP redirects to HTTPS; the session cookie carries `Secure`, `HttpOnly`, and
  `SameSite=Lax`; HSTS and a `default-src 'self'` CSP are served; `/grafana`
  without a session is 401 and with one carries an identity of `ps-<user id>`;
  a client supplying its own `X-WEBAUTH-USER: admin` changes nothing and does not
  become a Grafana administrator; a foreign Origin and a missing CSRF token are
  both refused; and postgres, questdb, grafana, telegraf, and api are unpublished.
- **Backups restore.** A full backup of the development stack (144K metadata dump,
  6.0G QuestDB, 222M Grafana) restored into throwaway containers with all 8 checks
  passing: the dump restores, the controller's tables read back
  (users=2 sources=2 credentials=1 rules=1 contacts=1), 1 SNMP ciphertext survives
  still sealed, QuestDB returns 1,580,188 rows, and Grafana comes back with its 4
  dashboards and 1 alert rule.
- **Scanning is clean on what the project controls.** Dependencies: clean, with one
  reasoned exception (`scripts/scan-exceptions.txt`). The API image went from 8
  findings to 0, the gateway image from 70 to 10 — all 10 inherited. Getting there
  meant two real fixes rather than suppression: `pnpm deploy` replaced a
  whole-workspace copy that shipped the web application's entire dependency tree
  into the API image (326MB of node_modules to 38.6MB), and the base image's
  bundled npm was removed, which was the source of every single advisory the API
  image reported.
- **Pins moved forward and the data survived.** postgres 17.9 to 17.10, telegraf
  1.39.1 to 1.39.2, grafana 13.1.0 to 13.1.3, each by tag and digest together;
  QuestDB stays at 9.4.3, already the newest 9.x. Verified afterwards against live
  data: 2 sources, 2 users, 1 rule, 1 contact, 1343 availability rows, all four
  Grafana dashboards, and Grafana reporting 13.1.3.
- **Below 400px, every screen is measured**, not just the two named in the item.
  38 checks across 12 screens at 320, 360, and 390px, plus the inventory rows and
  the top bar specifically.

Defects found and fixed during this milestone:

- **An operator could take a mail provider's credential.** The email adapter lets a
  caller override each provider's base URL so its own tests can assert the request
  it builds. `UpsertContactPointRequestSchema` closes itself to unknown keys, but a
  nested object does not inherit that, so `providerConfig.apiBaseUrl` survived
  validation, was stored verbatim, and was handed to the adapter — an operator
  could point SendGrid at a host they controlled and receive the API key, or for
  Graph and Gmail the client secret and refresh token. Confirmed against the real
  Fastify validator before fixing. Closed in three places so none is the only
  guard: `additionalProperties: false` on the nested schemas, an explicit key
  allowlist on the write path, and the same filter on the send path so a row
  written earlier cannot redirect a call either. Held by
  `apps/api/src/alerts/schema.test.ts`.
- **The custom error handler had never run.** A Fastify route captures the error
  handler in force when its context is built, and `await app.register(...)` — which
  the Grafana gateway needs — boots the plugin tree and builds every route
  registered so far. `setErrorHandler` was called after the routes, so it applied
  to none of them: every error came back in Fastify's default shape, so no
  controller error code and no request id ever reached a client, Ajv's own message
  went out in place of the generic one, and the 23505/23503 mappings to 409 were
  dead. Only `setNotFoundHandler` worked, which is why it went unnoticed. Both
  handlers now sit before the first route. Held by an integration test that
  exercises the fully composed application, because a bare Fastify instance does
  not reproduce it.
- **Unauthenticated readiness probing amplified into every dependency.**
  `/health/ready` has no session to check, and each call queried PostgreSQL and
  opened connections to QuestDB, Grafana, and Telegraf. Sweeps are now cached for
  five seconds and concurrent callers share one.
- **No ceiling on request volume.** Rate limiting was registered `global: false`
  with two routes opted in, so a stolen session could grind QuestDB or the SNMP
  stack. There is now a 600/minute global ceiling keyed by a hash of the session
  cookie, with QuestDB-backed routes at 120/minute.
- **Three responsive defects below 400px.** A `minmax(360px, 1fr)` grid track
  cannot shrink below 360px, so the graph grid pushed the Dashboards page sideways
  on a 320px phone and dragged its siblings with it. Form rows, fields, and inputs
  were all missing `min-width: 0`, so a grid item's automatic minimum held the OIDC
  form — and the Settings page behind it — wider than any phone.
- **Two test defects, found by not trusting a green run.** The inventory-row check
  silently skipped on a selector that matches nothing, and the PostgreSQL restore
  check probed `pg_isready` over the unix socket, which the image's temporary
  init-phase server answers before the real server restarts — it passed once and
  failed the next run for no change in the backup.

Notes for later milestones:

- The gateway work overlaps Milestone 10's production HTTPS, production startup,
  and deployment-guide items. What exists is the artifact, not the documentation.
- `SECURITY.md` was created as the threat model. Milestone 11 lists `SECURITY.md`
  as a root repository file, which usually means a vulnerability-reporting policy;
  decide then whether that is the same file or a second one.
- `infra/.env.production`, `infra/secrets/`, and `infra/runtime-prodtest/` are local
  verification state. They are Git-ignored, and Milestone 11's staging audit should
  confirm that.

## Milestone 9: security verification

- [x] Convert the threats identified in Milestone 8 into executable security tests and explicit release criteria.
- [x] Assess the application against [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/), using Level 1 as the baseline and relevant Level 2 requirements for authentication, sessions, credentials, collectors, administrative operations, and internal APIs.
- [x] Review the service APIs against the [OWASP API Security Top 10](https://owasp.org/API-Security/).
- [x] Add static application security testing (SAST) for all first-party code, covering injection, command execution, filesystem access, deserialization, cryptography, template rendering, and outbound requests.
- [~] Add secret scanning for source code, configuration, fixtures, container build contexts, CI definitions, and commit history.
- [x] Manually review the security-critical implementations identified by the threat model, particularly credential handling, authorization, collector enrollment, session management, and internal service calls.
- [x] Add negative authorization tests proving that anonymous, ordinary, and cross-device users cannot access or modify resources outside their permissions.
- [x] Add adversarial API tests for injection, path traversal, SSRF, mass assignment, malformed input, oversized requests, unexpected HTTP methods, and content-type confusion.
- [x] Test browser protections including CSRF, CORS, output encoding, security headers, session rotation, logout invalidation, and authentication throttling.
- [~] Fuzz or property-test collector and ingestion parsers with malformed, truncated, duplicated, reordered, oversized, and high-rate input.
- [x] Verify request-size limits, timeouts, concurrency limits, pagination bounds, rate limiting, and backpressure against resource-exhaustion attacks.
- [~] Run authenticated dynamic application security testing against an isolated production-like deployment, including the Grafana gateway and every externally reachable route.
- [~] Review first-party deployment and CI configuration for exposed services, excessive privileges, unsafe defaults, untrusted build inputs, writable container filesystems, and enabled debug functionality.
- [x] Verify that logs, metrics, traces, API errors, diagnostics, and exports do not disclose credentials, tokens, cookies, or sensitive device metadata.
- [x] Add a regression test for every confirmed security defect.
- [~] Record every finding as fixed, accepted, or a false positive. Require an owner, rationale, compensating control, and expiry date for each accepted risk.
- [~] Produce a security-verification report recording the tested commit and image digests, OWASP coverage, tools and versions, findings, exclusions, and residual risks.
- [x] Resolve all critical findings and review all high-severity findings before release.

[security/verification.md](security/verification.md) is the report: tools and
versions, image digests, ASVS and API Top 10 coverage, all nine findings, the
release criteria, and the residual risk.

Acceptance verification, 2026-08-08:

- **127 security assertions across six files**, plus 8 fuzzing cases, all passing
  alongside the existing 83 unit and 14 integration tests. The authorization sweep
  drives every route as anonymous, viewer, operator, and administrator, and its
  last test fails when a route is registered without a line in the matrix — so a
  new endpoint cannot ship without someone stating who may call it.
- **One critical finding, closed.** A source name is interpolated into a TOML
  comment, and a newline ends a comment: a name containing
  `\n[[inputs.exec]]\n  commands = [...]` rendered a real Telegraf input, and
  that input runs commands. Any operator could execute code on the collector host
  by naming a source. Found by seeded fuzzing, confirmed by construction, fixed in
  four independent places (D-034).
- **Three high findings, closed**: the mail-provider credential exfiltration
  carried over from Milestone 8, privilege escalation through `/sync/apply`, and a
  working AES-256 key published in the committed `.env.example`.
- **ZAP 2.16.1, authenticated, against the production-like stack**: 65 passes, 0
  failures.
- **Both scanners self-test.** On their first run one reported a clean repository
  while finding nothing at all — the report was being written where it could not
  be read. `./scripts/security-scan.sh selftest` plants a secret and three flaws
  and fails if either tool misses them.

Partial items, and exactly what is missing from each:

- **Secret scanning** covers the working tree, not commit history: there is no
  history yet. Milestone 11 introduces Git, and the history scan belongs with it.
- **Fuzzing** covers the two places caller text becomes machine-readable output —
  the Telegraf renderer and the alert-query builder. SNMP response parsing is not
  fuzzed: it needs a hostile-agent harness rather than a generator, which is a
  larger piece of work than the rest of this milestone put together.
- **Dynamic testing** ran against the API on the container network, not through
  the gateway: ZAP could not complete a TLS handshake with Caddy's local
  certificate authority. The gateway's own behaviour is covered instead by the 24
  assertions in `./infra/verify-production-origin.sh`, which do go through it. A
  public certificate would let ZAP take the same path.
- **Deployment review** is done; **CI review** cannot be — there is no CI until
  Milestone 11. The checks a pipeline would run all exist and are runnable now.
- **Finding records** have an owner, rationale, and compensating control. They do
  not have expiry dates, which would need the owner to set them.
- **The report** names tools, versions, and image digests. It cannot name a tested
  commit, because the working copy is not a repository yet.

Defects found in the verification itself, which is the part worth not skipping:

- Community Semgrep rulesets are close to inert here. Seventy-nine rules ran
  against a file containing `eval(userInput)`, a shell injection, and
  `rejectUnauthorized: false` and reported nothing. The project rules in
  `scripts/semgrep-rules.yml` do the actual work; three of those were written,
  run, and removed for being noisier than they were useful, and the file says
  which and why (D-035).
- Two container arrangements built cleanly, scanned cleanly, and did not run. A
  `pnpm deploy` tree links local packages to paths the runtime stage does not
  have — the image looks right, `ls` lists all three packages, and Node resolves
  none of them; dereferencing those links with `cp -RL` then flattens pnpm's
  virtual store and loses the transitive graph. Neither showed up until a
  container was actually started, which is what running the DAST pass forced.
- The rate limiter had been reporting 429 as 500 since the error handler was
  fixed in Milestone 8, logging every throttled login as an unhandled error.

## Milestone 10: documentation, product presentation, and deployment workflows

- [x] Move project documentation into a dedicated `docs/` directory, while retaining essential repository files such as `README.md`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` at the root.
- [x] Reorganize the documentation into a clear structure covering architecture, configuration, development, production deployment, operations, upgrades, rollback, backup and restore, security, and troubleshooting.
- [x] Review and update existing documents so they describe the current implementation accurately.
- [x] Preserve unresolved questions, limitations, and follow-up work as clearly marked open points rather than silently removing them.
- [x] Add a documentation index and update all internal links, commands, paths, and cross-references after the reorganization.
- [x] Rewrite the root `README.md` as an engaging product introduction for Pricklescope.
- [x] Explain in the README that Pricklescope is for people who value Grafana and Telegraf but do not want to maintain an increasingly complex collection of configuration files and settings.
- [x] Emphasize that Pricklescope simplifies device onboarding, inventory, data collection, retention, graphs, and alerts while preserving the flexibility to add custom Telegraf sources, Grafana dashboards, and graphs.
- [x] Explicitly disclose that the project has been created entirely with AI.
- [x] Explain that Pricklescope uses standard, replaceable containers for most of its functionality rather than hiding the underlying tools behind a proprietary platform.
- [x] Add screenshots or a short visual product tour showing the primary user journeys.
- [x] Document the intended audience, principal features, architecture, current maturity, supported deployment model, and known limitations.
- [x] Add a concise quick-start path from cloning the repository to opening a working development instance.
- [x] Audit the existing development startup scripts and document what is already available, what each script starts, and which prerequisites it requires.
- [x] Create or consolidate a single development startup script with sensible defaults, clear status output, prerequisite checks, and actionable failure messages.
- [x] Create a development-environment guide covering startup, shutdown, reset, logs, test data, configuration overrides, and common troubleshooting steps.
- [x] Create a production startup script that validates required configuration, prepares persistent storage, starts the pinned containers, and reports service health.
- [x] Add production HTTPS support, including certificate configuration or documented integration with a reverse proxy or automated certificate provider.
- [x] Ensure the production workflow configures secure cookies, including `PRICKLESCOPE_COOKIE_SECURE`, and routes the application and Grafana gateway through the HTTPS origin.
- [x] Create a production deployment guide covering prerequisites, DNS, ports, TLS certificates, secrets, persistent volumes, startup, shutdown, upgrades, rollback, backup, restore, and health verification.
- [x] Ensure neither startup script generates insecure production credentials, commits secrets, or silently falls back to development security settings.
- [x] Check the development and production instructions
- [~] Add automated checks that verify documentation links, example configuration, shell-script syntax, and documented commands where practical.
- [x] Create a SBOM document

Acceptance verification, 2026-08-09:

- **The documentation is a tree, not a pile.** `docs/` holds architecture,
  development, deployment, operations, upgrades, infrastructure, the storage
  spike, ideas, and `security/`, with [docs/README.md](README.md) as the index.
  `README.md`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` stay at the root.
  Sixty-four internal links resolve, checked automatically.
- **`SECURITY.md` was split.** The root file is now a vulnerability-reporting
  policy, which is what a repository-root `SECURITY.md` means to anyone who looks
  for one; the threat model moved to `docs/security/threat-model.md` and the
  verification report to `docs/security/verification.md`. That resolves the open
  question left in Milestone 8.
- **The licence is AGPL-3.0**, chosen by the owner. It matches Grafana's own
  licence and is compatible with Telegraf (MIT), QuestDB, Caddy, and PostgreSQL.
- **Two startup scripts became one.** `./scripts/dev-up.sh` takes `--infra` and
  `--no-serve`; `infra/dev-up.sh` is gone. Prerequisite checks name the fix rather
  than the fault, and every failure says what to run next.
- **`./scripts/prod-up.sh` refuses rather than warns.** An http origin, a site
  address that disagrees with it, an example password, a secret the API cannot
  read, or the published example key each stop the deploy before anything starts.
  Verified against the local fixture: it correctly refused four example passwords
  and changed nothing.
- **The verification fixture was renamed** from `infra/.env.production` to
  `infra/.env.verification`, because a file with deliberately weak passwords
  sitting under the name a real deployment uses is an accident waiting to be
  renamed into production.
- **Screenshots are generated, not taken by hand** —
  `apps/web/tests/e2e/screenshots.spec.ts`, opt-in with `SCREENSHOTS=1`, so they
  cannot quietly stop matching the product.
- **An SBOM per shipped image.** `./scripts/sbom.sh` produced six CycloneDX 1.7
  documents: api 131 components, web 180, postgres 51, questdb 113, telegraf 599,
  grafana 800. The output is Git-ignored — Milestone 11 attaches freshly generated
  documents to a release rather than committing ones that go stale.
- **`./scripts/check-docs.sh` passes**: 64 internal links, 11 shell scripts, 31
  documented pnpm commands, 68 documented script paths, and 30 example variables
  all check out.

Two things the screenshots forced, worth recording:

- **The first capture published real infrastructure.** The images contained a
  live firewall's hostname, its internal address, and the site name — from the
  developer's own network, on their way into a public README. The capture script
  now masks identifiers before the shutter opens, replacing names by pattern with
  `example.net` and addresses with the RFC 5737 documentation range, and taking
  site and source names exactly from the API rather than guessing at them.
- **The first mask corrupted an SNMP object id.** `1.3.6.1.4.1.25461.2.3.54`
  became `192.0.2.15.4.1.25461.2.3.54`, because an IPv4 pattern matches the first
  four components of an OID. The pattern now refuses to match inside a longer
  dotted run. A redaction that damages the thing it is protecting is worse than
  none, because it looks like it worked.

Also closed here, carried from Milestone 8:

- **Upgrade and rollback documentation for every pinned component** —
  [upgrades.md](upgrades.md), per component, saying which rollbacks are just the
  old pin and which need a restore.
- **Supported deployment size and resource guidance** —
  [operations.md](operations.md), from measured container figures and the polling
  model. Per-row disk cost is deliberately not quoted: it was not measured at
  scale, and the figures a small instance reports are dominated by fixed
  overhead. `pnpm storage:benchmark` measures it on the target hardware instead.

Partial:

- **Automated documentation checks** run links, shell syntax, documented
  commands, documented script paths, and example configuration. `shellcheck` is
  used when present and the check says so when it is not — it could not be
  installed here without sudo. External URLs are deliberately not checked: they
  fail for reasons unrelated to this repository, and a check that goes red when
  someone else's site is down is one people learn to ignore.

## Milestone 11: repository publication and first release

- [x] Verify the local Git configuration, including author identity, default branch, line-ending behavior, and optional commit or tag signing.
- [x] Confirm that a new repository can be initialized and populated without modifying or depending on files outside the project directory.
- [x] Audit `.gitignore` before staging files.
- [x] Exclude secrets, `.env` files, credentials, private keys, TLS certificates, tokens, database contents, persistent volumes, logs, backups, editor metadata, test output, caches, and local development state.
- [x] Review generated files, build artifacts, screenshots, fixtures, sample data, and large binaries to determine whether they belong in version control.
- [x] Scan the complete staged repository for secrets and sensitive information before creating the first commit.
- [x] Inspect the staged file list and repository size to ensure that only intentional project files are included.
- [x] Verify that example configuration contains safe placeholders and cannot be mistaken for production credentials.
- [x] Confirm that source files, bundled assets, dependencies, fonts, icons, and screenshots can legally be published under the selected project license.
- [x] Add appropriate root-level repository files, including `README.md`, `LICENSE`, `SECURITY.md`, `.gitignore`, and contribution guidance where applicable.
- [x] Create the initial commit only after the repository-publication audit passes.
- [~] Verify that the project can be cloned, built, tested, and started from a clean checkout.
- [~] Add GitHub Actions checks for tests, linting, security scanning, and container builds on pull requests.
- [~] Add a GitHub Actions release workflow that builds the frontend and API container images from the tagged commit.
- [x] Confirm whether the frontend is an independent runtime image or a build artifact included in another image, and publish only the containers required by the documented architecture.
- [x] Pin third-party GitHub Actions to trusted commit SHAs and configure minimal workflow permissions.
- [x] Prevent pull-request workflows from receiving release credentials or publishing container images.
- [~] Publish release images only from protected version tags or an explicitly approved release workflow.
- [x] Tag container images with the release version and immutable source revision; do not rely exclusively on `latest`.
- [x] Run the dependency and container security checks established in Milestone 8 before publishing release images.
- [x] Generate a software bill of materials for each released container image.
- [x] Record build provenance and image digests in the release notes.
- [~] Sign release tags and container images where practical.
- [x] Define the versioning scheme and document the release procedure.
- [ ] Create the first version tag and publish the corresponding container images.
- [~] Produce the first release notes, including installation instructions, supported configurations, known limitations, security considerations, image digests, and upgrade or migration guidance.
- [ ] Perform a clean installation using only the published documentation and release artifacts.
- [~] Verify the production deployment, HTTPS, secure cookies, Grafana gateway, persistence, backup, restore, and rollback using the release candidate.
- [ ] Publish the first versioned release only after all release gates have passed.

Acceptance verification, 2026-08-09:

- **The repository exists.** `git init` on `main`, author identity and
  `core.autocrlf=input` set **repository-locally** so nothing outside the project
  directory was touched. 238 files, 2.3 MB of content, 3.0 MB of history.
- **The publication audit passed before the commit, not after.** The staged diff
  was scanned with gitleaks — 1.53 MB, no leaks — and inspected by hand. Not
  staged: `.env`, `infra/.env`, `infra/.env.verification`, the credential key and
  bootstrap password under `infra/secrets/`, the rendered collector configuration
  with its injected SNMP secrets, `node_modules`, `sbom/`, and test output.
- **`.gitignore` was rewritten rather than trusted.** It now covers private keys
  and certificates by extension, backups and dumps, logs, and both runtime
  directories — while keeping the two `.gitkeep` files under
  `infra/runtime/telegraf/`, because Compose bind-mounts that path and Docker
  would otherwise create it owned by root and break the shared uid.
- **Every production dependency is permissive**: 93 MIT, 8 ISC, 3 BSD-3-Clause,
  1 BSD-2-Clause. No copyleft, nothing proprietary, nothing unlicensed. Icons are
  ISC (lucide-react), the chart engine MIT (uPlot), and no font files are bundled
  — the stylesheet names Inter and falls back to system fonts.
- **A clean clone works.** Cloned to a fresh directory, `pnpm install
--frozen-lockfile`, build, lint, typecheck, 83 unit tests, and the documentation
  checks all pass with nothing from the working copy.
- **CI and release workflows are written and SHA-pinned.** Every third-party
  action is pinned to a commit, not a tag; permissions default to `contents:
read`; CI never receives a registry credential or a signing key, and only a
  `v*` tag can start the release workflow.
- **Two images, not three.** The gateway image contains the built SPA, so the
  frontend is not a separate runtime image and publishing one would publish
  something nothing runs.
- **The versioning scheme and release procedure** are in
  [releasing.md](releasing.md), and [CHANGELOG.md](../CHANGELOG.md) carries the
  first entry.

Defects the audit found, which is what it is for:

- **`CONTRIBUTING.md` and `docs/README.md` linked to `CLAUDE.md`**, which
  `.gitignore` excludes. Both links resolved locally and would have 404'd for
  anyone who cloned. `./scripts/check-docs.sh` now asks `git check-ignore` as well
  as the filesystem, so the class of problem cannot recur.

CI found two real defects on its first runs, which is the argument for having it:

- **The documented quick start was broken on a fresh clone.** `apps/*` import the
  `dist/` output of the four packages; `pnpm dev` and `pnpm typecheck` build them
  first, but `dev-up.sh` ran `db:migrate` before anything did. The migration CLI
  could not resolve `@pricklescope/db`. The clean-checkout verification missed it
  because it ran `pnpm build` by hand before the other commands, which is not what
  the documentation tells anyone to do — it tested a path no reader would take.
- **The end-to-end suite was not hermetic.** 49 of 54 passed on a clean
  environment; 5 needed a site tree, a device, QuestDB metrics, and a configured
  Grafana, and had only ever run against a developer's populated instance. Fixed
  with a Playwright `globalSetup` rather than by narrowing CI until it went
  green. Three attempts, each a lesson worth keeping: an `INSERT` without a
  column list must match every column, and QuestDB adds columns of its own when
  Telegraf sends an undeclared field — so the statement worked on a fresh table
  and failed on a used one, reproducing inside the fixture the very
  environment-dependence it existed to remove. `latestSources` reads
  `network_system`, so a device with availability samples and no system row is
  invisible to the fleet graph. And the wait loop logged "metrics written"
  whether or not the data appeared, leaving a test to fail later with a message
  about the application instead of about the fixture; it now throws and says
  where to look.

Three items are deliberately left open, and one is a judgement worth recording:

- **The first version is 0.1.0, not 1.0.0.** Four Milestone 8 items are open —
  the controller's own health dashboards, end-to-end coverage of the primary
  journeys, the accessibility audit, and usability testing. A `1.0.0` would claim
  those were done.
- **Create the first version tag**, **perform a clean installation from published
  artifacts**, and **publish the release** all require a remote repository and a
  registry, which is the owner's to create. The workflows are ready for it.
- Signing, image publication from protected tags, and the release notes are
  marked partial for the same reason: written and configured, unexercised until
  there is somewhere to publish to.

## Feature overview

Features are numbered separately from milestones. Milestones 0 through 11 carry
the product to its first release; a feature is something added after it, planned
and accepted on its own terms.

| Feature             | Outcome                                                             | Status      |
| ------------------- | ------------------------------------------------------------------- | ----------- |
| 1. Pluggable inputs | Any measurement, over any transport, attached to a source as a chip | Not started |

## Feature 1: pluggable inputs

Outcome: a user attaches an input to a device the way they attach a credential —
as a chip — and gets CPU load, session counts, temperature, queue depth, or
anything else the input declares, collected over SNMP, REST, GraphQL, or a
transport added later. Graphs and alert rules pick the new measurements up without
a code change.

Today a source has exactly one implicit check: SNMP system and interface counters,
with a fixed field list compiled into the Telegraf renderer, landing in four
hard-coded QuestDB tables, exposed through a five-entry alert catalogue. Every one
of those is a place this feature has to become data instead of code.

### What a plugin is

A **plugin** is a declarative definition of one collectable thing: which transport
it uses, what it asks for, and which measurements it produces with their types and
units. It is not a fragment of collector configuration — the working notes rule
out arbitrary user-authored collector config, and that still holds.

Applied to a source, a plugin becomes a **check** — the existing glossary word.
_Plugin_ takes the slot _input_ held (D-038), which costs nothing because "input"
never reached the interface: with one implicit SNMP check per source, no screen
ever had to name the mechanism.

### Work items

**The model**

- [ ] Define the plugin manifest: identity, transport, request shape, declared
      measurements with type and unit, required credential kind, and the polling
      constraints it needs. Every user-facing measurement must have a declared
      type and unit — that is an existing working note, and it is what lets graphs
      and alerts be generated rather than written.
- [ ] Add a built-in plugin catalogue with at least four across three transports:
      SNMP scalar (CPU load), SNMP table (per-entity temperature), REST (session
      count), and GraphQL. The fourth proves the transport seam is real rather
      than SNMP with extra steps.
- [ ] Generalise `source_checks` from one implicit SNMP check per source to many
      checks, each naming a plugin and optionally a credential.
- [ ] Keep the existing SNMP system and interface collection working throughout,
      expressed as built-in plugins rather than as a special case. Migrating the
      current behaviour into the new model is the proof the model is adequate.

**Credentials**

- [ ] Replace the SNMP-only credential model with a kinded one: SNMPv2c, SNMPv3,
      HTTP basic, HTTP bearer, HTTP custom header, and none.
- [ ] Migrate existing SNMP credentials **without re-encrypting under a different
      AAD by accident**. The AAD is
      `pricklescope:snmp-credential:<id>:v<version>`, so a renamed table or a
      generalised AAD string makes every stored secret undecryptable. Either keep
      that exact AAD for migrated rows or re-encrypt each row inside the
      migration, deliberately.
- [ ] Keep secrets write-only across the API for every new kind, and extend
      `LOG_REDACT_PATHS` for each new secret-bearing field. A test already holds
      that list to the fields the contracts declare, so a missed field fails.
- [ ] Match a credential kind to a plugin's required kind at attach time, so a
      bearer token cannot be attached to an SNMP plugin.

**Collection**

- [ ] Render every transport into Telegraf configuration rather than collecting in
      the controller (D-036). `inputs.http` with a JSON parser covers REST and
      GraphQL; the controller stays a controller.
- [ ] Extend the Telegraf renderer to emit per-plugin inputs, and extend
      `validateTelegrafCandidate` so its allowlist of emittable tables grows with
      the plugin catalogue rather than being bypassed. That allowlist is what
      caught operator-level command execution in Milestone 9 (D-034); a plugin
      system must not be the thing that quietly widens it.
- [ ] Treat every plugin-supplied string reaching rendered configuration as
      hostile, with the same four-layer defence.
- [ ] Decide and record how a plugin's HTTP response maps to measurements — a
      declared JSON path per measurement, evaluated by Telegraf's parser, not by
      code the plugin ships.

**Storage**

- [ ] Create one QuestDB table per plugin (D-037), with the retention tiers and
      rollups the existing reconciler already applies per table.
- [ ] Decide what happens when a plugin changes its measurement set in a later
      version. Table-per-plugin buys per-measurement rollups at the price of a
      metrics-store migration here, and that migration has no design yet.
- [ ] Extend the storage probe so a plugin whose table is missing reports as
      pending rather than as silently absent.

**Graphs and alerts**

- [ ] Generate native chart panels from plugin manifests, with units and the
      validated palette, and generate the matching Grafana panels from the same
      definition. D-019 is one-directional: Grafana may lead, never trail, so a
      native panel without its Grafana counterpart breaks the invariant.
- [ ] Make the alert metric catalogue include plugin measurements while remaining
      single-sourced. It was two copies once and they drifted, which Milestone 7a
      had to fix; a dynamic catalogue must not reintroduce that.
- [ ] Extend the alert query builder for plugin measurements, keeping scope values
      on the allowlist rather than escaping them.

**Interface**

- [ ] Show a source's inputs as chips on the device page, each naming its plugin
      and credential, with add and remove.
- [ ] Add and remove without leaving the device page; removal confirms through
      `useConfirm` and names what stops being collected.
- [ ] Make the input catalogue browsable, showing what each plugin measures and
      what credential it needs before it is attached.
- [ ] Keep the chips legible below 400px — the responsive suite measures every
      screen and will fail otherwise.

**Everything the project already requires of a reconciled domain**

- [ ] Add a `pendingChange()` probe for plugin desired state, exactly as strict as
      its reconciler (D-025). A probe that cannot be cleared by applying is worse
      than none.
- [ ] Add the route matrix entries for every new endpoint. The authorization sweep
      fails when a route has no stated access level, which is the intended
      behaviour, not an obstacle.
- [ ] Extend the security suite: a plugin manifest is new untrusted input, and a
      credential kind is a new secret shape.

### Acceptance criteria

- A user attaches a REST plugin and a bearer credential to a device as chips, and
  a measurement appears on the device page and in Grafana without anyone editing
  code.
- The same is true for GraphQL, proving the transport seam.
- Existing SNMP collection is unchanged in behaviour and now runs through the
  plugin path.
- An alert rule can be created against a plugin measurement, reconciled into
  Grafana, and observed to fire.
- Every stored credential from before the migration still decrypts.
- The pending badge reports a plugin change and clears when applied.
- `corepack pnpm test:security` still passes with no route missing from the
  matrix.

### Decisions

All four were settled by the owner on 2026-08-09, before implementation rather
than during it:

- **D-036** — Telegraf executes every transport and writes to QuestDB. The
  controller never collects.
- **D-037** — one QuestDB table per plugin.
- **D-038** — _plugin_ replaces _input_ in the glossary, because user-authored
  plugins are the destination and "input" is the wrong word for something a user
  writes.
- **D-039** — the first cut ships a built-in catalogue; user-authored plugins
  follow once the manifest has survived a few real ones.

D-038 and D-039 pull in the same direction and are worth reading together: the
word is chosen for where this is going, while the capability is deliberately held
back until the manifest has proven itself.

Two consequences that have no design yet, and should not be discovered during
implementation:

- **A plugin whose measurement set changes needs a metrics-store migration.**
  That is the price of table-per-plugin, and it is the right price, but nothing
  in the product migrates QuestDB today.
- **A user-authored plugin creates a QuestDB table.** Under D-039 that is not yet
  reachable, but it is where D-037 and D-039 meet, and it is a privilege boundary
  the product does not currently have.

## Completed log

### 2026-08-09 (later)

- Milestone 11 to the edge of publishing. Repository initialised on `main` after
  a publication audit that scanned the staged diff rather than the working tree,
  `.gitignore` rewritten, licences confirmed permissive, a clean clone verified to
  build and test, CI and release workflows written with every action pinned to a
  commit SHA, and the versioning scheme and changelog written.
- Caught two documentation links to `CLAUDE.md`, which is git-ignored: they
  resolved locally and would have broken for anyone cloning. The documentation
  check now consults `git check-ignore` too.
- Recommended 0.1.0 rather than 1.0.0 for the first release, because four
  Milestone 8 items are open.
- Left tagging, publishing, and the clean install from published artifacts to the
  owner: they need a remote and a registry.

### 2026-08-09

- Completed Milestone 10. Documentation moved into `docs/` behind an index, the
  README rewritten as a product introduction with generated screenshots and an
  explicit AI disclosure, AGPL-3.0 chosen and added, two startup scripts
  consolidated into one, a production startup script that refuses development
  values, guides for development, deployment, operations, and upgrades, an SBOM
  per shipped image, and automated documentation checks.
- Split `SECURITY.md`: the root file is now a reporting policy and the threat
  model moved under `docs/security/`, resolving the question left open in
  Milestone 8.
- Closed two Milestone 8 items as a consequence: upgrade and rollback
  documentation, and supported deployment size.
- Caught real infrastructure — a live firewall hostname, its address, and a site
  name — in screenshots headed for a public README, and made the capture mask
  identifiers before writing the file. The first attempt at that mask corrupted an
  SNMP object id, which is its own lesson about redaction.

### 2026-08-08

- Completed Milestone 9. 127 security assertions across six files plus 8 fuzzing
  cases, an OWASP ASVS 5.0 and API Security Top 10 assessment, SAST and secret
  scanning with self-tests, an authenticated ZAP pass, and
  [security/verification.md](security/verification.md) recording all of it. Six
  items are partial and each says exactly what is missing — mostly things that
  need Git or CI, which arrive in Milestone 11.
- Fixed a critical defect: a source name interpolated into a TOML comment could
  end the comment and render a real `[[inputs.exec]]`, so any operator could run
  commands on the collector host by naming a source. Now defended at four layers
  (D-034), the last of which refuses any rendered table the renderer cannot emit
  and so does not depend on knowing which field was unsafe.
- Fixed two more high findings: `/sync/apply` was operator-level while enqueuing
  three administrator-gated reconciles, and the committed `.env.example` shipped a
  working AES-256 credential key that `dev-up.sh` copied verbatim into every new
  `.env`.
- Fixed the rate limiter reporting 429 as 500, a regression from making the error
  handler run in Milestone 8 — it had been logging every throttled login as an
  unhandled error.
- Established that community Semgrep rulesets find essentially nothing in this
  codebase, and wrote project rules for its real sinks instead (D-035). Removed
  three of those rules again for being noisier than useful.
- Two container arrangements built cleanly, scanned cleanly, and did not run at
  all; both were caught only because the DAST pass required actually starting the
  stack.

### 2026-08-07

- Started Milestone 8 and completed five of its eleven items: the threat model,
  secure-cookie and HTTPS verification against a production-like origin,
  dependency and container vulnerability scanning, the sub-400px audit, and tested
  restore procedures for all three stores. Evidence is in the Milestone 8
  acceptance verification.
- Built the same-origin production gateway (D-032), which Milestone 5 deferred and
  architecture.md still lists as an open implementation selection. Caddy terminates
  TLS and serves the SPA; `/grafana` routes through the API so the session check
  and identity reconstruction still happen. In production nothing but the gateway
  is published.
- Fixed a credential-exfiltration path an operator could reach: a nested request
  schema did not inherit `additionalProperties: false`, so an unknown
  `providerConfig` key was stored and honoured, and the mail adapter's test-only
  base-URL override became a way to send the provider's API key elsewhere.
- Fixed the custom Fastify error handler, which had never run for any route
  because an awaited `register` boots the plugin tree and freezes each route's
  error handler at that moment. No controller error code or request id had ever
  reached a client.
- Cached the unauthenticated readiness sweep and put a ceiling on request volume,
  both of which let anyone reachable use the controller to hammer its own
  dependencies.
- Fixed three responsive defects below 400px — a grid track that could not shrink
  and three levels of missing `min-width: 0` — found by measuring every screen
  rather than the two the item named.
- Moved the postgres, telegraf, and grafana pins forward by tag and digest
  together, and verified live data survived. Cut the API image from 8 advisories
  to 0 and 326MB of node_modules to 38.6MB by deploying only what the API loads
  and dropping the base image's bundled npm.
- Held back the first versioned release at the owner's request; it now lives in
  Milestone 11.

### 2026-08-06

- Chose Grafana as the alert evaluator for Milestone 6 (D-021) and narrowed D-001,
  which still claimed Grafana owned visualization after D-019 moved that to the
  controller. Confirmed QuestDB cannot evaluate user-defined thresholds: no
  alerting endpoints or configuration on the running instance, and its documented
  alerting path forwards QuestDB's own CRITICAL log lines to Prometheus
  Alertmanager. The QuestDB "alert thresholding" page is a glossary entry
  explaining the concept, not a product feature.
- Completed Milestone 5. The three items left open were closed on the owner's
  verification and a scope correction: the OIDC deep-link path was exercised
  against a real provider, the native-coverage item was rewritten because D-019
  deliberately leaves interface detail and pipeline health to Grafana rather than
  reimplementing them, and secure-cookie verification moved to Milestone 8 because
  development serves plain HTTP by design.
- Fixed every QuestDB timestamp being read in the API host's zone. QuestDB stores
  UTC and returns TIMESTAMP without a zone marker, so node-postgres parsed it as
  local time and shifted every sample by the host offset: a graph in Brussels
  showed data two hours older than it was. The QuestDB pool now parses that column
  as UTC, scoped so the PostgreSQL metadata connection keeps the driver's own
  parsers. Caught by comparing the API's newest timestamp against the wall clock,
  and guarded by unit tests including one that asserts independence from the
  process offset. The read path is fixed; query parameters still rely on the
  driver's own serialisation and were not changed.
- Settled the series palette on Cacti's green and blue, tuned per theme, with
  inbound drawn as a filled area under an outbound line (D-020). It briefly used
  Grafana's green/yellow for consistency; that pair sits barely above the
  colour-vision floor and its yellow falls to 1.57:1 on a white surface. The
  palette now lives in `packages/contracts` so the Grafana adapter can pin the
  same values without depending on a React package, and the managed dashboards
  carry matching `byRegexp` colour and fill overrides.
- Added per-interface traffic graphs to the device inventory: one bounded
  `/api/v1/graphs/sources/:id/interfaces` query returns inbound and outbound for
  every interface on a shared axis, drawn as plain SVG rather than fifty chart
  instances. Each graph carries a speed axis on the left and a footer giving the
  span and the key. A down or silent interface draws nothing at all.
- Refined the charts: monotone-cubic smoothing with no per-sample markers, a
  percentage axis framed 0-100 rather than auto-ranged to 200%, unit-aware axis
  widths so "1.5 Gbit/s" is not clipped, and a more transparent hover card.
- Renamed the stat-tile module away from `stat.tsx`. Served as `stat.js` in
  development it matches common ad-blocker filter lists, which blocked the module
  and left the application a blank page. Headless browsers run no extensions, so
  every automated check passed while the app was broken in a real browser.
- Removed dead code found in a cleanup pass: an unused QuestDB interface-rate
  query, the retired `resource-card` and Grafana-frame styles, and seven unused
  exports from the shared UI barrel. Every declared runtime dependency was audited
  against actual usage and all are still referenced.
- Made the device-graph browser test pick a source that is actually reporting.
  It previously clicked whichever device sorted first, which is an inventoried but
  unpolled device whose empty chart is correct behaviour.

- Completed Milestone 4.1. The site tree, add-child and move operations, subtree
  deep-linking, and deletion protection were exercised in Chromium against the
  live stack, and the browser journey now asserts the subtree fleet link and the
  tree's 390px layout.
- Verified Milestone 5 against the live stack: idempotent reconciliation of the
  datasource, managed folder, and four dashboards; session-checked gateway
  rejecting anonymous requests and stripping spoofed auth-proxy headers;
  user-owned dashboards left untouched; no published Grafana port in the
  production overlay. The plugin-compatibility item was marked verified on the
  strength of the datasource health check and `/api/ds/query`, which exercise
  only the backend; the frontend plugin was in fact broken and the panels showed
  no data. Corrected later the same day by upgrading the plugin to 0.1.8.
- Fixed the managed-folder update, which failed every reconcile after the first
  because `PUT /api/folders/{uid}` was sent without `overwrite`. Added a unit
  test for the flag.
- Repaired the baseline so the gates pass again: `api.sources` is wrapped in its
  own query function, the Grafana panel id is spread conditionally under
  `exactOptionalPropertyTypes`, the reconcile failure attaches its cause, and
  `grafanaUrl` moved to `apps/web/src/grafana.ts` so the component module only
  exports components.
- Corrected two browser assertions that never matched Grafana 13 or the site
  tree: the Grafana role check now reads `/api/user/orgs`, and the site removal
  locators are exact so a parent's label no longer matches its child's path.
- Replaced Grafana iframe embedding with server-rendered images (D-017), then
  replaced that with PrickleScope's own charting (D-019) once it was clear the
  images still read as Grafana screenshots: OSS cannot remove the "Powered by
  Grafana" watermark, and each image carried Grafana's own panel title and
  typography. The `grafana-image-renderer` service added for D-017 was removed
  again. `allow_embedding` stays off and the gateway no longer rewrites framing
  headers.
- Added native graphing: uPlot 1.6.32 (the engine Grafana uses for time series)
  behind chart primitives in `packages/ui`, a categorical series palette
  validated for lightness, chroma, colour-vision separation and contrast in both
  themes, and purpose-built `/api/v1/graphs/...` endpoints that downsample in
  QuestDB the way Grafana's `$__interval` does. Fleet and source-detail panels are
  native; interface detail and pipeline health still open in Grafana.
- Upgraded the QuestDB data-source plugin to 0.1.8 and repaired the managed
  dashboards, which had never rendered data. Details are in the Milestone 5
  defect list.
- Fixed the topbar overflowing a 390px viewport by 27px on every page: the search
  input's `size=20` intrinsic width gave `.global-search` a 266px floor that
  `min-width: auto` would not shrink. The phone-viewport journey now asserts the
  document does not scroll horizontally.
- Switched every development URL and origin to `localhost` (D-018). Loopback bind
  addresses, the Grafana auth-proxy IP whitelist, container-internal addresses,
  and SNMP device targets in fixtures stay numeric.

### 2026-08-05

- Completed Milestone 4 and accepted QuestDB with controller-owned raw/rollup
  schema, GUI retention, purpose-specific PGWire access, exact Counter64 storage,
  reset-aware collector rates, live Telegraf ingestion, and independent TTL.
- Verified a one-million-row benchmark, buffered recovery across a QuestDB
  restart, and an isolated OSS checkpoint restore that retained the exact
  full-range unsigned counter. Added repeatable benchmark and backup/restore
  tooling plus the responsive Storage workspace.
- Added a dedicated `pricklescope_test` database and a destructive-test guard
  after an integration invocation was mistakenly pointed at development
  metadata. Recovered the active device and encrypted SNMP credential from the
  permission-restricted Telegraf artifact, restored four collector revisions and
  administrator access, then rebuilt and applied inventory from the live device.

- Completed Milestone 3 with structured Telegraf SNMP/ping rendering, candidate
  validation, persisted reconciliation jobs, encrypted immutable revisions,
  atomic live publication, redacted previews, collector health, no-op detection,
  last-known-good protection, and rollback-as-a-new-revision.
- Added the responsive Collectors workspace, fourth metadata migration,
  controller-owned watched runtime mount, permission-safe executable ping, and
  integration coverage that forces a publication failure without changing the
  active artifact.

- Completed Milestone 2.2 with administrator-managed OIDC provider settings,
  discovery testing, live runtime application, GUI-only configuration,
  encrypted write-only client secrets, and group/JIT controls.
- Added a third metadata migration plus administrator/CSRF/secret/audit coverage;
  browser verification intentionally leaves an existing development provider
  unchanged.

- Completed Milestone 2.1 with administrator-managed local and OIDC user records,
  roles, access status, password resets, session revocation, and account removal.
- Added immediate session invalidation for security changes, write-only password
  handling, self-lockout/final-administrator protection, and complete user audit
  events.
- Added the responsive Users workspace and verified the full local-account
  lifecycle in Chromium.

- Completed Milestone 2 with GUI-managed sites, devices, SNMP credentials, and
  reusable polling profiles.
- Added AES-256-GCM credential envelopes bound to record identity and key version;
  secrets remain write-only and are redacted from responses, jobs, audits, and
  logs.
- Added collector capabilities and deterministic Auto selection, currently
  choosing Telegraf for SNMP while Alloy remains explicitly unavailable.
- Added persisted SNMP connectivity and inventory jobs with timeouts, retries,
  concurrency limits, progress, cancellation, partial IF-MIB results, timestamped
  snapshots, diffs, and explicit apply.
- Verified real SNMPv2c and SNMPv3 `authPriv` system/IF-MIB discovery and a full
  browser onboarding journey.

- Named the project PrickleScope and created the Node 24/pnpm 11 monorepo.
- Added shared TypeBox contracts, Kysely metadata migrations, infrastructure
  health adapters, and reusable UI primitives.
- Implemented local bootstrap authentication, Argon2id password hashing,
  PostgreSQL sessions, CSRF, rate limiting, logout, and API-enforced roles.
- Implemented and integration-tested generic OIDC Authorization Code with PKCE,
  signed-token validation, group mapping, JIT provisioning, and replay rejection.
- Added persisted bounded jobs, audit events, desired state, liveness, readiness,
  authenticated dependency health, OpenAPI generation, and secret-redacted logs.
- Built the responsive light/dark React shell and verified that Devices does not
  repeat its navigation label as a visible page banner.
- Added one-command development startup, exact dependency locking, a root guide,
  unit/integration/browser tests, strict linting, type checks, and production
  builds.
- Restarted and reverified all five development containers after the host reboot;
  migrated the metadata database and created the local administrator.

### 2026-08-04

- Created the initial architecture and implementation tracking documents.
- Selected Grafana as the visualization and alert-evaluation layer.
- Recorded QuestDB as provisional pending a counter, retention, and recovery
  spike.
- Recorded Telegraf-first sequencing and the optional Alloy relay design.
- Added the initial local infrastructure scaffold with pinned component versions.
- Started and verified PostgreSQL, QuestDB, Telegraf, Alloy, and Grafana.
- Verified Telegraf metrics and Alloy Remote Write metrics in QuestDB.
- Verified Grafana plugin `questdb-questdb-datasource` 0.1.6 and its read-only
  QuestDB data-source health check.
- Recorded registry digests for all five container images.
- Accepted React and Vite for the web application, Fastify and TypeScript for the
  API, and PostgreSQL for application metadata.
- Accepted local plus OIDC authentication with Viewer, Operator, and
  Administrator roles.
- Defined server-owned QuestDB access, persisted SNMP inventory jobs,
  authenticated same-origin Grafana embedding, and the initial interface rules.

## Working notes

- Do not mark the QuestDB decision accepted merely because the development stack
  starts. Counter correctness and recoverability are explicit gates.
- Do not introduce arbitrary user-authored collector configuration in the first
  release; supported adapters own validation and rendering.
- Avoid implementing a generic multi-database abstraction. Keep boundaries clear,
  but implement only the storage behavior actually needed by QuestDB and the
  documented fallback spike.
- Every user-facing alert metric must have a declared type and unit.
- Browser code never receives infrastructure credentials or an arbitrary SQL
  pass-through endpoint.
- On-demand SNMP inventory is controller work; recurring monitoring remains
  collector work.
- Grafana embedding must preserve user identity without anonymous access or
  credentials in URLs.
