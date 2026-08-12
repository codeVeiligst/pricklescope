#!/usr/bin/env python3
"""Turns one scanner's JSON into a verdict for scripts/scan.sh.

Reads the report on stdin, prints one line per HIGH/CRITICAL finding, and exits
non-zero if any of them is not listed in the exceptions file. Kept out of the
shell script because the formatting is easier to read — and to get right — here.
"""

import json
import sys
from pathlib import Path


def load_exceptions(path: str) -> set[str]:
    file = Path(path)
    if not file.exists():
        return set()
    identifiers = set()
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            identifiers.add(line)
    return identifiers


def audit_findings(report: dict):
    """pnpm audit: advisories keyed by id."""
    for advisory in report.get("advisories", {}).values():
        severity = advisory.get("severity", "")
        if severity not in ("high", "critical"):
            continue
        cves = advisory.get("cves") or [""]
        identifier = advisory.get("github_advisory_id") or cves[0] or str(advisory.get("id"))
        yield {
            "id": identifier,
            "severity": severity.upper(),
            "package": advisory.get("module_name", "?"),
            "installed": advisory.get("vulnerable_versions", "?"),
            "fixed": advisory.get("patched_versions", "?"),
            "title": (advisory.get("title") or "").strip(),
        }


# Findings PrickleScope cannot fix by changing PrickleScope. An operating-system
# package comes from the base image, and a Go dependency compiled into Caddy,
# Grafana, Telegraf, or QuestDB comes from that project's own build. The remedy is
# not a code change: pin a newer image, which is the procedure in infra/README.md.
#
# Inherited is not the same as unactionable, and treating them as the same is what
# an external audit caught (F6): the run reported "clean" while carrying fixed
# Critical findings in Postgres and Telegraf. If the upstream maintainer has
# published a fixed version, moving the pin is exactly the action the procedure
# describes — so a fixed High or Critical blocks, and only what genuinely has no
# fix yet is reported without failing. A check that cannot be made to pass gets
# ignored; a check that passes while a fix is sitting there is worse.
INHERITED_TYPES = {"gobinary", "jar", "python-pkg", "gemspec"}

# Trivy leaves this empty when the maintainer has published nothing to move to.
NO_FIX = {"", "?", None}
ACTIONABLE_SEVERITIES = {"HIGH", "CRITICAL"}


def actionable(finding) -> bool:
    """An inherited finding with a published fix and a severity worth acting on."""
    return (
        finding.get("fixed") not in NO_FIX
        and str(finding.get("severity", "")).upper() in ACTIONABLE_SEVERITIES
    )


def trivy_findings(report: dict):
    """Trivy image scan: results grouped by target."""
    for result in report.get("Results", []):
        inherited = result.get("Class") == "os-pkgs" or result.get("Type") in INHERITED_TYPES
        for finding in result.get("Vulnerabilities") or []:
            yield {
                "id": finding["VulnerabilityID"],
                "severity": finding.get("Severity", "UNKNOWN"),
                "package": finding.get("PkgName", "?"),
                "installed": finding.get("InstalledVersion", "?"),
                "fixed": finding.get("FixedVersion", "?"),
                "title": (finding.get("Title") or "").strip(),
                "inherited": inherited,
            }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: scan-report.py <audit|trivy> <exceptions-file>", file=sys.stderr)
        return 2
    kind, exceptions_path = sys.argv[1], sys.argv[2]

    raw = sys.stdin.read().strip()
    if not raw:
        print("  the scanner produced no report", file=sys.stderr)
        return 1
    report = json.loads(raw)

    excepted = load_exceptions(exceptions_path)
    extract = audit_findings if kind == "audit" else trivy_findings

    blocking = 0
    allowed = 0
    inherited = []
    for finding in extract(report):
        line = "{severity:8} {package} {installed} -> {fixed}  {id}".format(**finding)
        if finding.get("inherited") and not actionable(finding):
            inherited.append(line)
            continue
        if finding["id"] in excepted:
            allowed += 1
            print(f"  ALLOWED  {line}")
            continue
        blocking += 1
        print(f"  BLOCKING {line}")
        if finding["title"]:
            print(f"           {finding['title']}")

    if not blocking:
        notes = []
        if allowed:
            notes.append(f"{allowed} allowed by exception")
        if inherited:
            notes.append(f"{len(inherited)} inherited with no fix published")
        suffix = f" ({', '.join(notes)})" if notes else ""
        print(f"  clean{suffix}")
    elif inherited:
        print(f"  ...and {len(inherited)} inherited with no fix published")

    # Listed but never blocking, so a pin that has fallen behind stays visible.
    for line in inherited:
        print(f"  INHERITED {line}")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
