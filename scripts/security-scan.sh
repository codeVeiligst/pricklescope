#!/usr/bin/env bash
# Static analysis and secret scanning over first-party code.
#
#   ./scripts/security-scan.sh          both
#   ./scripts/security-scan.sh sast     Semgrep only
#   ./scripts/security-scan.sh secrets  gitleaks only
#   ./scripts/security-scan.sh selftest prove both tools still detect anything
#
# Companion to ./scripts/scan.sh, which covers dependency advisories and container
# images. This one reads the code the project wrote.
#
# `selftest` exists because both tools reported a clean repository on their first
# run here, and one of them was silently reporting nothing at all — the report was
# being written somewhere it could not be read. A scanner that cannot be shown to
# find a planted secret is not evidence of anything.

set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

# Pinned by tag and digest, like every other image the project runs.
SEMGREP_IMAGE="semgrep/semgrep:1.145.0"
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1"

mode="${1:-all}"
workspace="$(mktemp -d)"
trap 'rm -rf "${workspace}"' EXIT
failures=0

run_sast() {
  local target="${1:-${repo_dir}}"
  echo "== Semgrep (project rules, plus the community rulesets)"
  docker run --rm -v "${target}:/src:ro" -v "${workspace}:/out" -w /src "${SEMGREP_IMAGE}" \
    semgrep --config /src/scripts/semgrep-rules.yml \
    --config p/typescript --config p/nodejs --config p/owasp-top-ten \
    --exclude node_modules --exclude dist --exclude test-results \
    --metrics off --quiet --json --output /out/semgrep.json >/dev/null 2>&1 || true

  if [[ ! -s "${workspace}/semgrep.json" ]]; then
    echo "  Semgrep produced no report" >&2
    failures=$((failures + 1))
    return
  fi
  python3 "${repo_dir}/scripts/security-scan-report.py" semgrep "${workspace}/semgrep.json" \
    "${repo_dir}/scripts/security-scan-exceptions.txt" || failures=$((failures + 1))
  echo
}

run_secrets() {
  local target="${1:-${repo_dir}}"
  echo "== gitleaks"
  # The report goes to a mounted directory. Writing it to /dev/stdout inside the
  # container yields an empty file and a scan that looks clean whatever it found.
  docker run --rm -v "${target}:/repo:ro" -v "${workspace}:/out" "${GITLEAKS_IMAGE}" \
    detect --source /repo --no-git --redact --config /repo/scripts/gitleaks.toml \
    --report-format json --report-path /out/gitleaks.json >/dev/null 2>&1 || true

  if [[ ! -f "${workspace}/gitleaks.json" ]]; then
    echo "  gitleaks produced no report" >&2
    failures=$((failures + 1))
    return
  fi
  python3 "${repo_dir}/scripts/security-scan-report.py" gitleaks "${workspace}/gitleaks.json" \
    "${repo_dir}/scripts/security-scan-exceptions.txt" || failures=$((failures + 1))
  echo
}

run_selftest() {
  echo "== Self-test: both tools must find a planted secret and a planted flaw"
  local planted="${workspace}/planted"
  mkdir -p "${planted}"
  # Assembled at run time rather than written as a literal, so this script does
  # not itself contain something a secret scanner will flag forever.
  printf 'export const token = %s%s%s\n' "'" "ghp_$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 36)" "'" \
    >"${planted}/leak.ts"
  cat >"${planted}/flaw.ts" <<'PLANTED'
import { exec } from 'node:child_process'
export const run = (input: string) => exec(input)
export const evaluate = (input: string) => eval(input)
export const client = { rejectUnauthorized: false }
PLANTED

  local before="${failures}"
  local semgrep_found=0 gitleaks_found=0

  docker run --rm -v "${planted}:/repo:ro" -v "${workspace}:/out" "${GITLEAKS_IMAGE}" \
    detect --source /repo --no-git --redact \
    --report-format json --report-path /out/selftest-gitleaks.json >/dev/null 2>&1 || true
  gitleaks_found="$(python3 -c "
import json,sys
try:
    data = json.load(open('${workspace}/selftest-gitleaks.json'))
except Exception:
    data = []
print(len(data or []))
")"

  # Against the project rules, because the community rulesets were measured
  # finding nothing at all in TypeScript — including in this very file.
  docker run --rm -v "${planted}:/src:ro" -v "${repo_dir}/scripts:/rules:ro" \
    -v "${workspace}:/out" -w /src "${SEMGREP_IMAGE}" \
    semgrep --config /rules/semgrep-rules.yml --metrics off --quiet --json \
    --output /out/selftest-semgrep.json >/dev/null 2>&1 || true
  semgrep_found="$(python3 -c "
import json,sys
try:
    data = json.load(open('${workspace}/selftest-semgrep.json')).get('results', [])
except Exception:
    data = []
print(len(data))
")"

  if [[ "${gitleaks_found}" -gt 0 ]]; then
    echo "  PASS  gitleaks found the planted secret"
  else
    echo "  FAIL  gitleaks found nothing — a clean scan means nothing until this passes" >&2
    failures=$((failures + 1))
  fi
  if [[ "${semgrep_found}" -gt 0 ]]; then
    echo "  PASS  Semgrep found the planted flaws (${semgrep_found})"
  else
    echo "  FAIL  Semgrep found nothing — a clean scan means nothing until this passes" >&2
    failures=$((failures + 1))
  fi
  echo
  [[ "${failures}" -eq "${before}" ]]
}

case "${mode}" in
  sast) run_sast ;;
  secrets) run_secrets ;;
  selftest) run_selftest ;;
  all)
    run_selftest || true
    run_sast
    run_secrets
    ;;
  *)
    echo "Usage: $0 [all|sast|secrets|selftest]" >&2
    exit 2
    ;;
esac

if [[ "${failures}" -gt 0 ]]; then
  echo "${failures} check(s) reported something."
  echo "Fix it, or record it in scripts/security-scan-exceptions.txt with a reason."
  exit 1
fi
echo "Static analysis and secret scanning are clean."
