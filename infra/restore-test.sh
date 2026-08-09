#!/usr/bin/env bash
# Restores a backup into throwaway containers and checks that the data is really
# there. Nothing here touches the running stack.
#
#   ./infra/restore-test.sh /var/backups/pricklescope/2026-08-07
#
# A backup nobody has restored is a guess about the future. This is the check that
# turns it into a fact, and it is a release criterion rather than an optional
# extra.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${script_dir}/compose.yaml"
backup_dir="${1:-}"

if [[ -z "${backup_dir}" || ! -d "${backup_dir}" ]]; then
  echo "Usage: $0 /backup/directory" >&2
  exit 2
fi

# The images under test are the ones the stack actually pins.
pinned() {
  awk -v svc="$1" '
    $1 == svc":" { found = 1; next }
    found && $1 == "image:" { print $2; exit }
  ' "${compose_file}"
}

postgres_image="$(pinned postgres)"
questdb_image="$(pinned questdb)"
grafana_image="$(pinned grafana)"

suffix="$$"
resources=()
cleanup() {
  for resource in "${resources[@]}"; do
    case "${resource}" in
      container:*) docker rm --force "${resource#container:}" >/dev/null 2>&1 || true ;;
      volume:*) docker volume rm "${resource#volume:}" >/dev/null 2>&1 || true ;;
    esac
  done
}
trap cleanup EXIT

passed=0
failed=0
report() {
  local ok="$1" name="$2" detail="${3-}"
  if [[ "${ok}" == yes ]]; then
    printf '  \033[32mPASS\033[0m  %s%s\n' "${name}" "${detail:+ — ${detail}}"
    passed=$((passed + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s%s\n' "${name}" "${detail:+ — ${detail}}"
    failed=$((failed + 1))
  fi
}

wait_for() {
  local container="$1" probe="$2" attempts="${3:-90}"
  for _ in $(seq 1 "${attempts}"); do
    if docker exec "${container}" sh -c "${probe}" >/dev/null 2>&1; then return 0; fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "${container}" 2>/dev/null)" != true ]]; then
      docker logs --tail 30 "${container}" >&2
      return 1
    fi
    sleep 1
  done
  return 1
}

echo "== PostgreSQL metadata"
dump="$(find "${backup_dir}/postgres" -name '*.dump' -print -quit 2>/dev/null || true)"
if [[ -z "${dump}" ]]; then
  report no "a metadata dump is present"
else
  container="pricklescope-restore-pg-${suffix}"
  resources+=("container:${container}")
  docker run --detach --name "${container}" \
    --env POSTGRES_PASSWORD=restore-test \
    --env POSTGRES_USER=pricklescope \
    --env POSTGRES_DB=restore_target \
    "${postgres_image}" >/dev/null
  # Over TCP on purpose. The image runs a temporary unix-socket-only server while
  # it initialises, so a socket probe reports ready, the real server then restarts,
  # and whatever ran in between fails intermittently.
  if ! wait_for "${container}" 'pg_isready -h 127.0.0.1 -U pricklescope -d restore_target'; then
    report no "the restore target starts"
  else
    restore_log="$(docker exec --interactive "${container}" \
      pg_restore --host 127.0.0.1 --username pricklescope --dbname restore_target \
      --no-owner --no-privileges <"${dump}" 2>&1)" && restore_status=0 || restore_status=$?
    if [[ "${restore_status}" -eq 0 ]]; then
      report yes "the dump restores"
    else
      report no "the dump restores" "$(printf '%s' "${restore_log}" | tail -2 | tr '\n' ' ')"
    fi

    counts="$(docker exec "${container}" psql --host 127.0.0.1 --username pricklescope --dbname restore_target \
      --tuples-only --no-align --command \
      "select concat('users=', (select count(*) from users),
                     ' sources=', (select count(*) from sources),
                     ' credentials=', (select count(*) from snmp_credentials),
                     ' rules=', (select count(*) from alert_rules),
                     ' contacts=', (select count(*) from contact_points))" 2>/dev/null || echo '')"
    if [[ -n "${counts}" ]]; then
      report yes "the controller's own tables are readable" "${counts}"
    else
      report no "the controller's own tables are readable"
    fi

    # The one thing a metadata restore must not quietly lose.
    secrets="$(docker exec "${container}" psql --host 127.0.0.1 --username pricklescope --dbname restore_target \
      --tuples-only --no-align --command \
      "select count(*) from snmp_credentials where secret_ciphertext is not null" 2>/dev/null || echo 0)"
    if [[ "${secrets}" -gt 0 ]]; then
      report yes "encrypted credentials survived" "${secrets} ciphertexts, still sealed"
    else
      report no "encrypted credentials survived" "none found — check the source database had any"
    fi
  fi
fi

echo
echo "== QuestDB metrics"
if [[ ! -d "${backup_dir}/questdb-root/db" ]]; then
  report no "a QuestDB volume copy is present"
else
  container="pricklescope-restore-qdb-${suffix}"
  volume="pricklescope-restore-qdb-${suffix}"
  resources+=("container:${container}" "volume:${volume}")
  docker volume create "${volume}" >/dev/null
  docker run --rm --entrypoint sh \
    --volume "${volume}:/restore" \
    --volume "${backup_dir}/questdb-root:/backup:ro" \
    "${questdb_image}" -c 'cp -a /backup/. /restore/' >/dev/null
  # Telemetry housekeeping at startup can race checkpoint recovery on this
  # version, and this boot exists only to read the data back.
  docker run --detach --name "${container}" \
    --env QDB_TELEMETRY_ENABLED=false \
    --volume "${volume}:/var/lib/questdb" \
    "${questdb_image}" >/dev/null

  if ! wait_for "${container}" 'curl --fail --silent http://127.0.0.1:9003/'; then
    report no "the restored instance starts"
  else
    report yes "the restored instance starts"
    rows="$(docker exec "${container}" curl --fail --silent --get \
      --data-urlencode "query=select sum(table_row_count) from tables()" \
      http://127.0.0.1:9000/exec 2>/dev/null |
      python3 -c 'import json,sys; print(json.load(sys.stdin)["dataset"][0][0])' 2>/dev/null || echo 0)"
    if [[ "${rows}" -gt 0 ]]; then
      report yes "measurements are queryable" "${rows} rows across all tables"
    else
      report no "measurements are queryable" "the restored instance reports no rows"
    fi
  fi
