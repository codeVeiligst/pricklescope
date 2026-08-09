#!/usr/bin/env bash
#
# Writes the body of a GitHub release to stdout.
#
#   scripts/release-notes.sh VERSION SHA REPOSITORY API_DIGEST WEB_DIGEST
#
# This exists as a script rather than as shell inside the workflow so that it can
# be run and read before a tag is cut. The first v0.1.0 release notes carried the
# image digests and nothing else — no installation, no limitations, no security
# summary — because the workflow wrote them by hand and nobody could see the
# result until after publishing.
#
# CHANGELOG.md is the single source for what changed. If the entry for this
# version is missing, that is an error: a release whose notes say nothing is
# worse than no release.
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 VERSION SHA REPOSITORY API_DIGEST WEB_DIGEST" >&2
  exit 2
fi

version="$1"
sha="$2"
repository="$3"
api_digest="$4"
web_digest="$5"

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
changelog="${repo_dir}/CHANGELOG.md"

# The registry rejects an uppercase path; the signing certificate keeps whatever
# case GitHub uses. Both appear below, deliberately, and they differ.
images="ghcr.io/$(echo "${repository}" | tr '[:upper:]' '[:lower:]')"

entry="$(awk -v want="## ${version}" '
  index($0, want) == 1 { collecting = 1; next }
  collecting && /^## / { exit }
  collecting { print }
' "${changelog}")"

if [[ -z "${entry//[[:space:]]/}" ]]; then
  echo "error: CHANGELOG.md has no '## ${version}' entry" >&2
  exit 1
fi

cat <<EOF
PrickleScope ${version}. Built from \`${sha}\`.

**Install:** [docs/deployment.md](https://github.com/${repository}/blob/${sha}/docs/deployment.md)
· **Upgrade:** [docs/upgrades.md](https://github.com/${repository}/blob/${sha}/docs/upgrades.md)
· **Operate:** [docs/operations.md](https://github.com/${repository}/blob/${sha}/docs/operations.md)
· **Report a vulnerability:** [SECURITY.md](https://github.com/${repository}/blob/${sha}/SECURITY.md)
${entry}
## Images

\`\`\`
${images}/api@${api_digest}
${images}/web@${web_digest}
\`\`\`

Both are signed with cosign, keylessly — the certificate comes from the release
workflow's own OIDC identity, so there is no signing key stored anywhere. Verify
before you run them:

\`\`\`bash
cosign verify ${images}/api@${api_digest} \\
  --certificate-identity-regexp '(?i)^https://github\.com/${repository}/\.github/workflows/release\.yaml@refs/tags/v.+\$' \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
\`\`\`

The pattern is case-insensitive because the certificate spells the repository the
way GitHub does and the registry path is lowercase; it is anchored to the release
workflow on a version tag, so a signature from any other workflow is rejected.

A CycloneDX SBOM for each image, and for the four upstream containers the stack
runs, is attached below. Build provenance travels with the images themselves.
EOF
