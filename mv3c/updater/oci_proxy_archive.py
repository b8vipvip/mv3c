"""Build an immutable, attested OCI image-layout archive from verified GHCR blobs.

Offline assembly only. This module must NOT load/tag Docker images, change the
canonical updater, write into containerd, or touch the production 'moby'
namespace. Docker import is a separately gated acceptance milestone.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import stat
import tarfile
from pathlib import Path

from oci_proxy_blob import (
    BlobTransferError, MIN_RESERVED_BYTES, _hash, _safe_file, stage_blob,
)
from oci_proxy_manifest import (
    ManifestProofError, decode_attested_config, decode_attested_manifest,
)

MAX_LAYOUT_BYTES = 12 * 1024**3


class OCIArchiveError(RuntimeError):
    pass


def _root_owned_stage(path: Path) -> None:
    if path.is_symlink():
        raise OCIArchiveError("Refusing symlink OCI blob stage")
    if not path.is_dir():
        raise OCIArchiveError("OCI blob stage does not exist")
    info = path.stat()
    if (not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise OCIArchiveError("OCI blob stage must be owner-only")


def _require_blob(stage: Path, descriptor: dict) -> Path:
    digest = descriptor["digest"]
    size = descriptor["size"]
    path = stage / digest[7:]
    try:
        measured = _safe_file(path)
    except BlobTransferError as error:
        raise OCIArchiveError("Unsafe OCI staged blob") from error
    if measured != size or _hash(path) != digest:
        raise OCIArchiveError("Missing or corrupted OCI blob: " + digest[:22])
    return path


def _add_bytes(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o600
    info.mtime = 0
    info.uid = info.gid = 0
    tar.addfile(info, io.BytesIO(data))


def _add_file(tar: tarfile.TarFile, name: str, path: Path, size: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = 0o600
    info.mtime = 0
    info.uid = info.gid = 0
    with path.open("rb") as stream:
        tar.addfile(info, stream)


def stage_all_attested_layers(stage: Path, manifest: dict, *, proxy: str,
                              progress=None) -> dict:
    """Stage all signed descriptors via resumable transfer, no image import.

    Counts durable bytes retained or newly staged; this is explicitly NOT a
    measurement of wire traffic. Retries may transfer the same bytes twice.
    """
    stage = Path(stage)
    _root_owned_stage(stage)
    descriptors = manifest["layers"]
    if sum(x["size"] for x in descriptors) != manifest["compressed_layer_bytes"]:
        raise OCIArchiveError("OCI layer total does not match validated manifest")
    unique = {item["digest"]: item for item in descriptors}
    # Repeated digests must never masquerade as descriptors with different size.
    if any(unique[x["digest"]]["size"] != x["size"] for x in descriptors):
        raise OCIArchiveError("Conflicting OCI descriptor sizes")
    staged_bytes = 0
    hits = 0
    http_body_bytes = 0
    complete_metrics = True

    def record(event):
        nonlocal http_body_bytes, complete_metrics
        count = event.get("http_body_bytes")
        if isinstance(count, int) and count >= 0:
            http_body_bytes += count
        else:
            complete_metrics = False
        if progress:
            progress({**event,
                      "cumulative_http_body_bytes":
                          http_body_bytes if complete_metrics else None})

    for item in unique.values():
        path = stage / item["digest"][7:]
        try:
            if _safe_file(path) == item["size"] and _hash(path) == item["digest"]:
                hits += 1
            stage_blob(stage, item["digest"], item["size"],
                       proxy=proxy, progress=record)
        except BlobTransferError as error:
            raise OCIArchiveError("OCI layer stage failed; partial retained") from error
        staged_bytes += item["size"]
    return {"unique_blobs": len(unique), "cached_blobs": hits,
            "staged_bytes": staged_bytes,
            "http_body_bytes": http_body_bytes if complete_metrics else None,
            "actual_wire_bytes": None}


def build_attested_oci_archive(stage: Path, target: Path, *,
                               raw_manifest: bytes, raw_config: bytes,
                               proof: dict, version: str, sha: str,
                               reserve_bytes: int = MIN_RESERVED_BYTES) -> Path:
    """Make a compressed-layer-preserving OCI layout tar, without Docker writes.

    The manifest is verified against the immutable Release proof, config
    against the manifest and runtime identity, and *every* layer against its
    compressed SHA256. Output is staged as a single .part file, published only
    after a complete tar and rechecked source digests.

    Callers must use an isolated, validated Docker import adapter; this
    function does not mutate images and MUST NOT tag mv3c:local.
    """
    stage, target = Path(stage), Path(target)
    _root_owned_stage(stage)
    manifest = decode_attested_manifest(raw_manifest, proof, version, sha)
    decode_attested_config(raw_config, manifest["config"], proof, version, sha,
                           len(manifest["layers"]))
    if target.is_symlink() or target.parent.resolve() != stage.resolve():
        raise OCIArchiveError("OCI archive target must be inside secured stage")
    if not target.name.startswith("oci-" + sha) or not target.name.endswith(".tar"):
        raise OCIArchiveError("OCI archive target must be release-specific")
    if target.exists():
        raise OCIArchiveError("Refusing to overwrite existing OCI archive")
    partial = target.with_name(target.name + ".part")
    if partial.exists() or partial.is_symlink():
        raise OCIArchiveError("Refusing to overwrite existing OCI partial archive")
    descriptors = [manifest["config"], *manifest["layers"]]
    unique = {item["digest"]: item for item in descriptors}
    if any(unique[x["digest"]]["size"] != x["size"] for x in descriptors):
        raise OCIArchiveError("Conflicting OCI descriptors for same digest")
    files = {digest: _require_blob(stage, item) for digest, item in unique.items()}
    expected = len(raw_manifest) + sum(x["size"] for x in unique.values()) + 1024 * 1024
    if (expected > MAX_LAYOUT_BYTES or not isinstance(reserve_bytes, int)
            or reserve_bytes < MIN_RESERVED_BYTES
            or shutil.disk_usage(stage).free < reserve_bytes + expected):
        raise OCIArchiveError("Insufficient reserved disk space for OCI layout")
    index = {
        "schemaVersion": 2,
        "manifests": [{
            "mediaType": json.loads(raw_manifest)["mediaType"],
            "digest": manifest["manifest_digest"],
            "size": len(raw_manifest),
            "platform": {"os": "linux", "architecture": "amd64"},
            "annotations": {"org.opencontainers.image.ref.name": "mv3c-oci-verify:sha-" + sha},
        }],
    }
    layout_bytes = b'{"imageLayoutVersion":"1.0.0"}'
    index_bytes = json.dumps(index, sort_keys=True, separators=(",", ":")).encode()
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(partial, flags, 0o600)
    published = False
    try:
        with os.fdopen(fd, "wb") as output:
            with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                _add_bytes(tar, "oci-layout", layout_bytes)
                _add_bytes(tar, "index.json", index_bytes)
                _add_bytes(tar, "blobs/sha256/" + manifest["manifest_digest"][7:],
                           raw_manifest)
                for digest, path in files.items():
                    # Recheck immediately before tar; stage is owner-only.
                    item = unique[digest]
                    _require_blob(stage, item)
                    _add_file(tar, "blobs/sha256/" + digest[7:],
                              path, item["size"])
            output.flush()
            os.fsync(output.fileno())
        os.replace(partial, target)
        published = True
        return target
    finally:
        if not published:
            try:
                partial.unlink()
            except FileNotFoundError:
                pass
