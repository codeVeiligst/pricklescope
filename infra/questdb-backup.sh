#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="${script_dir}/.env"
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
  echo "Missing ${env_file}; start the development infrastructure first." >&2
  exit 2
fi

# shellcheck disable=SC1090
source "${env_file}"
questdb_url="http://127.0.0.1:${QUESTDB_HTTP_PORT:-9000}/exec"
checkpoint_active=false

release_checkpoint() {
  if [[ "${checkpoint_active}" == true ]]; then
    curl --fail --silent --show-error --get \
      --data-urlencode 'query=CHECKPOINT RELEASE' "${questdb_url}" >/dev/null
    checkpoint_active=false
  fi
}
trap release_checkpoint EXIT

mkdir -p "${backup_dir}"
curl --fail --silent --show-error --get \
  --data-urlencode 'query=CHECKPOINT CREATE' "${questdb_url}" >/dev/null
checkpoint_active=true

docker compose --env-file "${env_file}" --file "${compose_file}" \
  cp questdb:/var/lib/questdb/. "${backup_dir}/questdb-root"

release_checkpoint
printf 'QuestDB OSS backup created at %s\n' "${backup_dir}/questdb-root"