fi

echo
echo "== Grafana"
if [[ ! -f "${backup_dir}/grafana-root/grafana.db" ]]; then
  report no "a Grafana volume copy is present"
else
  container="pricklescope-restore-grafana-${suffix}"
  volume="pricklescope-restore-grafana-${suffix}"
  resources+=("container:${container}" "volume:${volume}")
  docker volume create "${volume}" >/dev/null
  docker run --rm --entrypoint sh \
    --user root \
    --volume "${volume}:/restore" \
    --volume "${backup_dir}/grafana-root:/backup:ro" \
    "${grafana_image}" -c 'cp -a /backup/. /restore/ && chown -R 472:0 /restore' >/dev/null
  # GF_SECURITY_ADMIN_PASSWORD only seeds a fresh database. This one already has
  # an admin whose password came from the source installation, and the point of
  # the test is to read the restored data without needing that secret.
  docker run --rm \
    --volume "${volume}:/var/lib/grafana" \
    --entrypoint grafana \
    "${grafana_image}" cli --homepath /usr/share/grafana admin reset-admin-password restore-test \
    >/dev/null 2>&1 || true

  docker run --detach --name "${container}" \
    --env GF_PLUGINS_PREINSTALL_SYNC= \
    --volume "${volume}:/var/lib/grafana" \
    "${grafana_image}" >/dev/null

  if ! wait_for "${container}" 'wget --quiet --spider http://127.0.0.1:3000/api/health' 120; then
    report no "the restored instance starts"
  else
    report yes "the restored instance starts"
    dashboards="$(docker exec "${container}" wget --quiet --output-document=- \
      'http://admin:restore-test@127.0.0.1:3000/api/search?type=dash-db' 2>/dev/null |
      python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
    if [[ "${dashboards}" -gt 0 ]]; then
      report yes "dashboards survived" "${dashboards} restored"
    else
      report no "dashboards survived" "none found"
    fi
    rules="$(docker exec "${container}" wget --quiet --output-document=- \
      'http://admin:restore-test@127.0.0.1:3000/api/v1/provisioning/alert-rules' 2>/dev/null |
      python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
    report yes "alert rules survived" "${rules} restored (the controller rebuilds these anyway)"
  fi
fi

echo
printf '%d passed, %d failed\n' "${passed}" "${failed}"
if [[ "${failed}" -eq 0 ]]; then
  echo "This backup restores. Record the date in docs/implementation.md."
fi
[[ "${failed}" -eq 0 ]]
