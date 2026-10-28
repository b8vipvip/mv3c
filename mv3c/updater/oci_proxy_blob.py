"""Resumable, fail-closed GHCR blob staging for future OCI transport.

This module intentionally DOES NOT import/tag images or touch Docker/containerd.
Only official, separately attested OCI manifests may supply the layer digest and
size. The canonical updater must not use this stage until an image-import
adapter has its own proof and production acceptance tests.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

REGISTRY = "ghcr.io"
REPOSITORY = "b8vipvip/mv3c"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[A-Za-z0-9._~+/\-=]+\Z")
MIN_RESERVED_BYTES = 2 * 1024 ** 3


class BlobTransferError(RuntimeError):
    """No unverified blob may be promoted to the immutable cache."""


def loopback_proxy(proxy: str) -> str:
    """Require a host-owned loopback proxy; never allow credentials in argv."""
    url = urlsplit(proxy)
    if (url.scheme not in {"socks5h", "socks5", "http", "https"}
            or url.hostname not in {"127.0.0.1", "::1", "localhost"}
            or not url.port or url.username or url.password
            or url.path or url.query or url.fragment):
        raise BlobTransferError("Expected an unauthenticated host-local proxy")
    return proxy


def _curl_env(proxy: str) -> dict[str, str]:
    env = os.environ.copy()
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                 "http_proxy", "https_proxy", "all_proxy"):
        env[name] = proxy
    env["NO_PROXY"] = ""
    env["no_proxy"] = ""
    return env


def _token(proxy: str) -> str:
    # The anonymous GHCR credential must not appear in process argv or logs.
    result = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--location",
         "--proto", "=https", "--proto-redir", "=https",
         "--noproxy", "", "--connect-timeout", "20", "--max-time", "45",
         "https://ghcr.io/token?scope=repository%3Ab8vipvip%2Fmv3c%3Apull"
         "&service=ghcr.io"],
        text=True, capture_output=True, timeout=50,
        env=_curl_env(proxy), check=False,
    )
    if result.returncode or len(result.stdout) > 1_000_000:
        raise BlobTransferError("Unable to obtain anonymous GHCR authorization")
    try:
        body = json.loads(result.stdout)
        token = body.get("token") or body.get("access_token")
    except (ValueError, AttributeError, TypeError) as error:
        raise BlobTransferError("Invalid GHCR token response") from error
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise BlobTransferError("Invalid GHCR token response")
    return token


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def _safe_file(path: Path) -> int:
    if path.is_symlink():
        raise BlobTransferError("Refusing symbolic link in blob stage")
    if not path.exists():
        return 0
    if not path.is_file():
        raise BlobTransferError("Refusing non-regular blob stage entry")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise BlobTransferError("Refusing shared or non-regular blob stage entry")
    return info.st_size


def stage_blob(stage: Path, digest: str, size: int, *, proxy: str,
               max_attempts: int = 8,
               reserve_bytes: int = MIN_RESERVED_BYTES,
               progress=None) -> Path:
    """Download one verified OCI blob with safe reconnects and disk reserve.

    A valid existing immutable blob is reused. Partial bytes remain at
    <digest>.part after interruption, while only exact-size SHA256-matched
    data become <digest>. No containerd namespace, image or tag is mutated.

    progress, if supplied, accepts a dictionary of counters with no token
    or signed URL. 'received_bytes' measures durable new file bytes, not
    actual network traffic (retries may transfer additional bytes).
    """
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise BlobTransferError("Invalid protected OCI blob digest")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= 4 * 1024 ** 3:
        raise BlobTransferError("Invalid protected OCI blob size")
    if (not isinstance(max_attempts, int) or not 1 <= max_attempts <= 25
            or not isinstance(reserve_bytes, int) or reserve_bytes < MIN_RESERVED_BYTES):
        raise BlobTransferError("Unsafe blob transfer budget")
    proxy = loopback_proxy(proxy)
    stage = Path(stage)
    if stage.is_symlink():
        raise BlobTransferError("Refusing symbolic link stage directory")
    stage.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = stage.stat()
    if (not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise BlobTransferError("Blob stage directory must be owner-only")
    digest_hex = digest.removeprefix("sha256:")
    final = stage / digest_hex
    part = stage / (digest_hex + ".part")

    existing = _safe_file(final)
    if existing:
        if existing != size or _hash(final) != digest:
            raise BlobTransferError("Existing immutable OCI blob has wrong size or SHA256")
        return final

    initial = _safe_file(part)
    if initial > size:
        raise BlobTransferError("Partial OCI blob exceeds attested size")
    if shutil.disk_usage(stage).free < reserve_bytes + size - initial:
        raise BlobTransferError("Insufficient disk reserve for OCI blob stage")

    token = _token(proxy)
    url = "https://" + REGISTRY + "/v2/" + REPOSITORY + "/blobs/" + digest
    last_size = initial
    stall = 0
    for attempt in range(1, max_attempts + 1):
        current = _safe_file(part)
        if current > size:
            raise BlobTransferError("Partial OCI blob exceeds attested size")
        if current == size:
            break
        if shutil.disk_usage(stage).free < reserve_bytes + size - current:
            raise BlobTransferError("Insufficient disk reserve for OCI blob continuation")
        # --config - holds the Bearer token on stdin, never in argv or logs.
        # curl rejects servers that disregard a resumed Range request.
        result = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location",
             "--proto", "=https", "--proto-redir", "=https",
             "--noproxy", "", "--connect-timeout", "20", "--max-time", "180",
             "--speed-limit", "16384", "--speed-time", "45",
             "--max-filesize", str(size),
             "--continue-at", "-", "--output", str(part),
             "--config", "-", url],
            input='header = "Authorization: Bearer ' + token + '"\n',
            text=True, capture_output=True, timeout=190,
            env=_curl_env(proxy), check=False,
        )
        updated = _safe_file(part)
        if updated > size:
            raise BlobTransferError("GHCR sent more data than attested blob size")
        if progress:
            progress({"attempt": attempt, "received_bytes": updated - initial,
                      "durable_bytes": updated, "expected_bytes": size,
                      "curl_exit": result.returncode})
        if updated == size:
            break
        stall = stall + 1 if updated <= last_size else 0
        last_size = updated
        if stall >= 3:
            raise BlobTransferError("OCI download stopped making forward progress")
    if _safe_file(part) != size:
        raise BlobTransferError("OCI blob incomplete; verified partial retained for retry")
    if _hash(part) != digest:
        raise BlobTransferError("OCI blob SHA256 mismatch; refusing promotion")
    os.replace(part, final)
    return final
