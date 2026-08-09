#!/usr/bin/env bash
# Generate a software bill of materials for everything PrickleScope ships.
#
#   ./scripts/sbom.sh              write CycloneDX documents to sbom/
#   ./scripts/sbom.sh <directory>  write them somewhere else
#
# One document per image: the two this project builds, and the four upstream
# services it pins. Together those are the whole runtime — there is nothing else
# on the host.
#
# CycloneDX 1.7, because it carries dependency relationships and licence data,
# and because Milestone 11 attaches these to a release.

set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

TRIVY_IMAGE="aquasec/trivy:0.73.0@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c"
output_dir="${1:-${repo_dir}/sbom}"
mkdir -p "${output_dir}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }

generate() {
  local image="$1" name="$2"
  local file="${output_dir}/${name}.cdx.json"
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v pricklescope-trivy-cache:/root/.cache/trivy \
    "${TRIVY_IMAGE}" image --format cyclonedx --quiet "${image}" \
    >"${file}" 2>/dev/null

  local components
  components="$(python3 -c "
import json
print(len(json.load(open('${file}')).get('components', [])))
" 2>/dev/null || echo 0)"

  if [[ "${components}" -eq 0 ]]; then
    printf '    \033[31m✗\033[0m %s produced no components\n' "${name}" >&2
    return 1
  fi
  ok "${name}: ${components} components"
}

step "Building the images this project ships"
docker build --quiet -f infra/Dockerfile.api -t pricklescope/api:sbom . >/dev/null
docker build --quiet -f infra/Dockerfile.web -t pricklescope/web:sbom . >/dev/null
ok "api and web built"

step "Generating"
failed=0
generate pricklescope/api:sbom api || failed=1
generate pricklescope/web:sbom web || failed=1

# The upstream pins, read out of the Compose file so this cannot drift from what
# actually runs.
while read -r image; do
  [[ -z "${image}" ]] && continue
  name="$(printf '%s' "${image}" | sed 's|.*/||; s|:.*||')"
  generate "${image}" "${name}" || failed=1
done < <(sed -n 's/^[[:space:]]*image:[[:space:]]*\(.*@sha256:[0-9a-f]*\)[[:space:]]*$/\1/p' infra/compose.yaml)

step "Index"
python3 - "${output_dir}" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path

directory = Path(sys.argv[1])
rows = []
for file in sorted(directory.glob('*.cdx.json')):
    document = json.loads(file.read_text())
    metadata = document.get('metadata', {})
    component = metadata.get('component', {})
    rows.append({
        'file': file.name,
        'image': component.get('name', '?'),
        'digest': next(
            (h.get('content', '') for h in component.get('hashes', []) if h.get('alg') == 'SHA-256'),
            component.get('version', ''),
        ),
        'components': len(document.get('components', [])),
    })

lines = [
    '# Software bill of materials',
    '',
    f'Generated {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")} with Trivy, CycloneDX 1.7.',
    '',
    'One document per image. Regenerate with `./scripts/sbom.sh`; these are not',
    'kept up to date by hand and a stale one is worse than none.',
    '',
    '| Image | Components | Document |',
    '| ----- | ---------: | -------- |',
]
for row in rows:
    lines.append(f'| `{row["image"]}` | {row["components"]} | [{row["file"]}]({row["file"]}) |')
lines.append('')
(directory / 'README.md').write_text('\n'.join(lines) + '\n')
print(f'    wrote {directory / "README.md"}')
PY

if [[ "${failed}" -ne 0 ]]; then
  echo
  echo "At least one document was empty. A bill of materials nobody checked is not one." >&2
  exit 1
fi

echo
printf 'SBOM written to %s\n' "${output_dir}"
