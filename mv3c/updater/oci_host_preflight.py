#!/usr/bin/env python3
"""Read-only host preflight for optional MV3C GHCR delivery.

Does not fetch Git refs, download/pull images, tag images, create jobs, stop
services, update configuration, or clean caches. Run after the official
Release refs have been fetched by the existing canonical updater.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
sys.dont_write_bytecode = True  # Do not create __pycache__ on the production host.
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from oci_registry import attested_registry_manifest
from prebuilt import PrebuiltError, _host_import_budget, verified_image_proof

SHA = re.compile(r"[a-f0-9]{40}\Z")
VERSION = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+\Z")
GIB = 1024 ** 3


def command(args: list[str], repo: Path, timeout: int = 15) -> str:
    return subprocess.check_output(
        args, cwd=repo, text=True, timeout=timeout, stderr=subprocess.DEVNULL
    ).strip()


def git(repo: Path, *args: str) -> str:
    return command(["git", *args], repo)


def inspect_local(repo: Path) -> dict:
    return json.loads(command(
        ["docker", "image", "inspect", "--format", "{{json .}}", "mv3c:local"], repo
    ))


def required_bytes(image_size: int) -> int:
    # Same conservative safety margin as the canonical attested OCI loader.
    return 2 * GIB + _host_import_budget(image_size) + 512 * 1024 ** 2


def evaluate_disk(free_bytes: int, image_size: int) -> dict:
    required = required_bytes(image_size)
    return {
        "passed": free_bytes >= required,
        "free_bytes": free_bytes,
        "required_bytes": required,
        "margin_bytes": free_bytes - required,
    }


def check(repo: Path, version: str, sha: str) -> dict:
    if not VERSION.fullmatch(version) or not SHA.fullmatch(sha):
        raise ValueError("Invalid version or SHA")
    report = {
        "mode": "READ_ONLY_NO_PULL",
        "target_version": version,
        "target_sha": sha,
        "checks": {},
        "details": {},
        "not_verified": [
            "GHCR network throughput or actual downloaded bytes",
            "compressed OCI blob availability on this host",
            "production Docker storage peak after pulling new layers",
            "deploy health, rollback, and user-facing functionality",
        ],
    }

    def record(key: str, fn):
        try:
            value = fn()
            report["details"][key] = value
            report["checks"][key] = bool(value["passed"])
        except (OSError, ValueError, KeyError, TypeError, RuntimeError,
                subprocess.SubprocessError, URLError, HTTPError, PrebuiltError) as exc:
            report["checks"][key] = False
            report["details"][key] = {"passed": False, "error": type(exc).__name__}

    def proof_check():
        local_sha = git(repo, "rev-parse",
                        "refs/mv3c-release/tags/" + version + "^{commit}")
        if local_sha != sha:
            raise ValueError("Release tag does not point to requested commit")
        proof = verified_image_proof(repo, version, sha, git)
        digest = attested_registry_manifest(proof, version, sha)
        if not digest:
            raise ValueError("This Release has no attested GHCR digest")
        report["details"]["target_image_size_bytes"] = int(proof["image_size"])
        report["details"]["registry_digest"] = digest
        return {"passed": True, "digest": digest}

    record("immutable_release_and_registry_proof", proof_check)

    def updater_check():
        prebuilt = repo / "mv3c/updater/prebuilt.py"
        registry = repo / "mv3c/updater/oci_registry.py"
        if not prebuilt.is_file() or not registry.is_file():
            raise ValueError("Host checkout lacks the OCI-aware canonical updater")
        code = prebuilt.read_text(encoding="utf-8")
        if 'oci_mode in ("enabled", "required")' not in code:
            raise ValueError("Host updater is not OCI aware")
        return {"passed": True, "single_updater": True}

    record("installed_updater_supports_opt_in", updater_check)

    def disk_check():
        docker_root = command(["docker", "info", "--format", "{{.DockerRootDir}}"], repo)
        if not docker_root.startswith("/"):
            raise ValueError("Unexpected Docker root directory")
        free = shutil.disk_usage(docker_root).free
        image_size = report["details"].get("target_image_size_bytes")
        if not isinstance(image_size, int):
            raise ValueError("Verified image size not available; cannot budget disk")
        result = evaluate_disk(free, image_size)
        result["docker_root"] = docker_root
        return result

    record("docker_filesystem_space", disk_check)

    def local_image_check():
        info = inspect_local(repo)
        labels = (info.get("Config") or {}).get("Labels") or {}
        layer_ids = ((info.get("RootFS") or {}).get("Layers") or [])
        if not info.get("Id") or not layer_ids:
            raise ValueError("Current mv3c:local image missing")
        return {
            "passed": True,
            "running_candidate_image_id": info["Id"],
            "installed_image_sha": labels.get("org.opencontainers.image.revision", ""),
            "installed_image_version": labels.get("org.opencontainers.image.version", ""),
            "layer_count": len(layer_ids),
            "note": "Local diffIDs alone do not prove compressed registry blob reuse",
        }

    record("existing_local_image", local_image_check)

    def service_check():
        state = subprocess.run(
            ["systemctl", "is-active", "mv3c-updater.service"], cwd=repo,
            capture_output=True, text=True, timeout=10, check=False
        ).stdout.strip()
        return {"passed": state == "inactive", "service_state": state}

    record("no_active_updater_job_service", service_check)

    def health_check():
        with urlopen("http://127.0.0.1:3080/readyz", timeout=10) as response:
            status = response.status
        return {"passed": status == 200, "http_status": status}

    record("existing_service_readyz", health_check)
    report["passed"] = all(report["checks"].values())
    report["next_action"] = (
        "Eligible for a separately authorized, controlled rollout; "
        "this probe has NOT downloaded or deployed an image."
        if report["passed"] else
        "Do not enable host OCI transport or start a deployment; resolve failed checks."
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Non-mutating GHCR host preflight")
    parser.add_argument("--repo", default="/opt/mv3c")
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    try:
        result = check(Path(args.repo).resolve(), args.version, args.sha)
    except ValueError as exc:
        print(json.dumps({"passed": False, "error": str(exc)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
