"""CI ONLY: official v0.1.44 -> v0.1.45 compressed GHCR delta acceptance.

Downloads two actual signed releases through a CI-local CONNECT proxy, with
an empty cache initially. Requires isolated Docker 29 + containerd snapshotter,
proves SHA256 identity and checks delta-cache behavior. No server deployment.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from prebuilt import verified_image_proof
from oci_proxy_transport import prepare_proxy_candidate

RELEASES = (
    ("v0.1.44", "957a58c7c7418c52e7b837bdf541626db4569885",
     "sha256:15ac25dfafd8a8f7faa151a1ab693f5614cd1fc00aedb9f8d15c1ad438966b90"),
    ("v0.1.45", "fc47c299e89c09250862d26d6c15897fe7e42ba8",
     "sha256:e8011ebee89bc67c751a5241d7b21d82a62e96e9bd61ce91c925ec13bb1b6a16"),
)
EXPECTED_DELTA_BYTES = 50950973


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-c", "safe.directory=" + str(repo), *args],
        cwd=repo, text=True, timeout=30).strip()


def candidate(repo, version, sha, digest):
    proof = verified_image_proof(repo, version, sha, git)
    if proof["registry_digest"] != digest:
        raise SystemExit("Protected official release GHCR digest mismatch")
    free = lambda _: shutil.disk_usage(repo).free
    outcome = prepare_proxy_candidate(repo, sha, version, proof, free)
    print(outcome, flush=True)
    tag = "mv3c:sha-" + sha
    actual = json.loads(subprocess.check_output(
        ["docker", "image", "inspect", "--format", "{{json .}}", tag],
        text=True, timeout=30))
    if actual.get("Id") != digest:
        raise SystemExit("Official Docker OCI candidate has wrong manifest digest")
    match = re.search(
        r"cached_blobs=(\d+)/(\d+).*curl_body_bytes=(\d+|unavailable)", outcome)
    if not match:
        raise SystemExit("Missing OCI cache/delta transfer diagnostics")
    return {
        "version": version, "sha": sha, "manifest_digest": digest,
        "cached_blobs": int(match.group(1)),
        "unique_blobs": int(match.group(2)),
        "http_body_bytes": None if match.group(3) == "unavailable"
            else int(match.group(3)),
    }


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
    first = candidate(repo, *RELEASES[0])
    second = candidate(repo, *RELEASES[1])
    repeated = candidate(repo, *RELEASES[1])
    if (second["cached_blobs"] != 8 or second["unique_blobs"] != 9
            or second["http_body_bytes"] is None
            or second["http_body_bytes"] < EXPECTED_DELTA_BYTES):
        raise SystemExit("Official v0.1.44 -> v0.1.45 layer reuse mismatch")
    if (repeated["cached_blobs"] != 9 or repeated["unique_blobs"] != 9
            or repeated["http_body_bytes"] != 0):
        raise SystemExit("Repeated official release did not reuse all cached blobs")
    print(json.dumps({
        "result": "CI_OFFICIAL_GHCR_INCREMENTAL_PASS",
        "initial": first,
        "incremental": second,
        "repeat_without_layer_download": repeated,
        "unchanged_layer_positions": 9,
        "expected_new_compressed_bytes": EXPECTED_DELTA_BYTES,
        "docker_driver": driver,
    }, indent=2))


if __name__ == "__main__":
    main()
