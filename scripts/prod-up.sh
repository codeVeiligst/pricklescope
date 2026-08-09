#!/usr/bin/env bash
# Start PrickleScope in production.
#
#   ./scripts/prod-up.sh             validate, build, start, report health
#   ./scripts/prod-up.sh --check     validate only, change nothing
#   ./scripts/prod-up.sh --no-build  start without rebuilding the images
#   ./scripts/prod-up.sh --help
#
# Every check below refuses rather than warns. A monitoring controller that comes
# up with a development password or a published encryption key is worse than one
# that does not come up: it holds the SNMP credentials for the whole fleet, and
# nobody looks at a warning that scrolled past during a deploy.
#
# See docs/deployment.md for what to prepare before the first run.

set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
infra_dir="${repo_dir}/infra"
env_file="${PRICKLESCOPE_PROD_ENV_FILE:-${infra_dir}/.env.production}"

build=1
check_only=0
case "${1:-}" in
  --check) check_only=1 ;;
  --no-build) build=0 ;;
  --help | -h)
    sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
    exit 0
    ;;
  '') ;;
  *)
    echo "Unknown option: $1. Try --help." >&2
    exit 2
    ;;
esac

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }
problems=()
refuse() { problems+=("$1"); printf '    \033[31m✗\033[0m %s\n' "$1"; }
die() {
  printf '\n\033[31mCannot start:\033[0m %s\n' "$1" >&2
  [[ -n "${2:-}" ]] && printf '\n%s\n' "$2" >&2
  exit 1
}

step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "Docker is not on PATH."
docker info >/dev/null 2>&1 || die "Docker is installed but not responding."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

[[ -f "${env_file}" ]] ||
  die "No production configuration at ${env_file}." \
    "Copy the example and edit every value:
  cp infra/.env.production.example infra/.env.production"
ok "Configuration at ${env_file}"

# Read values rather than sourcing: a Compose env file does not quote, so a
# display name with a space in it would be executed as a command.
setting() {
  local key="$1" fallback="${2-}" value
  value="$(sed -n "s/^${key}=//p" "${env_file}" | tail -1)"
  printf '%s' "${value:-${fallback}}"
}

step "Validating configuration"

app_origin="$(setting PRICKLESCOPE_APP_ORIGIN)"
site_address="$(setting PRICKLESCOPE_SITE_ADDRESS)"
secrets_dir_setting="$(setting PRICKLESCOPE_SECRETS_DIR ./secrets)"
secrets_dir="${infra_dir}/${secrets_dir_setting#./}"
runtime_setting="$(setting PRICKLESCOPE_TELEGRAF_RUNTIME_DIR ./runtime/telegraf)"
runtime_dir="${infra_dir}/${runtime_setting#./}"
telegraf_uid="$(setting TELEGRAF_UID 1000)"
telegraf_gid="$(setting TELEGRAF_GID 1000)"

[[ -n "${app_origin}" ]] || refuse "PRICKLESCOPE_APP_ORIGIN is not set."
[[ -n "${site_address}" ]] || refuse "PRICKLESCOPE_SITE_ADDRESS is not set."

