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
# 1. Set the version everywhere it is declared. `pnpm version` moves the root
#    only and refuses on an unclean tree, so the seven package.json files are
#    set together — the release gate checks that they agree.
node -e "for (const f of ['package.json','packages/adapters/package.json',
  'packages/contracts/package.json','packages/db/package.json','packages/ui/package.json',
  'apps/api/package.json','apps/web/package.json']) {
    const p = require('node:fs'); const j = JSON.parse(p.readFileSync(f,'utf8'));
    j.version = '1.1.0'; p.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }"

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
6. Opens a **draft** release. You review and publish it.

The notes come from `scripts/release-notes.sh`, which reads the `## <version>`
section of `CHANGELOG.md` and refuses if there is not one — checked in the gate,
before anything is built, rather than when the notes are written. Run it yourself
to see what a release will say:

```bash
./scripts/release-notes.sh 1.1.0 "$(git rev-parse HEAD)" <owner>/pricklescope \
  sha256:0 sha256:0
```

The draft is deliberate. The last gate is a person reading what is about to go
out.

## When a release fails partway

Steps 2 and 3 have already happened by the time step 4 can fail, so a failed run
can leave images in the registry with no signature, no SBOM, and no release. That
is what happened to the first `v0.1.0`: the images published and `cosign sign`
rejected the name.

The workflow is read from the tag, so fixing it means the tag has to move:

```bash
git push origin main                  # the fix, with CI green on it
git tag -d v1.1.0 && git push origin :refs/tags/v1.1.0
git tag -a v1.1.0 -m "PrickleScope 1.1.0" && git push origin v1.1.0
```

Moving a tag is only acceptable **while nothing has been published under it** —
no release, no announcement, and no one able to pull. The re-run overwrites the
registry's `1.1.0` tag with a new digest. Once a release exists, the version is
spent: fix forward with the next patch number instead.

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
./scripts/prod-up.sh --no-build   # the released images, not a local build
./infra/verify-production-origin.sh --env-file infra/.env.production --no-build
```

If a step is missing from the documentation you will find it here, which is the
point of doing it this way round.

Then verify the upgrade path from the previous version on a copy of real data —
[upgrades.md](upgrades.md) — because that is what most people will actually do
with the release.

## Verifying a release, as a user

Each release names its own command, with the digests filled in. It reads:

```bash
cosign verify ghcr.io/<owner>/pricklescope/api@sha256:<digest> \
  --certificate-identity-regexp '(?i)^https://github\.com/<owner>/pricklescope/\.github/workflows/release\.yaml@refs/tags/v.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The registry path is lowercase whatever case the owner's name is written in, and
the certificate is not — which is why the pattern is case-insensitive. It is
anchored to the release workflow on a version tag, so a signature from any other
workflow in the repository is rejected rather than accepted.

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
