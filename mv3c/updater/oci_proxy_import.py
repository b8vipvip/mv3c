"""Isolated, fail-closed Docker import for SHA256-attested OCI layout archives.

This is a developer acceptance adapter, NOT wired into the production updater.
It MUST be called only inside the canonical updater's single flock/job after
deployment and rollback safety preflight. Never modifies mv3c:local, existing
rollback tags, systemd units, the Docker daemon configuration, or containerd
namespaces. Docker load only creates an isolated OCI import tag until identity
is verified, then permits an immutable mv3c:sha-<release-sha> candidate.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
from pathlib import Path

from oci_proxy_manifest import (
    ManifestProofError, decode_attested_config, decode_attested_manifest,
)
from oci_proxy_blob import MIN_RESERVED_BYTES

MAX_LAYOUT_BYTES = 12 * 1024 ** 3


class OCIImportError(RuntimeError):
    pass


def _command(args: list[str], *, timeout: int = 45, cwd: Path | None = None):
    try:
        return subprocess.run(
            args, cwd=cwd, text=True, capture_output=True, timeout=timeout,
            check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OCIImportError("Docker image command unavailable or timed out") from error


def _inspect(reference: str, cwd: Path) -> dict | None:
    result = _command(
        ["docker", "image", "inspect", "--format", "{{json .}}", reference],
        cwd=cwd)
    if result.returncode:
        return None
    try:
        return json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise OCIImportError("Docker returned invalid image metadata") from error


def verify_oci_archive(archive: Path, proof: dict, version: str, sha: str):
    """Validate exact OCI content before calling Docker, without extracting it.

    Rehash compressed layer bytes, manifest and config and reject tar links,
    extra entries, wrong sizes, invalid tar entry kinds and release mismatch.
    """
    archive = Path(archive)
    if archive.is_symlink() or not archive.is_file():
        raise OCIImportError("Refusing missing/symlinked OCI archive")
    info = archive.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077:
        raise OCIImportError("OCI archive must be single-link and owner-only")
    if (archive.parent.is_symlink() or archive.parent.stat().st_mode & 0o077
            or archive.parent.stat().st_uid != os.geteuid()):
        raise OCIImportError("OCI archive parent must be owner-only")
    if info.st_size > MAX_LAYOUT_BYTES:
        raise OCIImportError("OCI archive exceeds safe size")
    try:
        with tarfile.open(archive, mode="r:") as tar:
            members = tar.getmembers()
            files = {member.name: member for member in members}
            if len(files) != len(members) or not all(m.isfile() for m in members):
                raise OCIImportError("Unexpected OCI tar entries or links")
            for name in files:
                if name.startswith("/") or ".." in name.split("/"):
                    raise OCIImportError("Unsafe OCI archive member name")
            def read_small(name, maximum):
                member = files.get(name)
                if member is None or member.size > maximum:
                    raise OCIImportError("Missing/oversized required OCI descriptor")
                stream = tar.extractfile(member)
                if stream is None:
                    raise OCIImportError("OCI archive member not readable")
                return stream.read(maximum + 1)

            layout = json.loads(read_small("oci-layout", 1024))
            if layout != {"imageLayoutVersion": "1.0.0"}:
                raise OCIImportError("Invalid OCI layout marker")
            index = json.loads(read_small("index.json", 1024 * 1024))
            if (not isinstance(index, dict)
                    or index.get("schemaVersion") != 2
                    or not isinstance(index.get("manifests"), list)
                    or len(index["manifests"]) != 1):
                raise OCIImportError("Invalid or ambiguous OCI image index")
            descriptor = index["manifests"][0]
            digest = proof.get("registry_digest", "")
            raw_manifest = read_small("blobs/sha256/" + digest[7:], 1024 * 1024)
            manifest = decode_attested_manifest(raw_manifest, proof, version, sha)
            media = json.loads(raw_manifest)["mediaType"]
            if (descriptor.get("mediaType") != media
                    or descriptor.get("digest") != manifest["manifest_digest"]
                    or descriptor.get("size") != len(raw_manifest)
                    or descriptor.get("annotations", {}).get(
                        "org.opencontainers.image.ref.name")
                        != "mv3c-oci-verify:sha-" + sha
                    or descriptor.get("platform")
                        != {"os": "linux", "architecture": "amd64"}):
                raise OCIImportError("OCI index differs from protected image")
            config_descriptor = manifest["config"]
            raw_config = read_small(
                "blobs/sha256/" + config_descriptor["digest"][7:], 1024 * 1024)
            decode_attested_config(
                raw_config, config_descriptor, proof, version, sha,
                len(manifest["layers"]))
            expected = {"oci-layout", "index.json",
                        "blobs/sha256/" + manifest["manifest_digest"][7:]}
            unique = {x["digest"]: x for x in
                      [config_descriptor, *manifest["layers"]]}
            for d, entry in unique.items():
                name = "blobs/sha256/" + d[7:]
                member = files.get(name)
                if member is None or member.size != entry["size"]:
                    raise OCIImportError("Missing OCI compressed blob or size mismatch")
                expected.add(name)
                stream = tar.extractfile(member)
                if stream is None:
                    raise OCIImportError("OCI compressed blob cannot be read")
                hashed = hashlib.sha256()
                for piece in iter(lambda: stream.read(1024 * 1024), b""):
                    hashed.update(piece)
                if "sha256:" + hashed.hexdigest() != d:
                    raise OCIImportError("OCI compressed blob SHA256 mismatch")
            if set(files) != expected:
                raise OCIImportError("OCI archive contains untrusted extra objects")
            return manifest, json.loads(raw_config)
    except (tarfile.TarError, OSError, ValueError, KeyError, TypeError,
            ManifestProofError) as error:
        raise OCIImportError("OCI archive cannot be verified") from error


def _assert_identity(metadata: dict, manifest: dict, config: dict,
                     proof: dict, version: str, sha: str) -> None:
    # On Docker 29 + containerd snapshotter, OCI archive load yields a
    # manifest-digest image ID; a Docker-archive import may yield config ID.
    if metadata.get("Id") not in (proof["registry_digest"], proof["image_id"]):
        raise OCIImportError("Docker imported image ID differs from protected proof")
    runtime = metadata.get("Config") or {}
    labels = runtime.get("Labels") or {}
    env = runtime.get("Env") or []
    expected_rootfs = (config.get("rootfs") or {}).get("diff_ids")
    actual_rootfs = (metadata.get("RootFS") or {}).get("Layers")
    if (labels.get("org.opencontainers.image.revision") != sha
            or labels.get("org.opencontainers.image.version") != version
            or labels.get("org.opencontainers.image.source")
                != "https://github.com/b8vipvip/mv3c"
            or "BUILD_COMMIT=" + sha not in env
            or "MV3C_VERSION=" + version not in env
            or not isinstance(expected_rootfs, list)
            or actual_rootfs != expected_rootfs
            or len(actual_rootfs) != len(manifest["layers"])):
        raise OCIImportError("Docker imported image runtime/rootfs identity mismatch")


def load_verified_oci_candidate(archive: Path, proof: dict, version: str,
                                sha: str, *, cwd: Path,
                                min_free_bytes: int = 6 * 1024**3):
    """Import only an immutable candidate, never switch production image tags.

    Does not mutate mv3c:local or rollback; the canonical updater must
    separately handle its original deploy and final health/rollback logic.
    """
    if not isinstance(min_free_bytes, int) or min_free_bytes < MIN_RESERVED_BYTES:
        raise OCIImportError("Unsafe Docker import disk reserve")
    cwd = Path(cwd)
    if shutil.disk_usage(cwd).free < min_free_bytes:
        raise OCIImportError("Insufficient disk reserve before OCI Docker import")
    manifest, image_config = verify_oci_archive(
        archive, proof, version, sha)
    imported = _inspect(proof["registry_digest"], cwd)
    if imported is None:
        load = _command(
            ["docker", "image", "load", "--platform", "linux/amd64",
             "--input", str(archive)],
            cwd=cwd, timeout=1200)
        if load.returncode:
            raise OCIImportError("Docker failed loading protected OCI archive")
        imported = _inspect(proof["registry_digest"], cwd)
    if imported is None:
        raise OCIImportError("Docker loaded OCI but exact digest is not inspectable")
    _assert_identity(imported, manifest, image_config, proof, version, sha)
    candidate = "mv3c:sha-" + sha
    previous = _inspect(candidate, cwd)
    if previous is not None:
        if previous.get("Id") != imported.get("Id"):
            raise OCIImportError("Existing immutable release tag differs; refusing overwrite")
        return {"candidate": candidate, "digest": proof["registry_digest"],
                "image_id": imported["Id"], "already_tagged": True}
    tagged = _command(
        ["docker", "image", "tag", proof["registry_digest"], candidate],
        cwd=cwd)
    if tagged.returncode:
        raise OCIImportError("Docker refused tagging validated immutable candidate")
    confirmed = _inspect(candidate, cwd)
    if confirmed is None or confirmed.get("Id") != imported.get("Id"):
        raise OCIImportError("Docker candidate tag failed post-tag identity check")
    _assert_identity(confirmed, manifest, image_config, proof, version, sha)
    return {"candidate": candidate, "digest": proof["registry_digest"],
            "image_id": imported["Id"], "already_tagged": False}
