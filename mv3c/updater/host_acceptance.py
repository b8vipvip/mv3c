#!/usr/bin/env python3
"""Non-mutating MV3C host acceptance, safe for a live production instance.

Checks publicly observable readiness/version/config and authentication gates.
It never logs in, posts chat messages, writes database records or touches Docker.
Actual guest/admin UI, chat2api media fidelity and upstream streaming still
require separate manual end-to-end acceptance.
"""
from __future__ import annotations

import argparse
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:3080"


def read(path: str) -> tuple[int, bytes]:
    request = Request(BASE + path, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=12) as response:
            return response.status, response.read(1024 * 1024)
    except HTTPError as error:
        return error.code, error.read(4096)


def check(expected_version: str | None, expected_sha: str | None) -> dict:
    result = {"target": BASE, "checks": {}, "unverified": [
        "real guest-to-admin browser switch",
        "chat2api upstream model requests and SSE completion",
        "multiple generated images and actual artifact links",
        "history title/search and plugin tool authorization",
    ]}
    status, _ = read("/readyz")
    result["checks"]["readyz"] = status == 200
    status, content = read("/api/config")
    try:
        cfg = json.loads(content) if status == 200 else {}
    except ValueError:
        cfg = {}
    result["checks"]["config"] = (
        status == 200 and isinstance(cfg, dict) and
        isinstance(cfg.get("registrationEnabled"), bool))
    status, content = read("/api/config/version")
    try:
        version = json.loads(content) if status == 200 else {}
    except ValueError:
        version = {}
    result["version"] = version.get("version")
    result["sha"] = version.get("sha")
    result["checks"]["version"] = status == 200 and isinstance(version.get("sha"), str)
    if expected_version:
        result["checks"]["expected_version"] = result["version"] == expected_version
    if expected_sha:
        result["checks"]["expected_sha"] = result["sha"] == expected_sha
    for path, key in (
        ("/api/admin/mv3c", "admin_settings_auth_required"),
        ("/api/admin/mv3c/updates", "updater_auth_required"),
    ):
        status, _ = read(path)
        result["checks"][key] = status in (401, 403)
    result["passed"] = all(result["checks"].values())
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only MV3C production smoke checks")
    parser.add_argument("--expected-version")
    parser.add_argument("--expected-sha")
    args = parser.parse_args()
    try:
        results = check(args.expected_version, args.expected_sha)
    except (URLError, OSError, TimeoutError) as error:
        print(json.dumps({"passed": False, "error": type(error).__name__,
                          "checks": {}, "target": BASE}, ensure_ascii=False))
        return 1
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if results["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
