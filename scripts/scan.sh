#!/usr/bin/env bash
# Dependency and container vulnerability scanning.
#
#   ./scripts/scan.sh              dependencies and every pinned image
#   ./scripts/scan.sh deps         npm advisories only (fast, no Docker)
#   ./scripts/scan.sh images       container images only
#
# Fails on a HIGH or CRITICAL finding that has a fix available, except for the
# advisories listed in scripts/scan-exceptions.txt with a reason. Findings with no
# fix are excluded by the scanner itself: there is nothing to act on, and a check
# that cannot be made to pass gets ignored, which is worse than not having one.

set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

# Pinned by tag and digest together, like every other image in the project.
TRIVY_IMAGE="aquasec/trivy:0.73.0@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c"
exceptions_file="${repo_dir}/scripts/scan-exceptions.txt"
reporter="${repo_dir}/scripts/scan-report.py"
mode="${1:-all}"
failures=0

scan_dependencies() {
  echo "== Dependency advisories (pnpm audit)"
  # `pnpm audit` exits non-zero whenever it finds anything, including advisories
  # that are allowed by exception. Under `pipefail` that would decide the verdict
  # instead of the reporter, so its status is discarded deliberately.
  if ! { corepack pnpm audit --json 2>/dev/null || true; } |
    python3 "${reporter}" audit "${exceptions_file}"; then
    failures=$((failures + 1))
  fi
  echo
}

scan_image() {
  local image="$1"
  echo "== ${image}"
  if ! docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v pricklescope-trivy-cache:/root/.cache/trivy \
    "${TRIVY_IMAGE}" image --scanners vuln --severity HIGH,CRITICAL \
    --ignore-unfixed --format json --quiet "${image}" 2>/dev/null |
    python3 "${reporter}" trivy "${exceptions_file}"; then
    failures=$((failures + 1))
  fi
  echo
}

scan_images() {
  echo "Building the images the project ships..."
  docker build --quiet -f infra/Dockerfile.api -t pricklescope/api:scan . >/dev/null
  docker build --quiet -f infra/Dockerfile.web -t pricklescope/web:scan . >/dev/null
  echo

  scan_image pricklescope/api:scan
  scan_image pricklescope/web:scan

  # The third-party pins are read out of the Compose file rather than repeated
  # here, so this cannot drift from what actually runs.
  while read -r image; do
    [[ -n "${image}" ]] && scan_image "${image}"
  done < <(sed -n 's/^[[:space:]]*image:[[:space:]]*\(.*@sha256:[0-9a-f]*\)[[:space:]]*$/\1/p' infra/compose.yaml)
}

case "${mode}" in
  deps) scan_dependencies ;;
  images) scan_images ;;
  all)
    scan_dependencies
    scan_images
    ;;
  *)
    echo "Usage: $0 [deps|images|all]" >&2
    exit 2
    ;;
esac

if [[ "${failures}" -gt 0 ]]; then
  echo "${failures} scan target(s) reported a blocking advisory."
  echo "Fix it, or add the identifier to scripts/scan-exceptions.txt with a reason."
  exit 1
fi
echo "All scan targets clean."
