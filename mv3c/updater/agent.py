#!/usr/bin/env python3
"""Host-only mv3c updater. Requires systemd, git and Docker Compose v2.

The web container NEVER receives a Docker socket or host filesystem mount.
A host timer executes this program. It reads a restricted MongoDB bridge through
docker compose exec, verifies GitHub CI, builds CI-validated commits using local Docker caches, switches and health-checks.
"""
from __future__ import annotations

import argparse
import datetime as dt
from collections import deque
from decimal import Decimal
import fcntl
import shutil
import json
import os
import re
import subprocess
import sys
import time
import threading
import urllib.error
import urllib.request
from pathlib import Path

REPO = "b8vipvip/mv3c"
SHA = re.compile(r"^[a-f0-9]{40}$")
TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
SSH_ORIGIN = "git@github.com:b8vipvip/mv3c.git"
HTTPS_ORIGIN = "https://github.com/b8vipvip/mv3c.git"
TRUSTED_ORIGINS = {SSH_ORIGIN, HTTPS_ORIGIN, "https://github.com/b8vipvip/mv3c"}
SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15"
# Pinned GitHub Ed25519 host key: same host identity used by chat2api updater.
GITHUB_HOST_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
GITHUB_KNOWN_HOSTS = Path("/run/mv3c-github-known-hosts")
RELEASE_TAG_REFS = "refs/mv3c-release/tags"
RELEASE_PROOF_REFS = "refs/mv3c-release/proofs"
GIT_REFSPECS = (
    "refs/heads/main:refs/remotes/origin/main",
    "refs/tags/v*:refs/mv3c-release/tags/v*",
    "refs/tags/mv3c-verified/v*:refs/mv3c-release/proofs/v*",
)
# Local Docker images remain in the host cache across updates. The GitHub
# Actions image is tested for the exact SHA, but does not need to be transferred.
MIN_DOCKER_FREE_BYTES = 3 * 1024 ** 3
BUILD_CACHE_SOFT_LIMIT_BYTES = 4 * 1024 ** 3
MAX_RETAINED_SHA_TAGS = 0
MIN_POST_BUILD_FREE_BYTES = 2 * 1024 ** 3
MAX_SHA_TAG_REMOVALS_PER_DEPLOY = 5
BUILD_LOG_PATH = Path("/var/log/mv3c-updater-build.log")


def image_for_sha(sha: str) -> str:
    if not SHA.fullmatch(sha):
        raise UpdateError("Untrusted Docker image revision")
    return "mv3c:sha-" + sha


def verify_built_image(repo: Path, sha: str) -> None:
    revision = run([
        "docker", "image", "inspect", "--format",
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        image_for_sha(sha),
    ], repo, timeout=30)
    if revision != sha:
        raise UpdateError("Locally built image revision mismatch: expected "
                          + sha[:12] + ", got " + revision[:80])



def verified_existing_candidate(repo: Path, sha: str) -> str | None:
    """Reuse only an immutable-SHA-tagged, fully inspectable official image.

    A build which succeeded but was rejected by the post-build disk reserve
    leaves its candidate tagged. Rebuilding the same SHA wastes disk and may
    repeatedly trip the reserve. Missing tags fall back to building; metadata
    mismatches fail closed rather than silently overwriting existing images.
    """
    tag = image_for_sha(sha)
    try:
        raw = run(["docker", "image", "inspect", "--format", "{{json .}}", tag],
                  repo, timeout=30)
    except UpdateError as error:
        message = str(error).lower()
        if "no such image" in message or "no such object" in message:
            return None
        raise
    try:
        image = json.loads(raw)
        config = image["Config"]
        labels = config["Labels"]
        env = config["Env"]
        image_id = image["Id"]
        layers = image["RootFS"]["Layers"]
    except (KeyError, ValueError, TypeError) as error:
        raise UpdateError("Existing candidate image inspection is invalid") from error
    release = version_for_sha(repo, sha)
    if not release or not TAG.fullmatch(release):
        raise UpdateError("Existing candidate has no official Release version")
    if (
        not isinstance(labels, dict)
        or labels.get("org.opencontainers.image.revision") != sha
        or labels.get("org.opencontainers.image.version") != release
        or labels.get("org.opencontainers.image.source") !=
            "https://github.com/b8vipvip/mv3c"
        or not isinstance(env, list)
        or ("BUILD_COMMIT=" + sha) not in env
        or ("MV3C_VERSION=" + release) not in env
        or not isinstance(image_id, str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id)
        or not isinstance(layers, list)
        or len(layers) == 0
    ):
        raise UpdateError(
            "Existing candidate image does not match trusted SHA/version, "
            "runtime metadata or complete layers; refusing reuse")
    return image_id


def parse_docker_size(raw: str) -> int:
    """Read docker system df Size values; reject unknown units instead of guessing."""
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B)\s*",
                         raw, flags=re.IGNORECASE)
    if not match:
        raise ValueError("Unsupported Docker size: " + str(raw)[:60])
    number, unit = match.groups()
    scale = {"B": 1, "KB": 1000, "MB": 1000**2, "GB": 1000**3,
             "TB": 1000**4, "PB": 1000**5, "EB": 1000**6,
             "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3,
             "TIB": 1024**4, "PIB": 1024**5, "EIB": 1024**6}
    return int(Decimal(number) * scale[unit.upper()])


def build_cache_usage(repo: Path) -> int | None:
    """Shared Docker BuildKit accounting, for monitoring ONLY (not GC)."""
    try:
        records = run(["docker", "system", "df", "--format", "{{json .}}"],
                      repo, timeout=30).splitlines()
        for record in records:
            item = json.loads(record)
            if item.get("Type") == "Build Cache":
                return parse_docker_size(item.get("Size", ""))
    except (UpdateError, ValueError, TypeError, KeyError, AttributeError) as error:
        print("MV3C BuildKit disk accounting unavailable:", str(error)[:180],
              flush=True)
    return None


def disk_free_bytes(repo: Path) -> int:
    docker_root = Path("/var/lib/docker")
    location = docker_root if docker_root.is_dir() else repo
    return shutil.disk_usage(location).free


def disk_status(repo: Path) -> str:
    free = disk_free_bytes(repo)
    cache = build_cache_usage(repo)
    summary = "Docker free {:.2f}GiB (minimum before build: 3GiB)".format(
        free / 1024**3)
    if cache is not None:
        summary += "; shared BuildKit cache {:.2f}GiB (MV3C alert threshold: 4GiB)".format(
            cache / 1024**3)
        if cache > BUILD_CACHE_SOFT_LIMIT_BYTES:
            summary += "; WARNING: shared cache over soft limit, no cross-project purge"
    return summary


