#!/usr/bin/env bash
# Checks the things that only a production-like origin can show: secure cookies,
# HTTPS, and the Grafana gateway under TLS. Development serves plain HTTP by
# design, so none of this can be exercised there.
#
#   ./infra/verify-production-origin.sh                          the fixture
#   ./infra/verify-production-origin.sh --env-file infra/.env.production \
#     --no-build                                                 your deployment
#
# With no arguments it brings up the fixture stack described by
# infra/.env.verification — deliberately weak passwords, kept separate from
# infra/.env.production so a real deployment cannot inherit them, and
# ./scripts/prod-up.sh refuses to start with values like these. It leaves the
# stack running; pass --down to stop it afterwards.
#
# --env-file points the same checks at a deployment you already have, which is
# what deployment.md's verification step means. --no-build goes with it: the
# script used to rebuild unconditionally, so it could neither check a deployment
# running published images nor avoid restarting the thing it was inspecting.
#
# It signs in as the bootstrap administrator, so run it before removing that
# account.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
env_file="${script_dir}/.env.verification"
build=1
down=0
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -n "${2-}" ]] || { echo "--env-file needs a path" >&2; exit 2; }
      env_file="$(cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")"
      shift 2
      ;;
    --no-build) build=0; shift ;;
    --down) down=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

compose=(docker compose --env-file "${env_file}"
  --file "${script_dir}/compose.yaml"
  --file "${script_dir}/compose.production.yaml")

if [[ ! -f "${env_file}" ]]; then
  if [[ "${env_file}" == "${script_dir}/.env.verification" ]]; then
    echo "Create ${env_file} from .env.production.example to run the fixture," >&2
    echo "or check a deployment you already have:" >&2
    echo "  $0 --env-file infra/.env.production --no-build" >&2
  else
    echo "No such environment file: ${env_file}" >&2
  fi
  exit 1
fi

# Read values rather than sourcing the file: a Compose env file does not quote
# values, so a display name with a space in it would be run as a command.
setting() {
  local key="$1" fallback="${2-}" value
  value="$(sed -n "s/^${key}=//p" "${env_file}" | tail -1)"
  printf '%s' "${value:-${fallback}}"
}

