"""Import an attested GitHub Actions release archive into the existing MV3C updater.

This module is only called by agent.py under its existing flock and MongoDB job.
There is no background task, alternate deployment endpoint or local Docker build.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

SOURCE = "https://github.com/b8vipvip/mv3c"
INCOMING = Path("/var/lib/mv3c-prebuilt/incoming")
VERIFIED = Path("/var/lib/mv3c-prebuilt/verified")
PROOF_PREFIX = "refs/mv3c-release/images/"
SHA = re.compile(r"[a-f0-9]{40}\Z")
TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+\Z")
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")


class PrebuiltError(Exception):
    pass


def filename(version: str, sha: str) -> str:
    if not TAG.fullmatch(version) or not SHA.fullmatch(sha):
        raise PrebuiltError("Invalid official Release version/SHA")
    return f"mv3c-{version}-{sha}.tar.gz"


def verified_image_proof(repo: Path, version: str, sha: str, git) -> dict:
    """Validate protected annotated image-tag contents bound to the Release commit."""
    ref = PROOF_PREFIX + version
    try:
        kind = git(repo, "cat-file", "-t", ref)
        commit = git(repo, "rev-parse", ref + "^{commit}")
        raw = git(repo, "cat-file", "-p", ref)
    except Exception as exc:
        raise PrebuiltError("Missing published image proof for " + version) from exc
    if kind != "tag" or commit != sha:
        raise PrebuiltError("Image proof is not an annotated tag on the Release SHA")
    message = raw.split("\n\n", 1)
    if len(message) != 2 or message[1].splitlines()[0] != "MV3C_PREBUILT_IMAGE_V1":
        raise PrebuiltError("Invalid official image proof format")
    values = {}
    for line in message[1].splitlines()[1:]:
        if "=" in line:
            key, value = line.split("=", 1)
            if key in values:
                raise PrebuiltError("Duplicate image proof field")
            values[key] = value
    if values.get("release") != version or values.get("sha") != sha:
        raise PrebuiltError("Image proof Release mismatch")
    if not HEX.fullmatch(values.get("archive_sha256", "")):
        raise PrebuiltError("Invalid archive SHA-256 proof")
    if not IMAGE_ID.fullmatch(values.get("image_id", "")):
        raise PrebuiltError("Invalid image ID proof")
    for key in ("archive_size", "image_size", "build_run_id"):
        if not re.fullmatch(r"[1-9][0-9]{0,19}", values.get(key, "")):
            raise PrebuiltError("Invalid image proof size/run reference: " + key)
    if int(values["archive_size"]) > 6 * 1024**3 or int(values["image_size"]) > 12 * 1024**3:
        raise PrebuiltError("Image artifact is unexpectedly large")
    return values


def _root_only_directory(path: Path) -> None:
    if path.is_symlink():
        raise PrebuiltError("Untrusted symlink at " + str(path))
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise PrebuiltError("Verified artifact directory must be root-owned 0700")


def _quarantine(version: str, sha: str, proof: dict) -> Path:
    """Move inbound payload out of the writable SCP directory before verification."""
    _root_only_directory(VERIFIED)
    name = filename(version, sha)
    target = VERIFIED / name
    if not target.exists():
        incoming = INCOMING / name
        if incoming.is_symlink():
            raise PrebuiltError("Refusing symlink upload")
        try:
            original = incoming.lstat()
        except FileNotFoundError as exc:
            raise PrebuiltError("Prebuilt archive is not yet delivered: " + name) from exc
        if not stat.S_ISREG(original.st_mode) or original.st_nlink != 1:
            raise PrebuiltError("Upload is not a single regular file")
        if original.st_size != int(proof["archive_size"]):
            raise PrebuiltError("Uploaded archive size does not match official proof")
        # Atomic same-filesystem move into a root-controlled directory.
        try:
            os.rename(incoming, target)
        except OSError as exc:
            raise PrebuiltError("Could not quarantine uploaded release archive") from exc
    if target.is_symlink():
        raise PrebuiltError("Refusing symlink in verified archive directory")
    info = target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise PrebuiltError("Verified release archive is not a regular single-link file")
    os.chown(target, 0, 0)
    os.chmod(target, 0o600)
    if info.st_size != int(proof["archive_size"]):
        raise PrebuiltError("Verified archive size mismatch")
    return target


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as src:
        while chunk := src.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def release_asset_url(version: str, sha: str) -> str:
    """Fixed public GitHub Release download path; untrusted URLs are never accepted."""
    return SOURCE + "/releases/download/" + version + "/" + filename(version, sha)


def _download_release_asset(repo: Path, version: str, sha: str,
                            proof: dict, disk_free) -> Path:
    """Pull exact official Release asset via TLS; support bounded resume.

    The host initiates HTTPS instead of accepting inbound SCP. The Git image
    proof (verified before this method) cryptographically binds the payload.
    """
    _root_only_directory(VERIFIED)
    path = VERIFIED / filename(version, sha)
    partial = VERIFIED / (filename(version, sha) + ".download")
    if partial.is_symlink():
        raise PrebuiltError("Refusing a symlinked partial Release download")
    previous = 0
    if partial.exists():
        info = partial.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                info.st_nlink != 1):
            raise PrebuiltError("Partial Release download is not a root-owned regular file")
        previous = info.st_size
    archive_bytes = int(proof["archive_size"])
    if previous > archive_bytes:
        raise PrebuiltError("Partial Release download larger than signed artifact")
    # Space needed for remaining compressed bytes plus unpacked image and the
    # same post-switch reserve as the original SCP design.
    required = archive_bytes - previous + int(proof["image_size"]) + int(2.5 * 1024**3)
    free = min(disk_free(repo), shutil.disk_usage(VERIFIED).free)
    if free < required:
        raise PrebuiltError(
            "Insufficient space for HTTPS Release download and image import: "
            f"free={free}, required={required}; no Docker build/prune attempted")
    cmd = [
        "curl", "--fail", "--location", "--silent", "--show-error",
        "--connect-timeout", "20", "--max-time", "2400",
        "--retry", "2", "--retry-delay", "5", "--retry-all-errors",
        "--speed-limit", "32768", "--speed-time", "90",
        "--continue-at", "-", "--output", str(partial),
        release_asset_url(version, sha),
    ]
    try:
        result = subprocess.run(
            cmd, cwd=repo, capture_output=True, text=True, timeout=2500,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PrebuiltError("HTTPS Release download unavailable or timed out") from exc
    if result.returncode != 0:
        raise PrebuiltError(
            "Official GitHub Release HTTPS download failed; "
            "no Docker mutation attempted: " + result.stderr[-500:])
    info = partial.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_size != archive_bytes):
        raise PrebuiltError("HTTPS Release archive file size does not match image proof")
    os.chown(partial, 0, 0)
    os.chmod(partial, 0o600)
    if _sha256(partial) != proof["archive_sha256"]:
        raise PrebuiltError("HTTPS Release SHA256 mismatch; refusing image import")
    os.replace(partial, path)
    return path


def prepare_archive(repo: Path, version: str, sha: str, proof: dict,
                    disk_free) -> Path:
    """Stage signed bytes either from an existing complete file or HTTPS.

    Reuse existing validated archival copies for interrupted deployments.
    Partial legacy SCP files are not silently treated as complete archives.
    """
    _root_only_directory(VERIFIED)
    name = filename(version, sha)
    complete = VERIFIED / name
    source = INCOMING / name
    if complete.exists() or complete.is_symlink() or source.exists() or source.is_symlink():
        path = _quarantine(version, sha, proof)
    else:
        path = _download_release_asset(repo, version, sha, proof, disk_free)
    if _sha256(path) != proof["archive_sha256"]:
        raise PrebuiltError("Official Release artifact SHA256 mismatch")
    return path



def archive_attested_image_ids(path: Path, proof: dict, tag: str) -> set[str]:
    """Bind Docker's OCI manifest ID to the signed config ID in one exact archive.

    Classic Docker image stores expose the config digest as .Id. Docker's
    containerd image store may expose the OCI manifest digest instead. Never
    accept an arbitrary manifest digest: its verified bytes must reference
    the exact config digest attested by the Release proof, and the OCI index
    and Docker save manifest must reference that same image.
    """
    import json
    import tarfile

    config_id = proof["image_id"]
    expected_blob = "blobs/sha256/" + config_id.removeprefix("sha256:")
    docs = {}
    with tarfile.open(path, mode="r|gz") as source:
        for item in source:
            if not item.isfile():
                continue
            name = item.name.removeprefix("./")
            if name not in ("manifest.json", "index.json", expected_blob) and not (
                name.startswith("blobs/sha256/") and item.size <= 1024 * 1024
            ):
                continue
            if item.size > 1024 * 1024:
                raise PrebuiltError("OCI attestation metadata unexpectedly large")
            stream = source.extractfile(item)
            if stream is None:
                raise PrebuiltError("Missing OCI archive metadata")
            raw = stream.read()
            if name.startswith("blobs/sha256/"):
                digest = name.removeprefix("blobs/sha256/")
                if not HEX.fullmatch(digest) or hashlib.sha256(raw).hexdigest() != digest:
                    raise PrebuiltError("OCI attestation blob digest mismatch")
            try:
                docs[name] = json.loads(raw)
            except (ValueError, UnicodeDecodeError) as error:
                # Small OCI layer blobs may be binary; only metadata required
                # for the signed config-to-manifest chain must be JSON.
                if name in ("manifest.json", "index.json", expected_blob):
                    raise PrebuiltError("Malformed OCI attestation metadata") from error
                continue

    entries = docs.get("manifest.json")
    if (not isinstance(entries, list) or len(entries) != 1
            or not isinstance(entries[0], dict)
            or entries[0].get("RepoTags") != [tag]
            or entries[0].get("Config") != expected_blob):
        raise PrebuiltError("Docker archive does not reference signed OCI config/tag")
    config = docs.get(expected_blob)
    if not isinstance(config, dict):
        raise PrebuiltError("Signed OCI image config is missing from archive")
    labels = (config.get("config") or {}).get("Labels") or {}
    environ = (config.get("config") or {}).get("Env") or []
    if (labels.get("org.opencontainers.image.revision") != proof["sha"]
            or labels.get("org.opencontainers.image.version") != proof["release"]
            or labels.get("org.opencontainers.image.source") != SOURCE
            or "BUILD_COMMIT=" + proof["sha"] not in environ
            or "MV3C_VERSION=" + proof["release"] not in environ
            or not (config.get("rootfs") or {}).get("diff_ids")):
        raise PrebuiltError("Signed OCI config metadata does not match official Release")

    allowed = {config_id}
    index = docs.get("index.json")
    if not isinstance(index, dict):
        return allowed
    descriptors = index.get("manifests")
    if not isinstance(descriptors, list):
        raise PrebuiltError("Invalid OCI index")
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            continue
        digest = descriptor.get("digest", "")
        if (not isinstance(digest, str) or
                not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)):
            continue
        manifest = docs.get("blobs/sha256/" + digest.removeprefix("sha256:"))
        if (isinstance(manifest, dict) and manifest.get("schemaVersion") == 2
                and (manifest.get("config") or {}).get("digest") == config_id
                and (manifest.get("config") or {}).get("mediaType") in (
                    "application/vnd.oci.image.config.v1+json",
                    "application/vnd.docker.container.image.v1+json",
                )
                and isinstance(manifest.get("layers"), list)
                and len(manifest["layers"]) > 0):
            allowed.add(digest)
    return allowed


def verified_local_candidate_id(repo: Path, sha: str, version: str,
                                proof: dict, docker_id: str, disk_free) -> bool:
    """Accept config ID or OCI manifest ID only when bound by signed archive."""
    if docker_id == proof["image_id"]:
        return True
    # Manifest digest requires its exact official archive; labels alone cannot
    # authorize an unrelated local image or weaken the CI-bound proof.
    archive = prepare_archive(repo, version, sha, proof, disk_free)
    return docker_id in archive_attested_image_ids(
        archive, proof, "mv3c:sha-" + sha)


def import_prebuilt(repo: Path, sha: str, version: str, git, disk_free) -> str:
    """Fail-closed import; NEVER touch live tag, compose service or Git checkout."""
    proof = verified_image_proof(repo, version, sha, git)
    path = prepare_archive(repo, version, sha, proof, disk_free)
    # Docker loads unpacked layers in addition to the already staged archive.
    # Conservative reserve protects the 40GB host; no prune or source build.
    minimum = 2 * 1024**3 + int(proof["image_size"]) + 512 * 1024**2
    if disk_free(repo) < minimum:
        raise PrebuiltError(
            f"Insufficient space to import prebuilt image safely; need {minimum / 1024**3:.2f}GiB "
            "free including 2GiB switch reserve; no Docker build or prune attempted")
    try:
        result = subprocess.run(
            ["docker", "image", "load", "-i", str(path)],
            cwd=repo, capture_output=True, text=True, timeout=1200, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PrebuiltError("Prebuilt Docker image import failed or timed out") from exc
    if result.returncode != 0:
        raise PrebuiltError("Docker load rejected official archive: " + result.stderr[-800:])
    tag = "mv3c:sha-" + sha
    try:
        image_id = subprocess.check_output(
            ["docker", "image", "inspect", "--format", "{{.Id}}", tag],
            cwd=repo, text=True, timeout=30,
        ).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise PrebuiltError("Imported prebuilt image has no canonical immutable SHA tag") from exc
    if image_id not in archive_attested_image_ids(path, proof, tag):
        raise PrebuiltError(
            "Imported Docker image ID is not the signed config or its bound OCI "
            "manifest digest: actual=" + image_id +
            ", signed-config=" + proof["image_id"])
    return "Verified GitHub Actions archive/import SHA-256=" + proof["archive_sha256"][:16] + " image=" + image_id[:24]