def check_build_capacity(repo: Path) -> None:
    free = disk_free_bytes(repo)
    if free < MIN_DOCKER_FREE_BYTES:
        raise UpdateError(
            "Docker build blocked: {:.2f}GiB free, at least 3GiB required. "
            "Do not prune shared BuildKit cache or data volumes automatically."
            .format(free / 1024**3))
    print("MV3C pre-build disk gate: " + disk_status(repo), flush=True)
    available = meminfo_kib().get("MemAvailable", 0) * 1024
    if available and available < 512 * 1024**2:
        raise UpdateError("Build blocked: less than 512MiB host memory available")


def cleanup_stale_mv3c_image_tags(repo: Path) -> list[str]:
    """Only untag old MV3C-generated immutable SHA images, never shared caches.

    Called exclusively AFTER healthy deployment, under the updater flock.
    Docker also independently refuses non-forced deletes of referenced images.
    """
    if transaction_path(repo).exists():
        raise UpdateError("Refusing image maintenance while deployment journal exists")
    current_id = run(["docker", "image", "inspect", "--format", "{{.Id}}",
                      "mv3c:local"], repo, timeout=20)
    rollback_id = ""
    try:
        rollback_id = run(["docker", "image", "inspect", "--format", "{{.Id}}",
                           "mv3c:rollback"], repo, timeout=20)
    except UpdateError:
        # Deleted recovery tag is allowed: never remove running container images.
        pass
    containers = run(["docker", "ps", "-aq"], repo, timeout=20).splitlines()
    protected = {current_id, rollback_id}
    if containers:
        protected.update(run(["docker", "inspect", "--format", "{{.Image}}",
                              *containers], repo, timeout=30).splitlines())
    tags = run(["docker", "image", "ls", "--filter", "reference=mv3c:sha-*",
                "--format", "{{.Repository}}:{{.Tag}}"], repo, timeout=30).splitlines()
    candidates: list[tuple[str, str, str]] = []
    for tag in set(tags):
        if not re.fullmatch(r"mv3c:sha-[a-f0-9]{40}", tag):
            continue
        info = json.loads(run(["docker", "image", "inspect", tag], repo,
                              timeout=30))[0]
        labels = (info.get("Config") or {}).get("Labels") or {}
        if labels.get("org.opencontainers.image.revision") != tag[9:]:
            continue
        image_id = info.get("Id", "")
        if image_id in protected:
            continue
        candidates.append((info.get("Created", ""), tag, image_id))
    # Current immutable SHA and rollback images are already protected by ID.
    # Superseded extra SHA tags need not occupy space after a healthy deploy.
    candidates.sort(reverse=True)
    removed: list[str] = []
    for _created, tag, _image_id in candidates[MAX_RETAINED_SHA_TAGS:]:
        if len(removed) >= MAX_SHA_TAG_REMOVALS_PER_DEPLOY:
            break
        # No -f; Docker refuses images referenced by stopped/running containers.
        run(["docker", "image", "rm", tag], repo, timeout=60)
        removed.append(tag)
    return removed

def version_for_sha(repo: Path, sha: str) -> str:
    """Derive the real version from the fetched official release refs, not GitHub API."""
    if not SHA.fullmatch(sha):
        raise UpdateError("Invalid Git SHA for version lookup")
    versions = []
    for tag in list_release_tags(repo):
        if git(repo, "rev-parse", RELEASE_TAG_REFS + "/" + tag + "^{commit}") == sha:
            versions.append(tag)
    # Legacy local lightweight tags remain visible during upgrade from v0.1.5.
    if not versions:
        versions = [tag.strip() for tag in git(repo, "tag", "--points-at", sha).splitlines()
                    if TAG.fullmatch(tag.strip())]
    return max(versions, key=version_key) if versions else ""


def build_local_image(repo: Path, sha: str) -> None:
    """Reuse host layers, persistent BuildKit cache mounts and npm tarballs."""
    heap = os.environ.get("MV3C_BUILD_NODE_HEAP_MB", "2560")
    if not heap.isdecimal() or not 1024 <= int(heap) <= 8192:
        raise UpdateError("MV3C_BUILD_NODE_HEAP_MB must be 1024..8192")
    env = os.environ.copy()
    env["DOCKER_BUILDKIT"] = "1"
    details = run([
        "docker", "build", "--progress=plain",
        "--build-arg", "NODE_MAX_OLD_SPACE_SIZE=" + heap,
        "--build-arg", "NPM_CI_TIMEOUT_SECONDS=1800",
        "--build-arg", "BUILD_COMMIT=" + sha,
        "--build-arg", "BUILD_BRANCH=release",
        "--build-arg", "BUILD_VERSION=" + (version_for_sha(repo, sha) or "unreleased"),
        "-t", image_for_sha(sha), ".",
    ], repo, timeout=4500, env=env)
    verify_built_image(repo, sha)
    return details


class UpdateError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def meminfo_kib() -> dict[str, int]:
    try:
        data = Path("/proc/meminfo").read_text()
        return {match.group(1): int(match.group(2))
                for line in data.splitlines()
                if (match := re.match(r"^([A-Za-z_()]+):\s+(\d+) kB", line))}
    except (OSError, ValueError):
        return {}


def build_pressure_sample() -> dict[str, float]:
    mem = meminfo_kib()
    point = {
        "mem_available_mib": mem.get("MemAvailable", 0) / 1024,
        "swap_used_mib": (mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)) / 1024,
    }
    try:
        point["docker_free_gib"] = shutil.disk_usage("/var/lib/docker").free / 1024**3
    except OSError:
        pass
    try:
        match = re.search(r"(?m)^full avg10=([0-9.]+)", Path("/proc/pressure/io").read_text())
        if match:
            point["io_full_avg10"] = float(match.group(1))
    except OSError:
        pass
    return point


def build_pressure_summary(samples: list[dict[str, float]]) -> str:
    if not samples:
        return "Host build pressure: no samples"
    fields = ["Host build pressure: samples=" + str(len(samples))]
    for key, reduction, label in (
        ("mem_available_mib", min, "MiB minimum MemAvailable"),
        ("swap_used_mib", max, "MiB peak swap used"),
        ("docker_free_gib", min, "GiB minimum Docker free"),
        ("io_full_avg10", max, "% peak full I/O PSI avg10"),
    ):
        series = [point[key] for point in samples if key in point]
        if series:
            fields.append("{:.2f} {}".format(reduction(series), label))
    return "; ".join(fields)


