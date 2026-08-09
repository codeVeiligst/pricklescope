#!/usr/bin/env python3
"""Turns a Semgrep or gitleaks report into a verdict for scripts/security-scan.sh.

Findings listed in the exceptions file are printed as ALLOWED and do not fail the
run; everything else does. Kept out of the shell script because the JSON shapes
differ and the formatting is easier to get right here.
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


def semgrep_findings(report: dict):
    for result in report.get("results", []):
        rule = result["check_id"]
        yield {
            # The short rule name is what a person writes in the exceptions file;
            # the full id is namespaced by ruleset and is unwieldy.
            "id": rule.split(".")[-1],
            "severity": result["extra"].get("severity", "UNKNOWN"),
            "where": f"{result['path']}:{result['start']['line']}",
            "detail": " ".join(result["extra"].get("message", "").split())[:160],
        }


def gitleaks_findings(report: list):
    for finding in report or []:
        yield {
            "id": finding.get("RuleID", "unknown"),
            "severity": "HIGH",
            "where": f"{finding.get('File')}:{finding.get('StartLine')}",
            "detail": finding.get("Description", ""),
        }


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: security-scan-report.py <semgrep|gitleaks> <report> <exceptions>", file=sys.stderr)
        return 2
    kind, report_path, exceptions_path = sys.argv[1], sys.argv[2], sys.argv[3]

    text = Path(report_path).read_text(encoding="utf-8").strip()
    if not text or text == "null":
        report = [] if kind == "gitleaks" else {}
    else:
        report = json.loads(text)

    excepted = load_exceptions(exceptions_path)
    extract = semgrep_findings if kind == "semgrep" else gitleaks_findings

    blocking = 0
    allowed = 0
    for finding in extract(report):
        line = "{severity:8} {id}  {where}".format(**finding)
        if finding["id"] in excepted:
            allowed += 1
            print(f"  ALLOWED  {line}")
            continue
        blocking += 1
        print(f"  BLOCKING {line}")
        if finding["detail"]:
            print(f"           {finding['detail']}")

    if not blocking:
        suffix = f" ({allowed} allowed by exception)" if allowed else ""
        print(f"  clean{suffix}")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
