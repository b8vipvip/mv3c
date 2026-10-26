"""Import an attested GitHub Actions release archive into the existing MV3C updater.

This module is only called by agent.py under its existing flock and MongoDB job.
There is no background task, alternate deployment endpoint or local Docker build.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
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


def import_prebuilt(repo: Path, sha: str, version: str, git, disk_free) -> str:
    """Fail-closed import; NEVER touch live tag, compose service or Git checkout."""
    proof = verified_image_proof(repo, version, sha, git)
    path = _quarantine(version, sha, proof)
    if _sha256(path) != proof["archive_sha256"]:
        raise PrebuiltError("Prebuilt archive SHA-256 mismatch: refusing docker load")
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
    if image_id != proof["image_id"]:
        raise PrebuiltError("Imported image ID differs from protected Git release image proof")
    return "Verified GitHub Actions archive/import SHA-256=" + proof["archive_sha256"][:16] + " image=" + image_id[:24]
