#!/usr/bin/env bash
# Start PrickleScope for development.
#
#   ./scripts/dev-up.sh              containers, migrations, admin account, dev servers
#   ./scripts/dev-up.sh --infra      containers only (what the test suites need)
#   ./scripts/dev-up.sh --no-serve   everything except the dev servers
#   ./scripts/dev-up.sh --help
#
# Safe to run repeatedly: it creates what is missing and leaves what is not.
#
# This is the only development startup script. It used to be two — this one and
# infra/dev-up.sh — which meant two places to look when something would not start
# and two sets of prerequisite checks that had drifted apart.

set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
infra_dir="${repo_dir}/infra"
app_env="${repo_dir}/.env"
infra_env="${infra_dir}/.env"
compose_file="${infra_dir}/compose.yaml"

mode="all"
case "${1:-}" in
  --infra) mode="infra" ;;
  --no-serve) mode="no-serve" ;;
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
die() {
  printf '\n\033[31mCannot start:\033[0m %s\n' "$1" >&2
  [[ -n "${2:-}" ]] && printf '\n%s\n' "$2" >&2
  exit 1
}

step "Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  die "Node is not on PATH." "Install Node 24, or run 'nvm use' in this repository."
fi
node_version="$(node --version)"
if [[ "${node_version}" != v24.* ]]; then
  die "Node ${node_version} is not supported; PrickleScope needs Node 24." \
    "Run 'nvm use' in this repository — .nvmrc pins the exact version."
fi
ok "Node ${node_version}"

command -v corepack >/dev/null 2>&1 ||
  die "Corepack is not on PATH." "It ships with Node 24: run 'corepack enable'."
ok "corepack $(corepack --version 2>/dev/null || echo present)"

command -v docker >/dev/null 2>&1 ||
  die "Docker is not on PATH." "Install Docker Engine or Docker Desktop and start it."
docker info >/dev/null 2>&1 ||
  die "Docker is installed but not responding." "Start the Docker daemon, then retry."
docker compose version >/dev/null 2>&1 ||
  die "Docker Compose v2 is required." "Update Docker; 'docker-compose' v1 will not work."
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

command -v openssl >/dev/null 2>&1 ||
  die "OpenSSL is required to generate a credential key." "Install openssl, then retry."
ok "openssl present"

step "Preparing configuration"

if [[ ! -f "${app_env}" ]]; then
  cp "${repo_dir}/.env.example" "${app_env}"
  # A generated key, not the placeholder from the example. Every developer's
  # instance gets its own, and nothing in the repository can decrypt it.
  credential_key="$(openssl rand -base64 32)"
  tmp_env="$(mktemp)"
  sed "s|^PRICKLESCOPE_CREDENTIAL_KEY=.*|PRICKLESCOPE_CREDENTIAL_KEY=${credential_key}|" \
    "${app_env}" >"${tmp_env}"
  mv "${tmp_env}" "${app_env}"
  chmod 600 "${app_env}"
  ok "Created .env with a freshly generated credential key"
  note "Losing that key means losing every secret stored under it."
else
  ok ".env already exists, left alone"
fi

if [[ ! -f "${infra_env}" ]]; then
  cp "${infra_dir}/.env.example" "${infra_env}"
  chmod 600 "${infra_env}"
  ok "Created infra/.env with development-only container credentials"
else
  ok "infra/.env already exists, left alone"
fi

# Telegraf reads configuration the API writes at mode 0600, so both have to run
# as the same account.
export TELEGRAF_UID="${TELEGRAF_UID:-$(id -u)}"
export TELEGRAF_GID="${TELEGRAF_GID:-$(id -g)}"
ok "Collector runs as ${TELEGRAF_UID}:${TELEGRAF_GID} (this account)"

compose=(docker compose --env-file "${infra_env}" --file "${compose_file}")

if ! "${compose[@]}" config --quiet 2>/tmp/pricklescope-compose-error; then
  die "The Compose file did not validate." "$(cat /tmp/pricklescope-compose-error)"
