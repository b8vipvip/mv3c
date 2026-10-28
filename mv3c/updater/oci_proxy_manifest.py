"""Attested single-platform GHCR manifest inspector; never imports Docker images.

Only accepts the exact digest bound into the official Release image proof.
Fetches the small manifest and config (with SHA256 validation). Never pulls
large layers, modifies containerd, creates Docker tags or starts an update.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

from oci_proxy_blob import (
    BlobTransferError, _curl_env, _token, loopback_proxy, stage_blob,
)
from oci_registry import OCIProofError, attested_registry_manifest

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json"
OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip"
DOCKER_LAYER = "application/vnd.docker.image.rootfs.diff.tar.gzip"
HEX = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_MANIFEST = 1024 * 1024
MAX_CONFIG = 1024 * 1024
MAX_LAYERS = 128
MAX_TOTAL = 12 * 1024 ** 3
SOURCE = "https://github.com/b8vipvip/mv3c"


class ManifestProofError(RuntimeError):
    pass


def _descriptor(value: object, allowed_types: set[str], *, maximum: int) -> dict:
    if not isinstance(value, dict):
        raise ManifestProofError("OCI descriptor must be an object")
    digest, media, size = value.get("digest"), value.get("mediaType"), value.get("size")
    if (not isinstance(digest, str) or not HEX.fullmatch(digest)
            or media not in allowed_types
            or not isinstance(size, int) or isinstance(size, bool)
            or not 0 < size <= maximum
            or value.get("urls") or value.get("artifactType")):
        raise ManifestProofError("Unsafe or invalid OCI descriptor")
    return {"digest": digest, "mediaType": media, "size": size}


def decode_attested_manifest(raw: bytes, proof: dict, version: str, sha: str) -> dict:
    """Validate exact signed release ref AND each compressed layer descriptor.

    Deliberately reject OCI index/multiarch, zstd, foreign and non-distributable
    layers until supported and separately tested. No registry URLs are followed
    from descriptors: only the fixed GHCR repository is accessed.
    """
    try:
        manifest_digest = attested_registry_manifest(proof, version, sha)
    except OCIProofError as error:
        raise ManifestProofError("Invalid protected Release registry proof") from error
    if (not manifest_digest or not isinstance(raw, bytes)
            or len(raw) > MAX_MANIFEST or not raw):
        raise ManifestProofError("Missing protected manifest or oversized response")
    if "sha256:" + hashlib.sha256(raw).hexdigest() != manifest_digest:
        raise ManifestProofError("GHCR manifest SHA256 differs from protected Release")
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise ManifestProofError("Malformed GHCR manifest JSON") from error
    if (not isinstance(parsed, dict) or parsed.get("schemaVersion") != 2
            or parsed.get("mediaType") not in (OCI_MANIFEST, DOCKER_MANIFEST)
            or "manifests" in parsed or "subject" in parsed
            or "artifactType" in parsed):
        raise ManifestProofError("Unsupported GHCR image manifest type")
    config = _descriptor(parsed.get("config"), {OCI_CONFIG, DOCKER_CONFIG},
                         maximum=MAX_CONFIG)
    if config["digest"] != proof.get("image_id"):
        raise ManifestProofError("OCI config digest differs from protected image ID")
    values = parsed.get("layers")
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_LAYERS:
        raise ManifestProofError("Unexpected OCI layer count")
    layers = [_descriptor(v, {OCI_LAYER, DOCKER_LAYER},
                          maximum=4 * 1024 ** 3) for v in values]
    if sum(layer["size"] for layer in layers) > MAX_TOTAL:
        raise ManifestProofError("OCI compressed layers exceed safe budget")
    return {"manifest_digest": manifest_digest,
            "config": config, "layers": layers,
            "compressed_layer_bytes": sum(x["size"] for x in layers)}


def decode_attested_config(raw: bytes, descriptor: dict,
                           proof: dict, version: str, sha: str,
                           layer_count: int) -> None:
    if (not isinstance(raw, bytes) or len(raw) != descriptor["size"]
            or "sha256:" + hashlib.sha256(raw).hexdigest() != descriptor["digest"]):
        raise ManifestProofError("OCI config digest or size mismatch")
    try:
        config = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise ManifestProofError("Invalid OCI image configuration") from error
    if not isinstance(config, dict):
        raise ManifestProofError("Invalid OCI image configuration")
    runtime = config.get("config") or {}
    if not isinstance(runtime, dict):
        raise ManifestProofError("Invalid OCI runtime configuration")
    labels = runtime.get("Labels") or {}
    environ = runtime.get("Env") or []
    rootfs = config.get("rootfs") or {}
    diff_ids = rootfs.get("diff_ids") if isinstance(rootfs, dict) else None
    if (not isinstance(labels, dict) or not isinstance(environ, list)
            or not all(isinstance(x, str) for x in environ)
            or labels.get("org.opencontainers.image.revision") != sha
            or labels.get("org.opencontainers.image.version") != version
            or labels.get("org.opencontainers.image.source") != SOURCE
            or "BUILD_COMMIT=" + sha not in environ
            or "MV3C_VERSION=" + version not in environ
            or not isinstance(diff_ids, list)
            or len(diff_ids) != layer_count
            or not all(isinstance(x, str) and HEX.fullmatch(x) for x in diff_ids)):
        raise ManifestProofError("OCI runtime identity or rootfs mismatch")
    expected_diff = proof.get("rootfs_diff_ids")
    if expected_diff:
        if not isinstance(expected_diff, str) or expected_diff.split(",") != diff_ids:
            raise ManifestProofError("OCI rootfs differs from protected Release")


def _fetch_manifest(digest: str, proxy: str) -> bytes:
    token = _token(proxy)
    # Put Authorization in curl config on stdin, not visible in process argv.
    config = ('header = "Authorization: Bearer ' + token + '"\n'
              'header = "Accept: ' + OCI_MANIFEST + ', ' + DOCKER_MANIFEST + '"\n')
    try:
        result = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location",
             "--proto", "=https", "--proto-redir", "=https",
             "--noproxy", "", "--connect-timeout", "20", "--max-time", "90",
             "--max-filesize", str(MAX_MANIFEST),
             "--config", "-",
             "https://ghcr.io/v2/b8vipvip/mv3c/manifests/" + digest],
            input=config.encode("ascii"), capture_output=True, timeout=95,
            env=_curl_env(proxy), check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ManifestProofError("GHCR manifest request failed") from error
    if result.returncode:
        raise ManifestProofError("GHCR manifest request failed")
    return result.stdout


def inspect_attested_manifest(proof: dict, version: str, sha: str,
                              *, proxy: str, stage: Path) -> dict:
    """Check exact manifest and image config; NEVER download large layer blobs.

    The config is a <=1 MiB blob staged via resumable download. This function
    returns layer descriptors for a separate, future authorized import adapter.
    """
    try:
        proxy = loopback_proxy(proxy)
        digest = attested_registry_manifest(proof, version, sha)
        if digest is None:
            raise ManifestProofError("No attested GHCR manifest for this Release")
        manifest = decode_attested_manifest(
            _fetch_manifest(digest, proxy), proof, version, sha)
        desc = manifest["config"]
        staged = stage_blob(Path(stage), desc["digest"], desc["size"],
                            proxy=proxy)
        decode_attested_config(staged.read_bytes(), desc, proof, version, sha,
                               len(manifest["layers"]))
        return manifest
    except BlobTransferError as error:
        raise ManifestProofError("OCI config stage rejected or incomplete") from error
