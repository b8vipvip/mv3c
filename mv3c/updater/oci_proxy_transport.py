"""Host-local SOCKS/HTTP proxy GHCR transport for the ONE official updater.

No scheduler, job queue, Docker socket or deployment logic lives here.
The canonical updater must explicitly opt into this transport, under its
existing flock, and retain its original healthy/rollback checks.
"""
from __future__ import annotations

from pathlib import Path

from oci_proxy_blob import BlobTransferError, stage_blob
from oci_proxy_manifest import (
    ManifestProofError, _fetch_manifest, decode_attested_config,
    decode_attested_manifest,
)
from oci_proxy_archive import (
    OCIArchiveError, build_attested_oci_archive, stage_all_attested_layers,
)
from oci_proxy_import import (
    OCIImportError, load_verified_oci_candidate,
)
from oci_registry import OCIProofError, attested_registry_manifest


class OCIProxyTransportError(RuntimeError):
    pass


def prepare_proxy_candidate(repo: Path, sha: str, version: str, proof: dict,
                            disk_free, *, progress=None) -> str:
    """Stage+verify official compressed layers; import only SHA-tagged candidate.

    One root-owned cache is retained across Releases for later cache hits.
    Failure leaves valid partials in place for resume and NEVER changes the
    running container, current mv3c:local or mv3c:rollback tags.
    """
    from prebuilt import VERIFIED, _host_import_budget, _root_only_directory
    from prebuilt import _validated_download_proxy

    try:
        digest = attested_registry_manifest(proof, version, sha)
        if digest is None:
            raise OCIProxyTransportError("This official Release has no GHCR proof")
        proxy = _validated_download_proxy()
        if not proxy:
            raise OCIProxyTransportError(
                "Host-local MV3C_DOWNLOAD_PROXY is required for proxy OCI transport")
        budget = (2 * 1024**3 + _host_import_budget(int(proof["image_size"]))
                  + 512 * 1024**2)
        if disk_free(repo) < budget:
            raise OCIProxyTransportError(
                "Insufficient host disk reserve before OCI proxy transfer")
        _root_only_directory(VERIFIED)
        stage = VERIFIED / "oci-blob-cache"
        _root_only_directory(stage)
        raw_manifest = _fetch_manifest(digest, proxy)
        manifest = decode_attested_manifest(
            raw_manifest, proof, version, sha)
        conf_desc = manifest["config"]
        conf_path = stage_blob(
            stage, conf_desc["digest"], conf_desc["size"],
            proxy=proxy, progress=progress)
        raw_config = conf_path.read_bytes()
        decode_attested_config(
            raw_config, conf_desc, proof, version, sha,
            len(manifest["layers"]))
        summary = stage_all_attested_layers(
            stage, manifest, proxy=proxy, progress=progress)
        archive = stage / ("oci-" + sha + ".tar")
        if not archive.exists():
            build_attested_oci_archive(
                stage, archive, raw_manifest=raw_manifest,
                raw_config=raw_config, proof=proof,
                version=version, sha=sha)
        result = load_verified_oci_candidate(
            archive, proof, version, sha,
            cwd=repo, min_free_bytes=budget)
        measurement = summary["http_body_bytes"]
        return (
            "Verified proxy OCI manifest=" + digest
            + " candidate=" + result["candidate"]
            + " cached_blobs=" + str(summary["cached_blobs"])
            + "/" + str(summary["unique_blobs"])
            + " compressed_layer_bytes=" + str(manifest["compressed_layer_bytes"])
            + " curl_body_bytes=" + (
                str(measurement) if measurement is not None else "unavailable")
            + " (curl response-body count, not full TLS wire bytes)"
        )
    except (BlobTransferError, ManifestProofError, OCIArchiveError,
            OCIImportError, OCIProofError, ValueError) as error:
        # No credentials, raw URLs, response bodies, or network logs are
        # included in public-facing failure text.
        raise OCIProxyTransportError(
            "Attested OCI proxy candidate unavailable: " + type(error).__name__
        ) from error
