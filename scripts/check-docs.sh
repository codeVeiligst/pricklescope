#!/usr/bin/env bash
# Check that the documentation still describes something real.
#
#   ./scripts/check-docs.sh
#
# Four things rot silently and each has cost time here already: a link to a file
# that moved, a shell script with a syntax error nobody ran, a documented command
# that no longer exists, and an example configuration that has drifted from the
# variables the application reads.
#
# Deliberately not checked: external URLs. They fail for reasons that have nothing
# to do with this repository, and a check that goes red when someone else's site
# is down is a check people learn to ignore.

set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

failures=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '    \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

step "Internal links"
# Resolved against the filesystem *and* against .gitignore. A link to a file that
# exists locally but is never committed reads as fine here and 404s for anyone who
# clones — which is exactly what happened to a CLAUDE.md link in CONTRIBUTING.md.
python3 - <<'PY' || exit 1
import re, subprocess, sys
from pathlib import Path

skip = {'node_modules', 'dist', '.git', 'test-results', 'playwright-report', 'sbom'}
broken = []
checked = 0

# Ask git itself rather than reimplementing .gitignore.
ignored: set[Path] = set()
try:
    candidates = [
        str(p) for p in Path('.').rglob('*.md')
        if not any(part in skip for part in p.parts)
    ]
    result = subprocess.run(
        ['git', 'check-ignore', '--stdin'],
        input='\n'.join(candidates), capture_output=True, text=True, check=False,
    )
    ignored = {Path(line).resolve().relative_to(Path('.').resolve())
               for line in result.stdout.splitlines() if line}
except Exception:
    ignored = set()

for path in Path('.').rglob('*.md'):
    if any(part in skip for part in path.parts):
        continue
    text = path.read_text(encoding='utf-8')
    for match in re.finditer(r'\[[^\]]*\]\(([^)]+)\)', text):
        target = match.group(1).strip()
        if target.startswith(('http://', 'https://', 'mailto:', '#')):
            continue
        checked += 1
        anchor = target.split('#', 1)
        resolved = (path.parent / anchor[0]).resolve()
        if not resolved.exists():
            broken.append(f'{path}: {target} (does not exist)')
            continue
        relative = resolved.relative_to(Path('.').resolve())
        if relative in ignored:
            broken.append(f'{path}: {target} (git-ignored — would 404 after a clone)')

if broken:
    print('    \033[31m✗\033[0m broken links:')
    for entry in broken:
        print(f'        {entry}')
    sys.exit(1)
print(f'    \033[32m✓\033[0m {checked} internal links resolve and are committed')
PY

step "Shell scripts"
shell_scripts=$(find scripts infra -name '*.sh' -type f 2>/dev/null | sort)
for script in ${shell_scripts}; do
  if ! bash -n "${script}" 2>/tmp/pricklescope-shell-error; then
    bad "${script}: $(cat /tmp/pricklescope-shell-error)"
  fi
done
[[ "${failures}" -eq 0 ]] && ok "$(echo "${shell_scripts}" | wc -l) scripts parse"

if command -v shellcheck >/dev/null 2>&1; then
  for script in ${shell_scripts}; do
    shellcheck --severity=error "${script}" || bad "${script}: shellcheck reported an error"
  done
  ok "shellcheck clean"
else
  printf '      shellcheck not installed; syntax checked with bash -n only\n'
fi

step "Documented commands exist"
# Every `corepack pnpm <script>` mentioned in the documentation has to be a script
# the workspace actually defines. A guide that names a command nobody can run is
# worse than a guide that says nothing.
python3 - <<'PY' || exit 1
import json, re, sys
from pathlib import Path

root = json.loads(Path('package.json').read_text())
known = set(root.get('scripts', {}))
for manifest in list(Path('apps').glob('*/package.json')) + list(Path('packages').glob('*/package.json')):
    known.update(json.loads(manifest.read_text()).get('scripts', {}))

skip = {'node_modules', 'dist', '.git', 'sbom'}
missing = set()
checked = 0
for path in list(Path('.').rglob('*.md')):
    if any(part in skip for part in path.parts):
        continue
    for match in re.finditer(r'corepack pnpm (?:--filter \S+ )?(?:run )?([a-z][a-z0-9:-]*)', path.read_text()):
        name = match.group(1)
        # pnpm's own subcommands, not workspace scripts.
        if name in {'install', 'exec', 'audit', 'why', 'view', 'add', 'remove', 'config', 'deploy', 'clean', 'version', 'licenses', 'update', 'outdated'}:
            continue
        checked += 1
        if name not in known:
            missing.add(f'{path}: corepack pnpm {name}')

if missing:
    print('    \033[31m✗\033[0m documented commands that do not exist:')
    for entry in sorted(missing):
        print(f'        {entry}')
    sys.exit(1)
print(f'    \033[32m✓\033[0m {checked} documented pnpm commands exist')
PY

step "Documented scripts exist"
python3 - <<'PY' || exit 1
import re, sys
from pathlib import Path

skip = {'node_modules', 'dist', '.git', 'sbom'}
missing = set()
checked = 0
for path in Path('.').rglob('*.md'):
    if any(part in skip for part in path.parts):
        continue
    for match in re.finditer(r'\./((?:scripts|infra)/[a-z0-9-]+\.sh)', path.read_text()):
        checked += 1
        if not Path(match.group(1)).exists():
            missing.add(f'{path}: ./{match.group(1)}')

if missing:
    print('    \033[31m✗\033[0m documented scripts that do not exist:')
    for entry in sorted(missing):
        print(f'        {entry}')
    sys.exit(1)
print(f'    \033[32m✓\033[0m {checked} documented script paths exist')
PY

step "Example configuration matches what the application reads"
python3 - <<'PY' || exit 1
import re, sys
from pathlib import Path

# Every PRICKLESCOPE_* variable config.ts reads, against what the example offers.
source = Path('apps/api/src/config.ts').read_text()
read = set(re.findall(r'env\.(PRICKLESCOPE_[A-Z0-9_]+)', source))

example = Path('.env.example').read_text()
offered = set(re.findall(r'^(PRICKLESCOPE_[A-Z0-9_]+)=', example, re.MULTILINE))

# Alternatives the example does not need to show both halves of.
optional = {
    'PRICKLESCOPE_CREDENTIAL_KEY_FILE',
    'PRICKLESCOPE_BOOTSTRAP_ADMIN_PASSWORD_FILE',
    'PRICKLESCOPE_ENV_FILE',
    'PRICKLESCOPE_SESSION_COOKIE_NAME',
    'PRICKLESCOPE_TELEGRAF_CONFIG_DIR',
    'PRICKLESCOPE_JOB_POLL_INTERVAL_MS',
    'PRICKLESCOPE_JOB_CONCURRENCY',
    'PRICKLESCOPE_VERSION',
}

stale = offered - read
if stale:
    print('    \033[31m✗\033[0m .env.example sets variables nothing reads:')
    for name in sorted(stale):
        print(f'        {name}')
    sys.exit(1)

print(f'    \033[32m✓\033[0m .env.example offers {len(offered)} variables, all of them read')
undocumented = read - offered - optional
if undocumented:
    print('      not in the example (optional, or documented elsewhere):')
    for name in sorted(undocumented):
        print(f'        {name}')
PY

echo
if [[ "${failures}" -gt 0 ]]; then
  echo "${failures} documentation problem(s)."
  exit 1
fi
echo "Documentation checks pass."
