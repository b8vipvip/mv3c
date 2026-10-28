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
    # Optional OCI distribution is bound to the SAME immutable release proof.
    # Older V1 proofs intentionally have no registry fields and use tar.gz.
    if "registry" in values or "registry_digest" in values:
        if (values.get("registry") != "ghcr.io/b8vipvip/mv3c"
                or not IMAGE_ID.fullmatch(values.get("registry_digest", ""))):
            raise PrebuiltError("Invalid optional registry digest in signed image proof")
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


def _validated_download_proxy() -> str | None:
    """Optional root-only host configuration; never depend on another container.

    The canonical systemd unit reads /etc/mv3c/updater-proxy.env. Proxy
    authentication in URLs is intentionally rejected to avoid credentials
    leaking through diagnostics; prefer a dedicated loopback SOCKS/HTTP service.
    """
    from urllib.parse import urlsplit

    proxy = os.environ.get("MV3C_DOWNLOAD_PROXY", "").strip()
    if not proxy:
        return None
    try:
        parsed = urlsplit(proxy)
        port = parsed.port
    except ValueError as error:
        raise PrebuiltError("Invalid MV3C download proxy configuration") from error
    if (parsed.scheme not in ("socks5h", "http", "https")
            or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
            or port is None or not 1 <= port <= 65535
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise PrebuiltError(
            "MV3C_DOWNLOAD_PROXY must be a credential-free loopback "
            "socks5h/http/https proxy (an independent host service)")
    return proxy


def _host_import_budget(image_size: int) -> int:
    """Conservative actual disk budget for Docker 29's containerd snapshotter.

    The attested CI 'image_size' is a Docker logical size, not the on-disk
    unpacked unique footprint on every host. The production Docker 29 host
    observed ~3.72 GB unique disk for a ~1.65 GB CI-reported image. Keep
    a bounded 2.5x allowance rather than filling the 40GB production volume.
    No cleanup or image deletion is attempted here.
    """
    return (image_size * 5 + 1) // 2


def _download_release_asset(repo: Path, version: str, sha: str,
                            proof: dict, disk_free) -> Path:
    """Bounded multi-process HTTP Range resume for a verified official asset.

    Unlike curl's internal retry, each new curl starts at the actual durable
    file offset. Transient CDN drops cannot silently force a full re-download.
    A missing/invalid proxy fails closed, and no Docker mutation occurs here.
    """
    import time

    _root_only_directory(VERIFIED)
    path = VERIFIED / filename(version, sha)
    partial = VERIFIED / (filename(version, sha) + ".download")
    if partial.is_symlink():
        raise PrebuiltError("Refusing a symlinked partial Release download")
    archive_bytes = int(proof["archive_size"])
    image_bytes = int(proof["image_size"])
    proxy = _validated_download_proxy()

    env = os.environ.copy()
    if proxy:
        # The proxy secret is never written to stdout, argv, or updater DB.
        env.update({
            "HTTPS_PROXY": proxy, "https_proxy": proxy,
            "ALL_PROXY": proxy, "all_proxy": proxy,
        })
        env.pop("NO_PROXY", None)
        env.pop("no_proxy", None)
    retryable = {18, 28, 35, 52, 55, 56, 92}
    deadline = time.monotonic() + 45 * 60
    stalls = 0
    for attempt in range(1, 26):
        if time.monotonic() >= deadline:
            raise PrebuiltError("Official Release download deadline reached; partial retained")
        if partial.exists():
            info = partial.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_nlink != 1):
                raise PrebuiltError("Partial Release download is not a root-owned regular file")
            previous = info.st_size
        else:
            previous = 0
        if previous > archive_bytes:
            raise PrebuiltError("Partial Release exceeds signed artifact size")
        if previous == archive_bytes:
            break
        required = archive_bytes - previous + _host_import_budget(image_bytes) + int(2.5 * 1024**3)
        free = min(disk_free(repo), shutil.disk_usage(VERIFIED).free)
        if free < required:
            raise PrebuiltError(
                "Insufficient space for verified Release download/import: "
                f"free={free}, required={required}; no Docker build/prune attempted")

        curl = [
            "curl", "--fail", "--location", "--silent", "--show-error",
            "--proto", "=https", "--proto-redir", "=https",
            "--connect-timeout", "20", "--max-time", "420",
            "--speed-limit", "32768", "--speed-time", "90",
            "--continue-at", "-", "--write-out", "%{http_code}",
            "--output", str(partial),
        ]
        if proxy:
            curl += ["--noproxy", ""]
        curl.append(release_asset_url(version, sha))
        try:
            result = subprocess.run(
                curl, cwd=repo, capture_output=True, text=True,
                timeout=455, check=False, env=env,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PrebuiltError(
                "Official Release downloader unavailable or timed out; partial retained"
            ) from error
        http = (getattr(result, "stdout", None) or "").strip()
        retryable_failure = (result.returncode in retryable or
                             (result.returncode == 22 and http in
                              {"429", "500", "502", "503", "504"}))
        info = partial.lstat() if partial.exists() else None
        if info is None:
            # curl may fail before it creates --output (DNS, proxy or CDN
            # HTTP error). Do not misreport a network error as an unsafe file,
            # and do not let transient no-byte failures bypass stall limits.
            reason = (result.stderr or "").strip().replace("\n", " ")[-250:]
            if result.returncode == 0 or not retryable_failure:
                raise PrebuiltError(
                    "Official Release HTTPS failed before creating partial "
                    f"(curl exit={result.returncode}, http={http or 'none'}): {reason}")
            stalls += 1
            if stalls >= 3:
                raise PrebuiltError(
                    "Official Release HTTPS failed three times before creating "
                    f"partial (last curl exit={result.returncode}, "
                    f"http={http or 'none'}): {reason}")
            print(f"MV3C Release network retry {attempt}/25: "
                  f"no partial bytes, curl={result.returncode}, "
                  f"http={http or 'none'}", flush=True)
            time.sleep(min(3 * (2 ** min(attempt - 1, 4)), 30))
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise PrebuiltError("Unsafe partial Release file (not root-owned regular single-link)")
        os.chmod(partial, 0o600)
        current = info.st_size
        if current < previous or current > archive_bytes:
            raise PrebuiltError("Invalid resumed Release byte offset")
        if previous and http == "200":
            raise PrebuiltError(
                "Release CDN ignored HTTP Range on resumed download; rejecting partial")
        if result.returncode == 0 and current == archive_bytes:
            break
        if not retryable_failure and result.returncode != 0:
            raise PrebuiltError(
                "Official Release HTTPS failed (curl exit " +
                str(result.returncode) + "); partial retained: " +
                (result.stderr or "")[-250:])
        if current == previous:
            stalls += 1
        else:
            stalls = 0
        if stalls >= 3:
            raise PrebuiltError("Official Release download stalled three times; partial retained")
        print(
            "MV3C Release resume attempt {}/25: {} / {} bytes, curl={}".format(
                attempt, current, archive_bytes, result.returncode),
            flush=True,
        )
        if attempt < 25:
            time.sleep(min(3 * (2 ** min(attempt - 1, 4)), 30))
    else:
        raise PrebuiltError("Official Release retry budget exhausted; partial retained")

    info = partial.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_nlink != 1 or info.st_size != archive_bytes):
        raise PrebuiltError("Release archive size differs from official image proof")
    os.chmod(partial, 0o600)
    if _sha256(partial) != proof["archive_sha256"]:
        raise PrebuiltError("Official Release SHA256 mismatch; refusing image import")
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
    # An OPTIONAL registry manifest is already cryptographically pinned inside
    # the same immutable Git image proof. Its Docker RepoDigests must still
    # include the exact attested registry reference, not a fabricated label.
    if docker_id == proof.get("registry_digest"):
        import json
        try:
            raw = subprocess.check_output(
                ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}",
                 "mv3c:sha-" + sha],
                cwd=repo, text=True, timeout=30,
            )
            if "ghcr.io/b8vipvip/mv3c@" + docker_id in (json.loads(raw) or []):
                return True
        except (OSError, ValueError, subprocess.CalledProcessError,
                subprocess.TimeoutExpired):
            pass
        raise PrebuiltError("Signed OCI manifest is missing from local image digest references")
    # Manifest digest requires its exact official archive; labels alone cannot
    # authorize an unrelated local image or weaken the CI-bound proof.
    archive = prepare_archive(repo, version, sha, proof, disk_free)
    return docker_id in archive_attested_image_ids(
        archive, proof, "mv3c:sha-" + sha)


def import_prebuilt(repo: Path, sha: str, version: str, git, disk_free) -> str:
    """Fail-closed import; NEVER touch live tag, compose service or Git checkout."""
    proof = verified_image_proof(repo, version, sha, git)
    # Registry pull is explicitly opt-in: public packages use content-
    # addressable Docker layers, so unchanged dependencies are not downloaded.
    # If GitHub Container Registry is inaccessible, retain the existing signed
    # full-archive fallback, with no second updater or trust authority.
    if os.environ.get("MV3C_OCI_LAYER_TRANSPORT", "") == "enabled":
        from oci_registry import OCIProofError, pull_registry_candidate
        try:
            registry_result = pull_registry_candidate(
                repo, version, sha, proof, git, disk_free)
        except OCIProofError as error:
            raise PrebuiltError(str(error)) from error
        if registry_result:
            return registry_result
    path = prepare_archive(repo, version, sha, proof, disk_free)
    # Docker loads unpacked layers in addition to the already staged archive.
    # Conservative reserve protects the 40GB host; no prune or source build.
    minimum = 2 * 1024**3 + _host_import_budget(int(proof["image_size"])) + 512 * 1024**2
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
