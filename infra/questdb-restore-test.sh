#!/usr/bin/env bash
set -Eeuo pipefail

backup_root="${1:-}"
image='questdb/questdb:9.4.3@sha256:3fd139f9f16015afc1b064fe4591b271be26cdec10315415e5511e9d80a5919e'
suffix="${BASHPID}"
container="pricklescope-restore-test-${suffix}"
volume="pricklescope-restore-test-${suffix}"

if [[ -z "${backup_root}" || ! -d "${backup_root}/db" || ! -d "${backup_root}/.checkpoint" ]]; then
  echo "Usage: $0 /backup/directory/questdb-root" >&2
  exit 2
fi

cleanup() {
  docker rm --force "${container}" >/dev/null 2>&1 || true
  docker volume rm "${volume}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "${volume}" >/dev/null
docker run --rm --entrypoint sh \
  --volume "${volume}:/restore" \
  --volume "${backup_root}:/backup:ro" \
  "${image}" -c 'cp -a /backup/. /restore/ && touch /restore/_restore'

# QuestDB 9.4.3 telemetry startup housekeeping can race checkpoint recovery.
# Disable telemetry for this first, isolated recovery boot.
docker run --detach --name "${container}" \
  --env QDB_TELEMETRY_ENABLED=false \
  --volume "${volume}:/var/lib/questdb" \
  "${image}" >/dev/null

for _attempt in $(seq 1 60); do
  if docker exec "${container}" curl --fail --silent http://127.0.0.1:9003/ >/dev/null 2>&1; then
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${container}")" != true ]]; then
    docker logs "${container}" >&2
    exit 1
  fi
  sleep 1
done

docker exec "${container}" curl --fail --silent --get \
  --data-urlencode "query=select table_name, table_row_count from tables() where table_name in ('network_interface', 'network_interface_rate', 'network_interface_rate_5m', 'network_interface_rate_1h') order by table_name" \
  http://127.0.0.1:9000/exec
printf '\nQuestDB backup restored and queried successfully in an isolated container.\n'