fi
ok "Compose model is valid"

step "Starting containers"
"${compose[@]}" up --detach --remove-orphans --wait --wait-timeout 180 ||
  die "The containers did not all become healthy." \
    "Inspect them with:
  docker compose --env-file infra/.env -f infra/compose.yaml ps
  docker compose --env-file infra/.env -f infra/compose.yaml logs --tail 50"
"${compose[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

setting() {
  local key="$1" fallback="${2-}" value
  value="$(sed -n "s/^${key}=//p" "${infra_env}" | tail -1)"
  printf '%s' "${value:-${fallback}}"
}

postgres_user="$(setting POSTGRES_USER pricklescope)"
test_db="$(setting POSTGRES_TEST_DB pricklescope_test)"
grafana_port="$(setting GRAFANA_HTTP_PORT 3000)"
questdb_port="$(setting QUESTDB_HTTP_PORT 9000)"
postgres_port="$(setting POSTGRES_PORT 5432)"
grafana_user="$(setting GRAFANA_ADMIN_USER admin)"

step "Preparing the integration-test database"
# The suites truncate every table they find, so the name has to be unmistakable.
if [[ ! "${test_db}" =~ ^[A-Za-z_][A-Za-z0-9_]*_test$ ]]; then
  die "POSTGRES_TEST_DB must be a simple name ending in _test; found '${test_db}'." \
    "The integration suite truncates the tables in that database. Refusing to guess."
fi
exists="$("${compose[@]}" exec --no-TTY postgres \
  psql --username "${postgres_user}" --dbname postgres --tuples-only --no-align \
  --command "select 1 from pg_database where datname = '${test_db}'")"
if [[ "${exists}" != "1" ]]; then
  "${compose[@]}" exec --no-TTY postgres \
    createdb --username "${postgres_user}" "${test_db}"
  ok "Created ${test_db}"
else
  ok "${test_db} already exists"
fi

if [[ "${mode}" == "infra" ]]; then
  step "Ready"
  note "Grafana          http://localhost:${grafana_port}  (user ${grafana_user})"
  note "QuestDB console  http://localhost:${questdb_port}"
  note "PostgreSQL       localhost:${postgres_port}"
  echo
  note "Container credentials are in infra/.env and are for local development only."
  note "Start the application with: corepack pnpm dev"
  exit 0
fi

step "Building the workspace packages"
cd "${repo_dir}"
# `apps/*` import the dist/ output of these four, not their sources, and the
# migration CLI below is the first thing to need it. On a fresh clone that output
# does not exist yet, which made the documented quick start fail at migrations.
corepack pnpm --filter @pricklescope/contracts --filter @pricklescope/db \
  --filter @pricklescope/adapters --filter @pricklescope/ui \
  --workspace-concurrency=1 build ||
  die "The workspace packages did not build." "Run 'corepack pnpm build' to see the error in full."
ok "contracts, db, adapters, and ui built"

step "Applying migrations"
corepack pnpm db:migrate ||
  die "Migrations failed." "Check that PostgreSQL is healthy and PRICKLESCOPE_DATABASE_URL in .env points at it."
ok "Schema is current"

step "Ensuring an administrator account"
corepack pnpm db:bootstrap ||
  die "Could not create the bootstrap administrator." "See the error above; the credentials come from .env."
ok "Administrator ready"

admin_user="$(sed -n 's/^PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME=//p' "${app_env}" | tail -1)"

step "Ready"
note "PrickleScope     http://localhost:5173  (sign in as ${admin_user:-admin})"
note "API              http://localhost:3001"
note "Grafana          http://localhost:${grafana_port}"
note "QuestDB console  http://localhost:${questdb_port}"
echo
note "The password is in .env. These values are for local development only."

if [[ "${mode}" == "no-serve" ]]; then
  echo
  note "Start the application with: corepack pnpm dev"
  exit 0
fi

echo
exec corepack pnpm dev