if [[ -n "${app_origin}" && "${app_origin}" != https://* ]]; then
  # Cookies are marked Secure in production, and a browser will not return a
  # Secure cookie over http — nobody would be able to sign in.
  refuse "PRICKLESCOPE_APP_ORIGIN must be an https:// URL; found '${app_origin}'."
fi

if [[ -n "${app_origin}" && -n "${site_address}" ]]; then
  origin_host="${app_origin#https://}"
  origin_host="${origin_host%%/*}"
  origin_host="${origin_host%%:*}"
  if [[ "${site_address}" != "${origin_host}"* && "${site_address}" != :* ]]; then
    refuse "PRICKLESCOPE_SITE_ADDRESS ('${site_address}') is not the host in PRICKLESCOPE_APP_ORIGIN ('${origin_host}'). The API matches request origins against the second, and the gateway serves the first."
  fi
fi

# Passwords that ship in the example, and anything obviously left as a template.
for key in POSTGRES_PASSWORD QUESTDB_CONTROLLER_PASSWORD QUESTDB_GRAFANA_PASSWORD GRAFANA_ADMIN_PASSWORD; do
  value="$(setting "${key}")"
  if [[ -z "${value}" ]]; then
    refuse "${key} is not set."
  elif [[ "${value}" == change-me* || "${value}" == *dev-only* || "${value}" == prodtest-* ]]; then
    refuse "${key} still holds an example value. Generate one: openssl rand -base64 24"
  elif [[ "${#value}" -lt 16 ]]; then
    refuse "${key} is shorter than 16 characters."
  fi
done

step "Validating secrets"
key_file="${secrets_dir}/credential_key"
password_file="${secrets_dir}/bootstrap_admin_password"

if [[ ! -f "${key_file}" ]]; then
  refuse "No credential key at ${key_file}. Create one: openssl rand -base64 32 > '${key_file}'"
else
  key_value="$(tr -d '\n' <"${key_file}")"
  # The key that shipped in .env.example before it became a placeholder. Anyone
  # who copied that file is encrypting every credential under a published secret.
  if [[ "${key_value}" == "cHJpY2tsZXNjb3BlLWRldi1jcmVkZW50aWFsLWtleSE=" ]]; then
    refuse "The credential key is the example key from the repository. Everyone has it. Generate a new one."
  elif [[ "$(printf '%s' "${key_value}" | base64 -d 2>/dev/null | wc -c)" -ne 32 ]]; then
    refuse "The credential key must be exactly 32 bytes encoded as base64."
  else
    ok "Credential key is 32 bytes and not the published one"
  fi
fi

[[ -f "${password_file}" ]] ||
  refuse "No bootstrap administrator password at ${password_file}."

# The API container does not run as root, so it cannot read root's files.
for file in "${key_file}" "${password_file}"; do
  [[ -f "${file}" ]] || continue
  owner="$(stat -c '%u' "${file}")"
  mode="$(stat -c '%a' "${file}")"
  if [[ "${owner}" != "${telegraf_uid}" ]]; then
    refuse "${file} is owned by uid ${owner}, but the API runs as ${telegraf_uid}. Fix: chown ${telegraf_uid}:${telegraf_gid} '${file}'"
  fi
  if [[ "${mode}" != "400" && "${mode}" != "600" ]]; then
    refuse "${file} is mode ${mode}; it should be 400. Fix: chmod 400 '${file}'"
  fi
done

if [[ ${#problems[@]} -gt 0 ]]; then
  printf '\n\033[31mRefusing to start: %d problem(s) above.\033[0m\n' "${#problems[@]}" >&2
  printf 'Nothing has been changed. See docs/deployment.md.\n' >&2
  exit 1
fi
ok "Configuration and secrets are usable"

if [[ "${check_only}" -eq 1 ]]; then
  printf '\n\033[32mConfiguration is valid.\033[0m Nothing was started.\n'
  exit 0
fi

step "Preparing persistent storage"
# The API writes the rendered collector configuration here at mode 0600 and
# Telegraf reads it, which only works if both run as the same account.
mkdir -p "${runtime_dir}/active" "${runtime_dir}/revisions"
if [[ "$(stat -c '%u' "${runtime_dir}")" != "${telegraf_uid}" ]]; then
  chown -R "${telegraf_uid}:${telegraf_gid}" "${runtime_dir}" 2>/dev/null ||
    die "Could not set ownership on ${runtime_dir}." \
      "Run: sudo chown -R ${telegraf_uid}:${telegraf_gid} '${runtime_dir}'"
fi
ok "Collector runtime directory ready, owned by ${telegraf_uid}:${telegraf_gid}"

compose=(docker compose --env-file "${env_file}"
  --file "${infra_dir}/compose.yaml"
  --file "${infra_dir}/compose.production.yaml")

"${compose[@]}" config --quiet || die "The merged Compose model did not validate."
ok "Compose model is valid"

step "Starting the stack"
build_args=()
[[ "${build}" -eq 1 ]] && build_args+=(--build)
"${compose[@]}" up --detach --remove-orphans "${build_args[@]}" --wait --wait-timeout 300 ||
  die "Not every container became healthy." \
    "Inspect them with:
  docker compose --env-file ${env_file} -f infra/compose.yaml -f infra/compose.production.yaml ps
  docker compose --env-file ${env_file} -f infra/compose.yaml -f infra/compose.production.yaml logs --tail 50"

step "Service health"
"${compose[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Publishers}}'

published="$("${compose[@]}" ps --format '{{.Service}} {{.Publishers}}')"
unexpected=0
while read -r line; do
  service="${line%% *}"
  [[ "${service}" == "web" || -z "${service}" ]] && continue
  if [[ "${line}" == *"0.0.0.0"* || "${line}" == *"[::]"* ]]; then
    printf '    \033[31m✗\033[0m %s is published to the host; only the gateway should be.\n' "${service}"
    unexpected=1
  fi
done <<<"${published}"
[[ "${unexpected}" -eq 0 ]] && ok "Only the gateway is reachable from outside"

step "Ready"
note "PrickleScope   ${app_origin}"
note "Grafana        ${app_origin}/grafana/  (through the authenticated gateway)"
echo
note "Verify the origin end to end:  ./infra/verify-production-origin.sh"
note "Back up before you need to:    ./infra/backup.sh /path/to/backup"
note "The credential key is not in any backup this project takes. Store it separately."
