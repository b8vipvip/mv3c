"""GitHub Actions isolated full official v0.1.45 proxy OCI acceptance.

CI runner only; uses the verified protected Release Git proof and the same
Docker 29.6.2 containerd snapshotter as production. Never deploys a service.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from prebuilt import verified_image_proof
from oci_proxy_transport import prepare_proxy_candidate

VERSION = "v0.1.45"
SHA = "fc47c299e89c09250862d26d6c15897fe7e42ba8"
DIGEST = "sha256:e8011ebee89bc67c751a5241d7b21d82a62e96e9bd61ce91c925ec13bb1b6a16"


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-c", "safe.directory=" + str(repo), *args],
        cwd=repo, text=True, timeout=30).strip()


def main():
    repo = ROOT.parents[1]
    if not os.environ.get("MV3C_DOWNLOAD_PROXY", "").startswith(
            "http://127.0.0.1:11808"):
        raise SystemExit("CI local proxy not configured")
    driver = json.loads(subprocess.check_output(
        ["docker", "info", "--format", "{{json .DriverStatus}}"],
        text=True, timeout=30))
    if ["driver-type", "io.containerd.snapshotter.v1"] not in driver:
        raise SystemExit("Docker 29 containerd snapshotter required")
    proof = verified_image_proof(repo, VERSION, SHA, git)
    if proof["registry_digest"] != DIGEST:
        raise SystemExit("Protected official release GHCR digest mismatch")
    free = lambda _: shutil.disk_usage(repo).free
    outcome = prepare_proxy_candidate(repo, SHA, VERSION, proof, free)
    print(outcome, flush=True)
    tag = "mv3c:sha-" + SHA
    actual = json.loads(subprocess.check_output(
        ["docker", "image", "inspect", "--format", "{{json .}}", tag],
        text=True, timeout=30))
    if actual.get("Id") != DIGEST:
        raise SystemExit("Official Docker OCI candidate has wrong manifest digest")
    print(json.dumps({
        "result": "CI_OFFICIAL_PROXY_GHCR_IMAGE_PASS",
        "release": VERSION,
        "sha": SHA,
        "digest": actual.get("Id"),
        "driver": driver,
    }, indent=2))


if __name__ == "__main__":
    main()