origin="$(setting PRICKLESCOPE_APP_ORIGIN)"
[[ -n "${origin}" ]] || { echo "PRICKLESCOPE_APP_ORIGIN must be set in ${env_file}" >&2; exit 1; }
admin_user="$(setting PRICKLESCOPE_BOOTSTRAP_ADMIN_USERNAME admin)"
http_port="$(setting PRICKLESCOPE_HTTP_PORT 80)"
https_port="$(setting PRICKLESCOPE_HTTPS_PORT 443)"
secrets_dir="$(setting PRICKLESCOPE_SECRETS_DIR ./secrets)"
admin_password="$(cat "${script_dir}/${secrets_dir#./}/bootstrap_admin_password")"

workspace="$(mktemp -d)"
cleanup() {
  rm -rf "${workspace}"
  if [[ "${down}" -eq 1 ]]; then "${compose[@]}" down; fi
}
trap cleanup EXIT

passed=0
failed=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "${actual}" == *"${expected}"* ]]; then
    printf '  \033[32mPASS\033[0m  %s\n' "${name}"
    passed=$((passed + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s\n         expected to contain: %s\n         got: %s\n' \
      "${name}" "${expected}" "${actual}"
    failed=$((failed + 1))
  fi
}

refute() {
  local name="$1" forbidden="$2" actual="$3"
  if [[ "${actual}" != *"${forbidden}"* ]]; then
    printf '  \033[32mPASS\033[0m  %s\n' "${name}"
    passed=$((passed + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s\n         must not contain: %s\n         got: %s\n' \
      "${name}" "${forbidden}" "${actual}"
    failed=$((failed + 1))
  fi
}

if [[ "${build}" -eq 1 ]]; then
  echo "Starting the production-like stack..."
  "${compose[@]}" up --detach --build --wait --wait-timeout 300 >/dev/null
else
  echo "Checking the running stack described by ${env_file}..."
  "${compose[@]}" up --detach --no-build --wait --wait-timeout 300 >/dev/null
fi

# Caddy issues its own certificate for a local site address. Trust that root
# rather than turning verification off, so the check proves TLS actually works.
ca="${workspace}/root.crt"
"${compose[@]}" exec -T web cat /data/caddy/pki/authorities/local/root.crt >"${ca}" 2>/dev/null || true
curl_opts=(--silent --show-error)
if [[ -s "${ca}" ]]; then curl_opts+=(--cacert "${ca}"); fi

jar="${workspace}/cookies"
http_origin="${origin/https:/http:}"
http_origin="${http_origin/:${https_port}/:${http_port}}"

echo
echo "Transport"
check 'plain HTTP is redirected, not served' '308' \
  "$(curl "${curl_opts[@]}" -o /dev/null -D - "${http_origin}/" | head -1)"
check 'the redirect points at HTTPS' 'Location: https://' \
  "$(curl "${curl_opts[@]}" -o /dev/null -D - "${http_origin}/")"
check 'the application shell is served over HTTPS' 'HTTP/2 200' \
  "$(curl "${curl_opts[@]}" -o /dev/null -D - "${origin}/" | head -1)"

shell_headers="$(curl "${curl_opts[@]}" -o /dev/null -D - "${origin}/")"
echo
echo "Application shell headers"
check 'HSTS is declared' 'strict-transport-security: max-age=31536000' "${shell_headers}"
check 'the page may not be framed' "frame-ancestors 'none'" "${shell_headers}"
check 'nothing loads from another origin' "default-src 'self'" "${shell_headers}"
check 'content types are not sniffed' 'x-content-type-options: nosniff' "${shell_headers}"

echo
echo "Session cookie"
login_headers="$(curl "${curl_opts[@]}" -o /dev/null -D - -c "${jar}" \
  -H 'content-type: application/json' -H "origin: ${origin}" \
  -d "{\"username\":\"${admin_user}\",\"password\":\"${admin_password}\"}" \
  "${origin}/api/v1/auth/login")"
set_cookie="$(printf '%s' "${login_headers}" | grep -i '^set-cookie:' || echo 'no cookie was set')"
check 'the cookie is marked Secure' 'Secure' "${set_cookie}"
check 'the cookie is HttpOnly' 'HttpOnly' "${set_cookie}"
check 'the cookie is SameSite=Lax' 'SameSite=Lax' "${set_cookie}"
refute 'the cookie is not readable across sites' 'SameSite=None' "${set_cookie}"

echo
echo "Grafana gateway"
check 'no session, no Grafana' '401' \
  "$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' "${origin}/grafana/api/user")"
identity="$(curl "${curl_opts[@]}" -b "${jar}" "${origin}/grafana/api/user")"
check 'the session decides who Grafana sees' '"login":"ps-' "${identity}"
refute 'the session is not a Grafana administrator' '"isGrafanaAdmin":true' "${identity}"
spoofed="$(curl "${curl_opts[@]}" -b "${jar}" \
  -H 'X-WEBAUTH-USER: admin' -H 'X-WEBAUTH-ROLE: Admin' "${origin}/grafana/api/user")"
check 'a client cannot supply its own identity' "$(printf '%s' "${identity}" | grep -o '"login":"[^"]*"')" \
  "${spoofed}"
refute 'a client cannot promote itself' '"isGrafanaAdmin":true' "${spoofed}"

echo
echo "Request guards"
check 'a foreign origin cannot mutate' '403' \
  "$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' -b "${jar}" \
    -H 'content-type: application/json' -H 'origin: https://elsewhere.example' \
    -X POST -d '{}' "${origin}/api/v1/alerts/reconcile")"
check 'a missing CSRF token is refused' 'csrf_invalid' \
  "$(curl "${curl_opts[@]}" -b "${jar}" -H 'content-type: application/json' \
    -H "origin: ${origin}" -X POST -d '{}' "${origin}/api/v1/alerts/reconcile")"
check 'errors carry a request id' 'requestId' \
  "$(curl "${curl_opts[@]}" "${origin}/api/v1/system/health")"

echo
echo "Exposure"
published="$("${compose[@]}" ps --format '{{.Service}} {{.Publishers}}')"
for service in postgres questdb grafana telegraf api; do
  line="$(printf '%s' "${published}" | grep "^${service} " || true)"
  refute "${service} is not published" '0.0.0.0' "${line}"
done

echo
printf '%d passed, %d failed\n' "${passed}" "${failed}"
[[ "${failed}" -eq 0 ]]
