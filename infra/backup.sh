#!/usr/bin/env bash
# Takes one consistent backup of everything that cannot be rebuilt.
#
#   ./infra/backup.sh /var/backups/pricklescope/2026-08-07
#
# Three stores, three different consistency requirements:
#
#   postgres  a logical dump, consistent by definition inside one transaction
#   questdb   a checkpoint, so the volume copy is not a torn snapshot
#   grafana   SQLite, which has no online copy here, so the container is stopped
#             for the few seconds the copy takes
#
# Deliberately NOT backed up:
#
#   PRICKLESCOPE_CREDENTIAL_KEY  keeping the key beside the ciphertext it opens
#                                would undo the reason for having it. Back it up
#                                separately, and know that without it the SNMP,
#                                OIDC, Grafana, and mail credentials in the dump
#                                are unrecoverable.
#   Telegraf configuration       regenerated from desired state by a reconcile.
#   Grafana dashboards and rules the controller owns them and rewrites them.
#
# Verify what this produces with ./infra/restore-test.sh — an untested backup is
# a guess.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Which stack to back up. This defaulted to .env — the development file — so on
# a production host, which has .env.production and no .env, the command
# deployment.md tells you to run failed outright. Production comes first
# because that is where a backup means anything.
if [[ -n "${PRICKLESCOPE_ENV_FILE:-}" ]]; then
  env_file="${PRICKLESCOPE_ENV_FILE}"
elif [[ -f "${script_dir}/.env.production" ]]; then
  env_file="${script_dir}/.env.production"
else
  env_file="${script_dir}/.env"
fi
compose_file="${script_dir}/compose.yaml"
backup_dir="${1:-}"

if [[ -z "${backup_dir}" ]]; then
  echo "Usage: $0 /new/backup/directory" >&2
  exit 2
fi
if [[ -e "${backup_dir}" ]]; then
  echo "Backup destination already exists: ${backup_dir}" >&2
  exit 2
fi
if [[ ! -f "${env_file}" ]]; then
  echo "Missing ${env_file}; start the stack first," >&2
  echo "or name the environment explicitly:" >&2
  echo "  PRICKLESCOPE_ENV_FILE=infra/.env.production $0 ${backup_dir}" >&2
  exit 2
fi
echo "Backing up the stack described by ${env_file}"

setting() {
  local key="$1" fallback="${2-}" value
  value="$(sed -n "s/^${key}=//p" "${env_file}" | tail -1)"
  printf '%s' "${value:-${fallback}}"
}

postgres_db="$(setting POSTGRES_DB pricklescope)"
postgres_user="$(setting POSTGRES_USER pricklescope)"

compose=(docker compose --env-file "${env_file}" --file "${compose_file}")

mkdir -p "${backup_dir}"
started_at="$(date --iso-8601=seconds)"

echo "== PostgreSQL metadata"
mkdir -p "${backup_dir}/postgres"
# Custom format so pg_restore can rebuild selectively and in parallel.
"${compose[@]}" exec --no-TTY postgres \
  pg_dump --username "${postgres_user}" --dbname "${postgres_db}" --format=custom \
  >"${backup_dir}/postgres/${postgres_db}.dump"
echo "   $(du -h "${backup_dir}/postgres/${postgres_db}.dump" | cut -f1) written"

echo "== QuestDB metrics"
# From inside the container, not from the host. QuestDB's HTTP port is published
# on 127.0.0.1 in development and not published at all in production, so a host
# request worked on a developer's machine and failed on every deployment this
# script exists for. Inside the container the port is always there.
checkpoint_active=false
questdb_exec() {
  "${compose[@]}" exec -T questdb \
    curl --fail --silent --show-error --get \
    --data-urlencode "query=$1" 'http://127.0.0.1:9000/exec' >/dev/null
}
release_checkpoint() {
  if [[ "${checkpoint_active}" == true ]]; then
    questdb_exec 'CHECKPOINT RELEASE'
    checkpoint_active=false
  fi
}
trap release_checkpoint EXIT
questdb_exec 'CHECKPOINT CREATE'
checkpoint_active=true
"${compose[@]}" cp questdb:/var/lib/questdb/. "${backup_dir}/questdb-root"
release_checkpoint
echo "   $(du -sh "${backup_dir}/questdb-root" | cut -f1) written"

echo "== Grafana"
# SQLite cannot be copied safely from underneath a running writer, and this image
# carries no sqlite3 to run an online backup with. Stopping Grafana for the copy
# is the honest option: alert evaluation pauses for a few seconds and resumes.
mkdir -p "${backup_dir}/grafana"
"${compose[@]}" stop grafana >/dev/null
"${compose[@]}" cp grafana:/var/lib/grafana/. "${backup_dir}/grafana-root" || {
  "${compose[@]}" start grafana >/dev/null
  echo "Grafana copy failed; the container has been restarted." >&2
  exit 1
}
"${compose[@]}" start grafana >/dev/null
rmdir "${backup_dir}/grafana" 2>/dev/null || true
echo "   $(du -sh "${backup_dir}/grafana-root" | cut -f1) written"

cat >"${backup_dir}/manifest.txt" <<MANIFEST
PrickleScope backup
started              ${started_at}
finished             $(date --iso-8601=seconds)
host                 $(hostname)
compose project      $(setting COMPOSE_PROJECT_NAME pricklescope)
postgres database    ${postgres_db}

Contents
  postgres/${postgres_db}.dump   pg_dump custom format
  questdb-root/                  QuestDB volume taken under CHECKPOINT
  grafana-root/                  Grafana volume, copied with the container stopped

Not in this backup
  PRICKLESCOPE_CREDENTIAL_KEY    stored separately on purpose. Without it every
                                 encrypted credential in the dump stays encrypted.

Verify with
  ./infra/restore-test.sh ${backup_dir}
MANIFEST

echo
echo "Backup complete: ${backup_dir}"
echo "The credential key is NOT in it. Confirm it is backed up somewhere else."