def buildkit_summary(labels: dict[str, str], times: dict[str, float], cached: int) -> str:
    lines = ["BuildKit {} cached step(s)".format(cached)]
    for step, seconds in sorted(times.items(), key=lambda item: item[1], reverse=True)[:8]:
        lines.append("step #{} {:.1f}s {}".format(step, seconds, labels.get(step, "")[:100]))
    return "\n".join(lines)


def run_docker_build(args: list[str], cwd: Path, *, timeout: int,
                     env: dict[str, str] | None) -> str:
    """Stream build output to a root-only host log and retain useful errors.

    A failed registry pull can emit thousands of progress lines AFTER the
    actual error. Never keep only stdout[-3000:] or lose the failure reason.
    The fixed log is overwritten per build and contains no app credentials.
    """
    samples: list[dict[str, float]] = []
    stop = threading.Event()

    def sampler() -> None:
        while not stop.is_set():
            try:
                samples.append(build_pressure_sample())
            except Exception:
                pass  # Diagnostics never own deployment success or failure.
            stop.wait(5)

    thread = threading.Thread(target=sampler, daemon=True, name="mv3c-build-sampler")
    start = time.monotonic()
    thread.start()
    try:
        fd = os.open(BUILD_LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            try:
                completed = subprocess.run(args, cwd=cwd, stdout=stream,
                                           stderr=subprocess.STDOUT, timeout=timeout,
                                           env=env, check=False)
                code = completed.returncode
            except subprocess.TimeoutExpired:
                code = 124
    finally:
        stop.set()
        thread.join(timeout=2)
    elapsed = time.monotonic() - start
    important = deque(maxlen=12)
    causes = deque(maxlen=8)
    earliest = []
    tail = deque(maxlen=22)
    steps: dict[str, str] = {}
    seconds: dict[str, float] = {}
    cached_steps: set[str] = set()
    with BUILD_LOG_PATH.open("r", encoding="utf-8", errors="replace") as stored:
        for line in stored:
            line = line.rstrip()[:1000]
            tail.append(line)
            header = re.match(r"^#(\d+) \[(.+?)\] (.*)", line)
            if header:
                steps[header.group(1)] = header.group(2) + " " + header.group(3)
            done = re.match(r"^#(\d+) DONE ([0-9.]+)s$", line)
            if done:
                seconds[done.group(1)] = float(done.group(2))
            cached = re.match(r"^#(\d+) CACHED$", line)
            if cached:
                cached_steps.add(cached.group(1))
            # Docker's final failed RUN statement often hides npm's actual
            # error. Capture the original error markers before its long tail.
            primary = re.search(
                r"(?i)(?:npm\s+(?:ERR!|error)|EAI_AGAIN|ECONN(?:RESET|REFUSED)|"
                r"ETIMEDOUT|ENOTFOUND|ENOSPC|ENOMEM|EINTEGRITY|ERR_PNPM|"
                r"SIGKILL|signal\s+9|Killed process|out of memory|"
                r"no space left on device)", line,
            )
            secondary = re.search(
                r"(?i)(?:\berror[: ]|failed to|unexpected eof|connection reset|"
                r"deadline exceeded|tls handshake|timed out|timeout|"
                r"network is unreachable|not found|denied|429 too many requests)",
                line,
            )
            if primary:
                causes.append(line)
                if len(earliest) < 4:
                    earliest.append(line)
            elif secondary:
                important.append(line)
    summary = (
        "First root-cause candidates:\n" + "\n".join(earliest)[:1000] +
        "\nLast root-cause candidates:\n" + "\n".join(causes)[-1500:] +
        "\nOther errors:\n" + "\n".join(important)[-900:] +
        "\nLast output:\n" + "\n".join(tail)[-1500:]
    )
    diagnostics = ("Docker build {:.1f}s, exit={}\n".format(elapsed, code)
                   + build_pressure_summary(samples) + "\n"
                   + buildkit_summary(steps, seconds, len(cached_steps)))
    with BUILD_LOG_PATH.open("a", encoding="utf-8") as output:
        output.write("\nMV3C BUILD DIAGNOSTICS\n" + diagnostics + "\n")
    if code:
        raise UpdateError("docker build failed (exit {}), full log: {}\n{}\n{}".format(
            code, BUILD_LOG_PATH, diagnostics, summary))
    return (diagnostics + "\nDocker build succeeded; full log: "
            + str(BUILD_LOG_PATH) + "\n" + "\n".join(tail)[-1000:])

def run(args: list[str], cwd: Path, *, input_data: str | None = None,
        timeout: int = 120, env: dict[str, str] | None = None) -> str:
    if args[:2] == ["docker", "build"]:
        return run_docker_build(args, cwd, timeout=timeout, env=env)
    try:
        completed = subprocess.run(
            args, cwd=cwd, input=input_data, text=True, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise UpdateError("{} timed out after {} seconds".format(args[0], timeout)) from error
    if completed.returncode:
        raise UpdateError(
            "{} failed (exit {}): {}".format(args[0], completed.returncode,
                                             completed.stdout[-3000:]))
    return completed.stdout.strip()


def git(repo: Path, *args: str, timeout: int = 120, ssh_command: str | None = None) -> str:
    # All remote Git operations (both scheduled and admin-triggered) use SSH.
    # Never prompt for a passphrase, accept unknown host keys, or fall back to HTTPS.
    env = os.environ.copy()
    env["GIT_SSH_COMMAND"] = ssh_command or SSH_COMMAND
    env["GIT_TERMINAL_PROMPT"] = "0"
    return run(["git", *args], repo, timeout=timeout, env=env)


def prepare_github_known_hosts() -> None:
    """Pin GitHub's official Ed25519 key; never blindly ssh-keyscan a host."""
    content = ("github.com ssh-ed25519 " + GITHUB_HOST_KEY + "\n" +
               "ssh.github.com ssh-ed25519 " + GITHUB_HOST_KEY + "\n")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(GITHUB_KNOWN_HOSTS, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as output:
            output.write(content)
    except Exception:
        os.close(fd)
        raise


def fetch_from_origin(repo: Path, origin: str, *refspec: str,
                      transport: str = "ssh-22") -> None:
    """Bounded Git-only fetch from exact pinned sources. No REST API calls."""
    if origin not in (SSH_ORIGIN, HTTPS_ORIGIN):
        raise UpdateError("Untrusted GitHub source")
    if git(repo, "ls-remote", "--get-url", origin) != origin:
        raise UpdateError("Git URL rewrite prevents the expected transport")
    if transport == "ssh-443" and origin == SSH_ORIGIN:
        ssh = ("ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 "
               "-o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o StrictHostKeyChecking=yes "
               "-o HostName=ssh.github.com -o Port=443 -o HostKeyAlias=ssh.github.com "
               "-o UserKnownHostsFile=" + str(GITHUB_KNOWN_HOSTS) +
               " -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519")
    elif transport == "ssh-22" and origin == SSH_ORIGIN:
        ssh = ("ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 "
               "-o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o StrictHostKeyChecking=yes "
               "-o HostKeyAlias=github.com -o UserKnownHostsFile=" +
               str(GITHUB_KNOWN_HOSTS) +
               " -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519")
    elif transport == "https" and origin == HTTPS_ORIGIN:
        ssh = SSH_COMMAND
    else:
        raise UpdateError("Invalid transport/origin combination")
    args = ["fetch", "--quiet", "--no-tags", "--prune"]
    if transport == "https":
        args = ["-c", "http.version=HTTP/1.1", "-c", "http.lowSpeedLimit=1024",
                "-c", "http.lowSpeedTime=12"] + args
    git(repo, *args, origin, *refspec, timeout=35, ssh_command=ssh)


def fetch_prefer_ssh(repo: Path, *refspec: str) -> str:
    """Match chat2api SSH 443 -> SSH 22 -> HTTPS, bounded twice."""
    prepare_github_known_hosts()
    failures = []
    for attempt in range(2):
        for transport, origin in (
            ("ssh-443", SSH_ORIGIN), ("ssh-22", SSH_ORIGIN),
            ("https", HTTPS_ORIGIN),
        ):
            try:
                fetch_from_origin(repo, origin, *refspec, transport=transport)
                print("Git fetch verified transport:", transport, flush=True)
                return transport
            except UpdateError as error:
                failures.append(transport + ": " + str(error)[:150])
        if attempt == 0:
            time.sleep(2)
    raise UpdateError("Git SSH-443 / SSH-22 / HTTPS all failed (bounded): " +
                      "; ".join(failures)[-850:])


def version_key(tag: str) -> tuple[int, int, int]:
    if not TAG.fullmatch(tag):
        raise UpdateError("Invalid official version tag")
    return tuple(map(int, tag[1:].split(".")))


def list_release_tags(repo: Path) -> list[str]:
    raw = git(repo, "for-each-ref", "--format=%(refname:strip=3)",
              RELEASE_TAG_REFS)
    return [tag for tag in raw.splitlines() if TAG.fullmatch(tag)]


def verify_release_proof(repo: Path, tag: str, sha: str) -> None:
    """Only a post-Release CI-proof tag produced by the publishing workflow passes.

    This relies on GitHub repository write access controls; it is not a detached
    cryptographic signature. Protect release/proof tags using repository rulesets.
    """
    if not TAG.fullmatch(tag) or not SHA.fullmatch(sha):
        raise UpdateError("Invalid release verification arguments")
    proof = RELEASE_PROOF_REFS + "/" + tag
    try:
        kind = git(repo, "cat-file", "-t", proof)
        peeled = git(repo, "rev-parse", proof + "^{commit}")
        contents = git(repo, "cat-file", "-p", proof)
    except UpdateError as error:
        raise UpdateError("Missing release CI proof for " + tag +
                          "; GitHub publish workflow must finish") from error
    if kind != "tag" or peeled != sha:
        raise UpdateError("Release proof is not an annotated tag for the selected SHA")
    payload = contents.split("\n\n", 1)
    if len(payload) != 2:
        raise UpdateError("Malformed official release proof annotation")
    lines = payload[1].splitlines()
    if not lines or lines[0] != "MV3C_OFFICIAL_RELEASE_PROOF_V1":
        raise UpdateError("Unsupported release CI proof format")
    fields = {}
    for line in lines[1:]:
        if "=" in line:
            key, value = line.split("=", 1)
            if key in fields:
                raise UpdateError("Duplicate release CI proof field")
            fields[key] = value
    if fields.get("release") != tag or fields.get("sha") != sha:
        raise UpdateError("Release CI proof version/SHA mismatch")
    if any(fields.get(k) != "success" for k in ("validation", "docker", "published")):
        raise UpdateError("Release proof does not show both successful CI workflows")
    if any(not re.fullmatch(r"[1-9][0-9]{0,19}", fields.get(k, ""))
           for k in ("validation_id", "docker_id")):
        raise UpdateError("Release proof lacks valid CI run references")



def bridge(repo: Path, command: str, data: dict | None = None) -> object:
    output = run(
        ["docker", "compose", "exec", "-T", "mv3c",
         "node", "/app/mv3c/updater/bridge.cjs", command],
        repo,
        input_data=json.dumps(data) if data is not None else None,
        timeout=40,
    )
    try:
        return json.loads(output.splitlines()[-1])
    except (IndexError, ValueError) as error:
        raise UpdateError("Invalid response from mv3c update bridge") from error


def report(repo: Path, **fields: object) -> None:
    bridge(repo, "report", fields)


def verify_repo(repo: Path) -> str:
    if not (repo / ".git").exists() or not (repo / "docker-compose.yml").is_file():
        raise UpdateError("Expected a Git checkout with mv3c docker-compose.yml")
    raw_origin = git(repo, "config", "--local", "--get", "remote.origin.url")
    effective_origin = git(repo, "remote", "get-url", "origin")
    if raw_origin not in TRUSTED_ORIGINS or effective_origin not in TRUSTED_ORIGINS:
        raise UpdateError(
            "mv3c 只允许固定的 GitHub SSH/HTTPS 仓库，"
            "请检查 origin 与 Git URL rewrite 配置。"
        )
    branch = git(repo, "symbolic-ref", "--short", "HEAD")
    if branch != "main":
        raise UpdateError("Host checkout must be on the main branch")
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise UpdateError("Local tracked changes detected; commit or revert them first")
    return git(repo, "rev-parse", "HEAD")


def is_descendant(repo: Path, previous: str, target: str) -> bool:
    return subprocess.run(
        ["git", "merge-base", "--is-ancestor", previous, target],
        cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False, timeout=20,
    ).returncode == 0


def target_for_channel(repo: Path, channel: str) -> tuple[str, str]:
    """Discover the newest release and its Git-published CI evidence without REST."""
    if channel != "release":
        raise UpdateError("Only published GitHub Releases may be deployed")
    fetch_prefer_ssh(repo, *GIT_REFSPECS)
    tags = list_release_tags(repo)
    if not tags:
        raise UpdateError("No Git-published release tags found")
    tag = max(tags, key=version_key)
    sha = git(repo, "rev-parse", RELEASE_TAG_REFS + "/" + tag + "^{commit}")
    if not SHA.fullmatch(sha):
        raise UpdateError("Invalid Git commit for release")
    verify_release_proof(repo, tag, sha)
    main_sha = git(repo, "rev-parse", "refs/remotes/origin/main")
    if not SHA.fullmatch(main_sha) or not is_descendant(repo, sha, main_sha):
        raise UpdateError("Published release proof is not on trusted main history")
    return sha, tag


def wait_healthy(repo: Path, timeout: int = 210) -> None:
    deadline = time.monotonic() + timeout
    last = "not ready"
    while time.monotonic() < deadline:
        try:
            cid = run(["docker", "compose", "ps", "-q", "mv3c"], repo, timeout=15)
            if cid:
                last = run(
                    ["docker", "inspect", "--format",
                     "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
                     cid.splitlines()[0]], repo, timeout=15,
                )
                if last == "healthy":
                    return
                if last == "unhealthy":
                    raise UpdateError("New mv3c container is unhealthy")
        except UpdateError as error:
            last = str(error)
        time.sleep(5)
    raise UpdateError("mv3c failed its health check: " + last[:300])


def verify_deployment(repo: Path, expected_sha: str) -> str:
    """Verify the running app, not merely whether Docker Compose exited 0."""
    actual = git(repo, "rev-parse", "HEAD")
    if actual != expected_sha:
        raise UpdateError("Git checkout SHA mismatch after deployment")
    cid = run(["docker", "compose", "ps", "-q", "mv3c"], repo, timeout=20)
    if not cid:
        raise UpdateError("mv3c container is missing")
    container_id = cid.splitlines()[0]
    health = run(["docker", "inspect", "--format",
                  "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
                  container_id], repo, timeout=20)
    if health != "healthy":
        raise UpdateError("Container post-deploy health is " + health)
    running_image = run(
        ["docker", "inspect", "--format", "{{.Image}}", container_id],
        repo, timeout=20,
    )
    tagged_image = run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", "mv3c:local"],
        repo, timeout=20,
    )
    if running_image != tagged_image:
        raise UpdateError("Running container image does not match newly built image")
    expected_version = version_for_sha(repo, expected_sha)
    if expected_version:
        image_version = run([
            "docker", "image", "inspect", "--format",
            '{{index .Config.Labels "org.opencontainers.image.version"}}',
            "mv3c:local",
        ], repo, timeout=20)
        if image_version != expected_version:
            raise UpdateError("Docker image Release version mismatch")
    for url in ("http://127.0.0.1:3080/readyz",
                "http://127.0.0.1:3080/api/config",
                "http://127.0.0.1:3080/api/config/version"):
        try:
            with urllib.request.urlopen(url, timeout=15) as response:
                if response.status != 200:
                    raise UpdateError("HTTP smoke verification failed: " + url)
                data = response.read(200_000)
                if url.endswith("/api/config") and not isinstance(json.loads(data), dict):
                    raise UpdateError("Startup configuration is not a JSON object")
                if url.endswith("/api/config/version"):
                    version_payload = json.loads(data)
                    if (version_payload.get("sha") != expected_sha or
                            version_payload.get("version") != (expected_version or "unreleased")):
                        raise UpdateError("Live server version and commit do not match deployment")
        except (urllib.error.URLError, ValueError) as error:
            raise UpdateError("HTTP smoke verification failed: " + url + " " +
                              str(error)[:200]) from error
    return ("Post-deploy validation PASSED: git SHA=" + actual[:12]
            + "; running image matches built tag; container healthy;"
            + " /readyz HTTP 200; /api/config HTTP 200; live version attested")


def verify_restored_service(repo: Path, expected_sha: str) -> str:
    """Prove an old image is restored, even if it predates official version labels.

    This is recovery-only. Never use this for admitting a candidate release:
    candidates must pass strict verify_deployment with exact SHA and semver.
    """
    try:
        return "Rollback validation PASSED: " + verify_deployment(repo, expected_sha)
    except UpdateError as original:
        # Only the pre-existing unversioned image exception is recoverable.
        if not any(word in str(original) for word in (
            "Docker image Release version mismatch",
            "Live server version and commit do not match deployment",
        )):
            raise
    if git(repo, "rev-parse", "HEAD") != expected_sha:
        raise UpdateError("Rollback Git SHA differs from previous checkout")
    image_id = run(["docker", "image", "inspect", "--format", "{{.Id}}",
                    "mv3c:rollback"], repo, timeout=20)
    local_id = run(["docker", "image", "inspect", "--format", "{{.Id}}",
                    "mv3c:local"], repo, timeout=20)
    cid = run(["docker", "compose", "ps", "-q", "mv3c"], repo, timeout=20)
    if not cid or local_id != image_id:
        raise UpdateError("Rollback image tag does not match original backup")
    running = run(["docker", "inspect", "--format", "{{.Image}}",
                   cid.splitlines()[0]], repo, timeout=20)
    health = run(["docker", "inspect", "--format",
                  "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
                  cid.splitlines()[0]], repo, timeout=20)
    if running != image_id or health != "healthy":
        raise UpdateError("Legacy rollback is not running its backed-up healthy image")
    version = run(["docker", "image", "inspect", "--format",
                   '{{index .Config.Labels "org.opencontainers.image.version"}}',
                   "mv3c:rollback"], repo, timeout=20)
    revision = run(["docker", "image", "inspect", "--format",
                    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
                    "mv3c:rollback"], repo, timeout=20)
    if version not in ("", "<no value>", "unreleased") or (
        revision not in ("", "<no value>", expected_sha)
    ):
        raise UpdateError("Rollback metadata identifies a different release; refusing legacy exception")
    for path in ("/readyz", "/api/config", "/api/config/version"):
        url = "http://127.0.0.1:3080" + path
        with urllib.request.urlopen(url, timeout=15) as response:
            if response.status != 200:
                raise UpdateError("Legacy rollback endpoint not healthy: " + path)
            payload = response.read(200_000)
            if path == "/api/config" and not isinstance(json.loads(payload), dict):
                raise UpdateError("Legacy rollback config is invalid")
            if path == "/api/config/version":
                live = json.loads(payload)
                # A legacy manually built image can have an "unreleased"
                # OCI label while its server still reports the legitimate
                # previous Git release. This exception is for recovery ONLY.
                prior_version = version_for_sha(repo, expected_sha)
                allowed = {"", "unreleased", version}
                if prior_version:
                    allowed.add(prior_version)
                if live.get("sha") not in ("", expected_sha) or (
                    live.get("version") not in allowed
                ):
                    raise UpdateError("Legacy rollback reports conflicting live version")
    return ("Rollback recovery PASSED: original running Docker image and Git checkout "
            "restored, container healthy and HTTP checks passed; WARNING: previous "
            "manual image has no attested release version. This is NOT a new deployment.")


def transaction_path(repo: Path) -> Path:
    return repo / ".mv3c-local-build-transaction.json"


def save_transaction(repo: Path, old: str, target: str) -> None:
    journal = transaction_path(repo)
    if journal.exists():
        raise UpdateError("Previous local deployment was interrupted; recover it first")
    pending = journal.with_suffix(".tmp")
    pending.write_text(json.dumps({"old": old, "target": target}), encoding="utf-8")
    os.chmod(pending, 0o600)
    os.replace(pending, journal)


def restore_interrupted_local_deploy(repo: Path) -> str:
    """Resolve a crash after fast-forward/build, before any new deployment."""
    journal = transaction_path(repo)
    if not journal.exists():
        return ""
    data = json.loads(journal.read_text(encoding="utf-8"))
    previous, target = data.get("old"), data.get("target")
    if not isinstance(previous, str) or not SHA.fullmatch(previous) or not (
        isinstance(target, str) and SHA.fullmatch(target)
    ):
        raise UpdateError("Invalid deployment recovery journal; refusing to alter Git or Docker")
    current = git(repo, "rev-parse", "HEAD")
    if current not in (previous, target):
        raise UpdateError("Git HEAD differs from the interrupted deployment; manual intervention required")
    git(repo, "reset", "--hard", previous, timeout=60)
    run(["docker", "image", "tag", "mv3c:rollback", "mv3c:local"], repo, timeout=30)
    current_container = run(["docker", "compose", "ps", "-q", "mv3c"], repo, timeout=20)
    running_id = (run(["docker", "inspect", "--format", "{{.Image}}",
                       current_container.splitlines()[0]], repo, timeout=20)
                  if current_container else "")
    old_id = run(["docker", "image", "inspect", "--format", "{{.Id}}",
                  "mv3c:rollback"], repo, timeout=20)
    health = (run(["docker", "inspect", "--format",
                   "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
                   current_container.splitlines()[0]], repo, timeout=20)
              if current_container and running_id == old_id else "")
    if running_id != old_id or health != "healthy":
        run(["docker", "compose", "up", "-d", "--no-build", "--pull", "never",
             "--no-deps", "--force-recreate", "mv3c"], repo, timeout=240)
    wait_healthy(repo)
    verified = verify_restored_service(repo, previous)
    journal.unlink()
    print(verified, flush=True)
    return "Interrupted local build/deployment restored verified version " + previous[:12]


def deploy(repo: Path, old: str, target: str, *, on_progress=None) -> tuple[str, str, str]:
    """Build from the CI-approved commit with the host's Docker/BuildKit cache."""
    log: list[str] = []
    backed_up = False
    switched = False
    journal = transaction_path(repo)

    def advance(stage: str, percent: int, detail: str) -> None:
        log.append("[{}] {}% {}".format(stage, percent, detail))
        if on_progress:
            try:
                on_progress(stage, percent, detail)
            except Exception as exc:
                log.append("Progress transport warning: " + str(exc)[:300])

    try:
        advance("backup", 36, "确认官方候选镜像与磁盘空间，保留当前镜像用于回滚")
        # Reusing a complete, verified, immutable Release image is NOT a build.
        # Require the 3GiB build threshold only when a new Docker build is
        # actually needed. The post-build 2GiB switch reserve still applies.
        staged_candidate = verified_existing_candidate(repo, target)
        if staged_candidate is None:
            check_build_capacity(repo)
        elif disk_free_bytes(repo) < MIN_POST_BUILD_FREE_BYTES:
            raise UpdateError(
                "Verified existing Release image is ready, but less than 2GiB "
                "disk free; refusing to switch. No build or restart attempted.")
        else:
            log.append("Verified immutable Release candidate already cached; "
                       "skip 3GiB build-only preflight")
        run(["docker", "image", "tag", "mv3c:local", "mv3c:rollback"],
            repo, timeout=30)
        backed_up = True
        save_transaction(repo, old, target)
        advance("merging", 43, "Git 快进至已通过 CI 的源码版本")
        git(repo, "merge", "--ff-only", target, timeout=60)
        log.append("Git fast-forward: " + old[:12] + " -> " + target[:12])
        advance("building", 54, "先验证同 SHA 的已有镜像，缺失时再增量构建")
        candidate = verified_existing_candidate(repo, target)
        if candidate:
            log.append("Reused verified existing Release image " +
                       candidate[:24] + " for " + target[:12] +
                       " (skipped redundant Docker build)")
        else:
            details = build_local_image(repo, target)
            if isinstance(details, str):
                log.append(details[-6000:])
            # A successful build must also pass the complete metadata gate,
            # so both fresh and reused paths have the same admission rules.
            candidate = verified_existing_candidate(repo, target)
            if not candidate:
                raise UpdateError("Docker build returned success but candidate tag is missing")
            log.append("New Docker build image verified: " + candidate[:24])
        if disk_free_bytes(repo) < MIN_POST_BUILD_FREE_BYTES:
            raise UpdateError(
                "Candidate built but less than 2GiB disk free; refusing to "
                "switch the running container. Preserve old healthy service.")
        log.append("Official Release candidate identity and disk reserve PASSED: "
                   + target[:12])
        # Only change the stable image tag after the candidate has built and
        # been verified. The old running container remains untouched up to here.
        run(["docker", "image", "tag", image_for_sha(target), "mv3c:local"],
            repo, timeout=30)
        advance("restarting", 76, "切换已构建镜像，保持 MongoDB 和数据卷不变")
        switched = True
        log.append(run(["docker", "compose", "up", "-d", "--no-build", "--pull",
                        "never", "--no-deps", "--force-recreate", "mv3c"],
                       repo, timeout=240)[-3000:])
        advance("verifying", 87, "确认容器健康状态")
        wait_healthy(repo)
        advance("verifying", 94, "校验当前提交、运行镜像、readyz 和配置 API")
        log.append(verify_deployment(repo, target))
        journal.unlink(missing_ok=True)
        # Cleanup is not part of the deployment transaction. Failing to prune
        # an old SHA tag must never roll back a healthy production service.
        try:
            removed = cleanup_stale_mv3c_image_tags(repo)
            log.append("MV3C SHA image retention: removed {} stale tag(s)".format(
                len(removed)))
            for tag in removed:
                log.append("Untagged stale MV3C candidate: " + tag)
            log.append("Disk after deployment: " + disk_status(repo))
        except Exception as maintenance_error:
            log.append("Post-deploy disk maintenance warning (service still healthy): "
                       + str(maintenance_error)[:800])
        return "success", "\n".join(log)[-24000:], ""
    except Exception as error:
        failure = str(error)[:1600]
        log.append("Deployment failed: " + failure)
        # The database diagnostic report retains the build error, but admins
        # commonly inspect systemd output first. Never hide the reason behind
        # a generic rolled_back status.
        print("mv3c deployment failure before rollback: " + failure[:1000],
              file=sys.stderr, flush=True)
        if not backed_up:
            log.append("Preflight failed; live container, Git and image unchanged")
            return "failed", "\n".join(log)[-24000:], failure
        try:
            if not switched:
                # The only pre-switch changes were a Git fast-forward and a
                # backup tag. Do not restart the untouched production container
                # or depend on its MongoDB/DNS during this recovery.
                git(repo, "reset", "--hard", old, timeout=60)
                journal.unlink(missing_ok=True)
                log.append("Candidate deployment blocked before container switch; "
                           "original running image and container were never changed. "
                           "Git checkout restored; no Docker restart attempted.")
                return "failed", "\n".join(log)[-24000:], failure
            advance("rollback", 95, "服务已切换，恢复旧提交与回滚镜像")
            git(repo, "reset", "--hard", old, timeout=60)
            run(["docker", "image", "tag", "mv3c:rollback", "mv3c:local"],
                repo, timeout=30)
            log.append(run(["docker", "compose", "up", "-d", "--no-build",
                            "--pull", "never", "--no-deps", "--force-recreate",
                            "mv3c"], repo, timeout=240)[-2000:])
            wait_healthy(repo)
            validation = verify_restored_service(repo, old)
            log.append(validation)
            journal.unlink(missing_ok=True)
            return "rolled_back", "\n".join(log)[-24000:], failure
        except Exception as rollback_error:
            log.append("Rollback failed: " + str(rollback_error)[:1500])
            return "failed", "\n".join(log)[-24000:], failure + "; rollback failed"


def check_needed(state: dict) -> bool:
    checked = state.get("checkedAt")
    requested = state.get("checkRequestedAt")
    # The bridge exposes checkRequestedAt separately from the admin response.
    interval = state.get("config", {}).get("intervalMinutes", 10)
    if not state.get("config", {}).get("autoEnabled", True):
        if not requested:
            return False
        try:
            request_time = dt.datetime.fromisoformat(requested.replace("Z", "+00:00"))
            previous_time = (dt.datetime.fromisoformat(checked.replace("Z", "+00:00"))
                             if checked else None)
            if previous_time is not None and request_time <= previous_time:
                return False
        except (TypeError, ValueError):
            return False
    if not checked:
        return True
    try:
        last = dt.datetime.fromisoformat(checked.replace("Z", "+00:00"))
        if requested:
            check = dt.datetime.fromisoformat(requested.replace("Z", "+00:00"))
            if check > last:
                return True
        return (dt.datetime.now(dt.timezone.utc) - last).total_seconds() >= interval * 60
    except (TypeError, ValueError):
        return True


def recover_interrupted_job(repo: Path, active: dict, installed_sha: str) -> None:
    """Reconcile a job abandoned when systemd or the server restarts.

    This runs only under the host updater's exclusive flock. It never resets
    data or guesses that an unfinished deployment succeeded without checks.
    """
    job_id = active.get("id")
    if not job_id:
        return
    # Only a target pinned to this specific claimed job is authoritative.
    # A global latestSha from a prior check could equal the old version and
    # falsely report success for an update interrupted before its fetch.
    target_sha = active.get("targetSha", "")
    attempted = target_sha if isinstance(target_sha, str) and SHA.fullmatch(target_sha) else ""
    old = installed_sha
    try:
        validation = verify_deployment(repo, installed_sha)
        # A Git fast-forward alone does not prove that the container switched.
        # Require evidence that Compose completed its recreation step.
        deployment_reached_verification = (
            active.get("progress", {}).get("stage") in ("verifying", "complete")
            and active.get("progress", {}).get("percent", 0) >= 86
        )
        is_target = bool(attempted and old == attempted and deployment_reached_verification)
        outcome = "success" if is_target else "failed"
        message = ("Updater interrupted, but target is healthy and verified"
                   if is_target else "Updater interrupted before completing target deployment")
        error = "" if is_target else message
    except Exception as exc:
        outcome = "failed"
        error = "Interrupted update verification failed: " + str(exc)[:1400]
        validation = "Interrupted update: live service verification FAILED"
        message = error
    try:
        bridge(repo, "progress", {
            "jobId": job_id, "stage": "complete", "percent": 100,
            "message": message[:300],
        })
    except Exception as exc:
        print("Recovery progress reporting warning:", str(exc)[:200], flush=True)
    bridge(repo, "complete", {
        "jobId": job_id, "outcome": outcome, "error": error,
        "log": "Recovery after interrupted updater: " + message +
               "\n" + validation,
        "sha": old, "fromSha": active.get("fromSha", ""), "attemptedSha": attempted,
        "verification": validation,
    })


def execute(repo: Path) -> None:
    # Recover BEFORE the database bridge: a container that crashed during
    # switching may be unavailable, so it cannot be asked for job state.
    recovered = restore_interrupted_local_deploy(repo)
    if recovered:
        print(recovered, flush=True)
    state = bridge(repo, "state")
    if not isinstance(state, dict):
        raise UpdateError("Invalid update state")
    try:
        old = verify_repo(repo)
    except Exception as error:
        report(repo, status="blocked", lastError=str(error)[:1800])
        raise
    report(repo, currentSha=old, currentVersion=version_for_sha(repo, old))
    if state.get("activeJob"):
        recover_interrupted_job(repo, state["activeJob"], old)
        return
    if not check_needed(state) and not state.get("pendingJob"):
        return

    # Claim manual work before GitHub checks: progress should say what the
    # worker is doing instead of reporting "queued" for a long fetch.
    job = bridge(repo, "claim") if state.get("pendingJob") else None
    label = ""  # Failures before release resolution cannot report an unspecified version.
    def progress(stage: str, percent: int, message: str, *,
                 from_sha: str = "", target_sha: str = "") -> None:
        if job:
            bridge(repo, "progress", {
                "jobId": job["id"], "stage": stage,
                "percent": percent, "message": message,
                **({"fromSha": from_sha} if from_sha else {}),
                **({"targetSha": target_sha} if target_sha else {}),
            })

    def complete(outcome: str, *, log: str, error: str = "",
                 sha: str = old, attempted: str = "", verification: str = "") -> None:
        if not job:
            return
        try:
            progress("complete", 100, {
                "success": "部署和部署后验证成功",
                "skipped": "当前已经是最新版本，无需重启",
                "rolled_back": "部署失败，已回滚并验证旧版服务",
                "failed": "更新失败，请下载报告排查",
            }[outcome])
        except Exception as exc:
            print("Terminal progress reporting warning:", str(exc)[:200], flush=True)
        bridge(repo, "complete", {
            "jobId": job["id"], "outcome": outcome, "log": log,
            "error": error, "sha": sha, "fromSha": old,
            "attemptedSha": attempted, "verification": verification,
            "version": label if outcome == "success" else "",
        })

    try:
        progress("checking", 8, "检查当前 Git 状态与更新通道", from_sha=old)
        progress("fetching", 16, "优先 SSH 获取 GitHub 提交（失败回退 HTTPS）")
        target, label = target_for_channel(repo, "release")
        if not is_descendant(repo, old, target):
            raise UpdateError("Target commit is not a fast-forward descendant of deployed version")
        available = target != old
        progress("ci", 26, "校验 Git 发布记录中绑定 SHA 的两项 CI 证明", target_sha=target)
        good, reason = True, ""  # CI was verified by the fetched post-Release Git proof.
        ci_pending = not good and reason.startswith(
            ("GitHub CI 尚未完成：", "GitHub CI 正在运行："))
        report(repo, currentSha=old, currentVersion=version_for_sha(repo, old),
               latestSha=target, latestVersion=label, latestLabel=label,
               latestUrl="https://github.com/" + REPO + "/releases/tag/" + label,
               checkedAt=utc_now(), updateAvailable=available,
               ciMessage=reason if ci_pending else "",
               **({"status": "checking", "lastError": ""}
                  if available and ci_pending and not job else
                  {"status": "blocked", "lastError": reason}
                  if available and not good and not job else
                  {"status": "idle", "lastError": ""}
                  if not available and not job else
                  {"lastError": ""} if good and not job else {}))
    except Exception as error:
        message = str(error)[:1800]
        report(repo, checkedAt=utc_now(), lastError=message, ciMessage="",
               **({"status": "blocked"} if not job else {}))
        complete("failed", error=message,
                 log="Unable to resolve or verify the GitHub commit: " + message,
                 verification="Pre-deployment verification FAILED")
        raise

    if not available:
        complete("skipped", log="Already running the latest commit " + old,
                 sha=old, attempted=target,
                 verification="Skipped: current version already matches target")
        return
    if not good:
        complete("failed", error=reason,
                 log="GitHub CI gate blocked deployment: " + reason,
                 attempted=target, verification="CI gate FAILED")
        return

    if not job and state["config"].get("autoEnabled", True) and state["config"].get("autoDeployEnabled", False):
        if target == state.get("blockedSha"):
            report(repo, status="blocked",
                   lastError="此提交上次部署失败，已暂停自动重试；可手动重试或等待新的 GitHub 提交")
            return
        bridge(repo, "queue-auto")
        job = bridge(repo, "claim")
        if job:
            progress("checking", 8, "自动更新已通过 GitHub 版本检查", from_sha=old)
            progress("fetching", 16, "GitHub 代码已拉取")
            progress("ci", 26, "Git 发布证明与 SHA 已验证", target_sha=target)
    if not job:
        return

    print("Deploying published mv3c Release", label, target, flush=True)
    # Docker may be busy installing dependencies or exporting layers for minutes.
    # A heartbeat ONLY renews the current job lease; it never updates progress,
    # declares a terminal, or authorizes a second deployment process.
    heartbeat_stop = threading.Event()
    def heartbeat_during_deploy() -> None:
        while not heartbeat_stop.wait(40):
            try:
                bridge(repo, "heartbeat", {"jobId": job["id"]})
            except Exception as exc:
                # The old container might not support the command during its
                # first upgrade, or be unavailable during recreation.
                print("MV3C updater heartbeat warning:", str(exc)[:160], flush=True)
    heartbeat_thread = threading.Thread(
        target=heartbeat_during_deploy, daemon=True, name="mv3c-update-heartbeat"
    )
    heartbeat_thread.start()
    try:
        outcome, log, error = deploy(repo, old, target, on_progress=progress)
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2)
    validation_line = next(
        (line for line in log.splitlines()
         if line.startswith(("Post-deploy validation PASSED", "Rollback validation PASSED"))),
        "Verification failed" if outcome == "failed" else "Deployment failed; recovered old version",
    )
    complete(outcome, log=log, error=error,
             sha=target if outcome == "success" else old, attempted=target,
             verification=validation_line)
    print("mv3c update:", outcome, flush=True)
    if outcome not in ("success", "skipped"):
        # Preserve the database completion first, then let systemd signal the
        # failed attempted deployment instead of reporting a green oneshot.
        raise UpdateError("Deployment " + outcome + ": " + error[:1000])



def main() -> int:
    parser = argparse.ArgumentParser(description="mv3c host update worker")
    parser.add_argument("--repo", required=True, type=Path, help="Host Git checkout path")
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    if os.geteuid() != 0:
        raise UpdateError("Updater must run as root (Docker deployment privileges)")
    lock_file = Path("/run/lock/mv3c-updater.lock")
    with lock_file.open("w") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another mv3c update check is already running")
            return 0
        execute(repo)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("mv3c updater:", str(exc)[:1800], file=sys.stderr)
        sys.exit(1)
