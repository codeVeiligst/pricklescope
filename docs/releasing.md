# Versioning and releasing

## Versioning

PrickleScope uses [semantic versioning](https://semver.org), interpreted for a
self-hosted product rather than a library. The public surface is not an API
consumers import — it is what an operator has to do when they upgrade.

| Change                                                                                                    | Bump  |
| --------------------------------------------------------------------------------------------------------- | ----- |
| An upgrade needs a manual step: a new required variable, a data migration you must run, a removed feature | Major |
| New capability, new plugin, new screen — upgrade in place and nothing breaks                              | Minor |
| Fix, dependency bump, pinned image moved forward, documentation                                           | Patch |

A schema migration on its own is a **patch or minor**, because migrations run on
start and only move forward. It is a **major** when rolling back would need a
database restore and the release notes have to say so.

Every version comes from `package.json` at the repository root. The release
workflow refuses to publish when the tag and that version disagree, so they cannot
drift.

Pre-release versions use `-rc.N`. They publish images and a draft release, and
are not marked latest.

## Before a release

Everything the release gate runs, you can run first:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration     # must actually execute — check the count
corepack pnpm test:security
corepack pnpm test:e2e
./scripts/security-scan.sh
./scripts/scan.sh
./scripts/check-docs.sh
```

And the two that need a live stack, which CI cannot do for you:

```bash
./infra/verify-production-origin.sh                        # 24 assertions
./infra/backup.sh /tmp/pre-release && ./infra/restore-test.sh /tmp/pre-release
```

## Cutting a release

```bash
# 1. Set the version everywhere it is declared
corepack pnpm version 1.1.0 --no-git-tag-version

# 2. Write the entry in CHANGELOG.md — what an operator has to know, not a
#    commit list. The release workflow generates the commit list itself.
$EDITOR CHANGELOG.md

# 3. Commit and tag. The tag is the approval: nothing publishes without one.
git commit -am "Release 1.1.0"
git tag -a v1.1.0 -m "PrickleScope 1.1.0"

# 4. Push the commit first, then the tag
git push origin main
git push origin v1.1.0
```

The tag starts `.github/workflows/release.yaml`, which:

1. Re-runs every check against the tagged commit, and refuses if the tag does not
   match `package.json`.
2. Builds `api` and `web` for the tagged commit.
3. Pushes them to `ghcr.io` tagged with the version, the major.minor, and the
   full commit SHA — never `latest` alone, so a deployment can always name an
   immutable reference.
4. Signs both with cosign, keylessly: the certificate comes from the workflow's
   own OIDC identity, so there is no signing key stored anywhere to leak.
5. Attaches build provenance and a CycloneDX SBOM per image.
6. Opens a **draft** release with the digests. You review and publish it.

The draft is deliberate. The last gate is a person reading what is about to go
out.

## Two images, not three

The documented architecture has two containers this project builds: `api` and
`web`. The frontend is **not** a separate runtime image — the gateway image
contains the built SPA and serves it, so publishing a third would publish
something nothing runs.

## After publishing

Do a clean install using only the published artifacts and the published
documentation — not this working copy:

```bash
git clone https://github.com/<owner>/pricklescope
cd pricklescope
cp infra/.env.production.example infra/.env.production
# follow docs/deployment.md exactly, including the secrets steps
./scripts/prod-up.sh
./infra/verify-production-origin.sh
```

If a step is missing from the documentation you will find it here, which is the
point of doing it this way round.

Then verify the upgrade path from the previous version on a copy of real data —
[upgrades.md](upgrades.md) — because that is what most people will actually do
with the release.

## Verifying a release, as a user

```bash
cosign verify ghcr.io/<owner>/pricklescope/api@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/<owner>/pricklescope/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The SBOMs are attached to the GitHub release and to each image.

## What the workflows deliberately do not do

- **A pull request never receives a registry credential or a signing key.** CI and
  release are separate workflows and only a `v*` tag starts the second, so a fork
  cannot reach anything that publishes.
- **Third-party actions are pinned to commit SHAs, not tags.** A tag is mutable
  and whoever owns it can change what runs.
- **Permissions default to `contents: read`** and are widened per job only where
  needed.
- **Nothing publishes on a green build.** Publishing takes a tag, and the release
  itself takes a human.
