"""Optional attested OCI-layer transport for the ONE canonical host updater.

No alternate updater, no Docker socket in the web app, no production builds.
A pinned public GHCR manifest can reuse Docker's local content-addressed layers.
When unavailable, the existing fully attested GitHub Release archive remains
the fallback. Both paths require the official Release Git/CI proof.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

REGISTRY = "ghcr.io/b8vipvip/mv3c"
PROOF_PREFIX = "refs/mv3c-release/oci/"
SHA256 = re.compile(r"sha256:[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")
VERSION = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+\Z")


class OCIProofError(RuntimeError):
    pass


def attested_registry_manifest(proof: dict, version: str, sha: str) -> str | None:
    """The OPTIONAL registry digest must be bound in the SAME Git image proof.

    V1 Release proofs without this opt-in field remain fully supported. A
    partially present/malformed registry field is not treated as absent.
    """
    digest = proof.get("registry_digest")
    repository = proof.get("registry")
    if digest is None and repository is None:
        return None
    if repository != REGISTRY or not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise OCIProofError("Invalid registry fields in signed Release image proof")
    if proof.get("sha") != sha or proof.get("release") != version:
        raise OCIProofError("Registry transport is not bound to exact Release SHA")
    return digest


def verify_registry_image(metadata: dict, version: str, sha: str,
                          config_id: str, digest: str) -> None:
    """Compare pulled digest, config and runtime identity before assigning local tag."""
    refs = metadata.get("RepoDigests") or []
    if REGISTRY + "@" + digest not in refs:
        raise OCIProofError("Pulled registry manifest digest does not match signed OCI proof")
    actual_id = metadata.get("Id")
    if actual_id not in (config_id, digest):
        raise OCIProofError("OCI image ID differs from signed config/registry manifest")
    config = metadata.get("Config") or {}
    labels = config.get("Labels") or {}
    env = config.get("Env") or []
    if (labels.get("org.opencontainers.image.revision") != sha
            or labels.get("org.opencontainers.image.version") != version
            or labels.get("org.opencontainers.image.source")
                != "https://github.com/b8vipvip/mv3c"
            or "BUILD_COMMIT=" + sha not in env
            or "MV3C_VERSION=" + version not in env
            or not (metadata.get("RootFS") or {}).get("Layers")):
        raise OCIProofError("Pulled image runtime metadata differs from protected Release")


def pull_registry_candidate(repo: Path, version: str, sha: str, proof: dict,
                            git, disk_free) -> str | None:
    """Try the explicitly opted-in public registry; missing/unreachable -> archive.

    Network transport failures fall back, but a cryptographically mismatched
    pulled image fails closed. The tag is never assigned until verified.
    This function runs inside the original updater flock and MongoDB job.
    """
    digest = attested_registry_manifest(proof, version, sha)
    if digest is None:
        print("OCI layer delivery not published for this Release; using signed archive",
              flush=True)
        return None
    from prebuilt import _host_import_budget
    required = 2 * 1024**3 + _host_import_budget(int(proof["image_size"])) + 512 * 1024**2
    if disk_free(repo) < required:
        raise OCIProofError(
            "Insufficient disk reserve for attested OCI pull; "
            "preserving current healthy image and rollback")
    remote = REGISTRY + "@" + digest
    try:
        result = subprocess.run(
            ["docker", "image", "pull", "--platform", "linux/amd64", remote],
            cwd=repo, text=True, capture_output=True, timeout=180, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print("OCI layer pull unavailable; falling back to signed Release archive: "
              + type(error).__name__, flush=True)
        return None
    if result.returncode != 0:
        print("OCI layer pull rejected or unavailable; using signed Release archive "
              + f"(docker exit {result.returncode})", flush=True)
        return None
    try:
        raw = subprocess.check_output(
            ["docker", "image", "inspect", "--format", "{{json .}}", remote],
            cwd=repo, text=True, timeout=30,
        )
        metadata = json.loads(raw)
    except (OSError, ValueError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as error:
        raise OCIProofError("Pulled OCI digest cannot be inspected") from error
    verify_registry_image(metadata, version, sha, proof["image_id"], digest)
    local = "mv3c:sha-" + sha
    result = subprocess.run(
        ["docker", "image", "tag", remote, local],
        cwd=repo, text=True, capture_output=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise OCIProofError("Verified registry image could not receive immutable local tag")
    return "Verified OCI manifest " + digest[:24] + \
           ", reused locally cached Docker layers; image=" + str(metadata["Id"])[:24]
