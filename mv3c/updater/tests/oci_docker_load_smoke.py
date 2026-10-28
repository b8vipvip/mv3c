"""CI ONLY: load a tiny signed-in-memory OCI archive into ephemeral Docker 29.

Never call this from the production updater or shared host. A GitHub Actions
runner with containerd snapshotter enabled is required. No network image pull.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from oci_proxy_archive import build_attested_oci_archive
from oci_proxy_import import load_verified_oci_candidate
from test_oci_proxy_archive import SHA, VERSION, digest, fixture, put


def run(*args):
    return subprocess.check_output(
        list(args), text=True, timeout=120, stderr=subprocess.STDOUT)


def main():
    driver = json.loads(run(
        "docker", "info", "--format", "{{json .DriverStatus}}"))
    if ["driver-type", "io.containerd.snapshotter.v1"] not in driver:
        raise SystemExit("CI Docker lacks required containerd snapshotter")
    raw, conf, layer, proof = fixture()
    with tempfile.TemporaryDirectory() as location:
        stage = pathlib.Path(location)
        stage.chmod(0o700)
        put(stage, conf)
        put(stage, layer)
        candidate = stage / ("oci-" + SHA + ".tar")
        build_attested_oci_archive(
            stage, candidate, raw_manifest=raw, raw_config=conf,
            proof=proof, version=VERSION, sha=SHA)
        print("OCI archive generated; validating/importing Docker candidate in CI", flush=True)
        report = load_verified_oci_candidate(
            candidate, proof, VERSION, SHA,
            cwd=stage, min_free_bytes=2 * 1024**3)
        tagged = json.loads(run(
            "docker", "image", "inspect", "--format", "{{json .}}",
            "mv3c:sha-" + SHA))
        if (report["image_id"] != proof["registry_digest"]
                or tagged.get("Id") != report["image_id"]
                or report.get("already_tagged")):
            raise SystemExit("Docker immutable candidate identity mismatch")
        print(json.dumps({
            "result": "CI_DOCKER_OCI_IMPORT_TAG_PASS",
            "candidate": report["candidate"],
            "image_id": report["image_id"],
            "protected_manifest_digest": proof["registry_digest"],
            "docker_driver": driver,
        }, indent=2))


if __name__ == "__main__":
    main()
