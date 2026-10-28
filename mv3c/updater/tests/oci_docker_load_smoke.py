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
        print("OCI archive generated, running docker image load in CI only", flush=True)
        print(run("docker", "image", "load", "--input", str(candidate)))
        ids = run(
            "docker", "image", "ls", "--no-trunc", "-q",
            "--filter", "label=org.opencontainers.image.revision=" + SHA,
        ).splitlines()
        if not ids:
            raise SystemExit("Docker did not expose loaded OCI candidate")
        inspected = [json.loads(run(
            "docker", "image", "inspect", "--format", "{{json .}}", image_id))
            for image_id in ids]
        accepted = []
        for image in inspected:
            config = image.get("Config") or {}
            labels = config.get("Labels") or {}
            env = config.get("Env") or []
            rootfs = (image.get("RootFS") or {}).get("Layers") or []
            if (labels.get("org.opencontainers.image.version") == VERSION
                    and labels.get("org.opencontainers.image.revision") == SHA
                    and "BUILD_COMMIT=" + SHA in env
                    and "MV3C_VERSION=" + VERSION in env
                    and len(rootfs) == 1):
                accepted.append(image)
        if len(accepted) != 1:
            raise SystemExit("Loaded Docker candidate missing attested runtime metadata")
        print(json.dumps({
            "result": "CI_DOCKER_OCI_LOAD_PASS",
            "image_id": accepted[0].get("Id"),
            "protected_config_digest": proof["image_id"],
            "protected_manifest_digest": proof["registry_digest"],
            "docker_driver": driver,
        }, indent=2))


if __name__ == "__main__":
    main()
