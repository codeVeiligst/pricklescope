# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not as a public issue.

Include what you need to make the problem reproducible: the version or image
digest, the request or configuration involved, what you expected, and what
happened instead. A proof of concept helps but is not required — a clear
description of the flaw is enough to start.

You should expect an acknowledgement within a few days and an assessment of
severity and likely timeline shortly after. If a report turns out to describe
intended behaviour, the reply will say so and explain why, and the reasoning will
be added to the threat model if it was not already there.

## Supported versions

Only the latest release is supported, together with the current state of the
default branch. There is one maintainer and no backport branch: a fix lands on
`main` and goes out in the next release rather than being carried back.

Releases are listed at
<https://github.com/codeVeiligst/pricklescope/releases>, and each names the exact
commit and image digests it was built from.

## What is in scope

The controller and everything it generates: the API, the web application, the
same-origin gateway, credential handling, and the Telegraf configuration,
QuestDB schema, and Grafana resources it writes.

Vulnerabilities in Grafana, Telegraf, QuestDB, PostgreSQL, or Caddy themselves
belong upstream — but a report is still welcome if PrickleScope's use of one of
them is what makes it exploitable, or if a pinned image is behind on a fix.

## Known and accepted

Some behaviour looks like a vulnerability and is a deliberate, recorded decision.
Before reporting, it is worth checking:

- [Threat model](docs/security/threat-model.md) — assets, attackers, trust
  boundaries, per-surface controls, and the accepted gaps with the reasoning for
  each.
- [Security verification report](docs/security/verification.md) — how those
  claims were tested, every finding from the last review, and the residual risk.

The clearest example: an operator can point a webhook or an SNMP target at an
internal address. Reaching operator-chosen hosts is what the product is for, so
that is bounded rather than prevented — responses are never returned to the
caller, and every outbound call has a timeout.

## How security is verified

Security checks are part of the ordinary test suite and are runnable by anyone:

```bash
corepack pnpm test:security          # authorization, injection, CSRF, limits, disclosure
./scripts/security-scan.sh           # static analysis and secret scanning, with self-tests
./scripts/scan.sh                    # dependency advisories and every pinned image

# TLS, cookies, gateway, and exposure — against a deployment you have
./infra/verify-production-origin.sh --env-file infra/.env.production --no-build
```

The first three need nothing but a checkout. The last one needs a running
production-like stack, because plain HTTP cannot demonstrate a `Secure` cookie;
[docs/deployment.md](docs/deployment.md) sets one up.

Every confirmed security defect gets a regression test. Findings that are accepted
rather than fixed are written down with the reason and the condition that would
reopen them.
