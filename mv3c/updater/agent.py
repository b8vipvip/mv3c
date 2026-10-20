#!/usr/bin/env python3
"""Host-only mv3c updater. Requires systemd, git and Docker Compose v2.

The web container NEVER receives a Docker socket or host filesystem mount.
A host timer executes this program. It reads a restricted MongoDB bridge through
docker compose exec, verifies GitHub CI, builds, switches and health-checks.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = "b8vipvip/mv3c"
API = "https://api.github.com/repos/" + REPO
SHA = re.compile(r"^[a-f0-9]{40}$")
TAG = re.compile(r"^v?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$")
SSH_ORIGIN = "git@github.com:b8vipvip/mv3c.git"
HTTPS_ORIGIN = "https://github.com/b8vipvip/mv3c.git"
TRUSTED_ORIGINS = {SSH_ORIGIN, HTTPS_ORIGIN, "https://github.com/b8vipvip/mv3c"}
SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15"
CI_NAMES = {"mv3c validation", "mv3c source Docker build"}
USER_AGENT = "mv3c-updater/1.0"


class UpdateError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def run(args: list[str], cwd: Path, *, input_data: str | None = None,
        timeout: int = 120, env: dict[str, str] | None = None) -> str:
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


def git(repo: Path, *args: str, timeout: int = 120) -> str:
    # All remote Git operations (both scheduled and admin-triggered) use SSH.
    # Never prompt for a passphrase, accept unknown host keys, or fall back to HTTPS.
    env = os.environ.copy()
    env["GIT_SSH_COMMAND"] = SSH_COMMAND
    env["GIT_TERMINAL_PROMPT"] = "0"
    return run(["git", *args], repo, timeout=timeout, env=env)


def fetch_from_origin(repo: Path, origin: str, *refspec: str) -> None:
    """Fetch into origin's tracking refs from a pinned, explicitly selected URL."""
    if origin not in (SSH_ORIGIN, HTTPS_ORIGIN):
        raise UpdateError("Untrusted GitHub source")
    # A direct URL avoids relying on the configured origin transport.
    # Verify insteadOf rewrites before fetching; no arbitrary destinations.
    effective = git(repo, "ls-remote", "--get-url", origin)
    if effective != origin:
        raise UpdateError("Git URL rewrite prevents the expected transport")
    git(repo, "fetch", "--quiet", "--prune", origin, *refspec, timeout=120)


def fetch_prefer_ssh(repo: Path, *refspec: str) -> str:
    """Use SSH first for every update, retry HTTPS only when SSH fetch fails."""
    try:
        fetch_from_origin(repo, SSH_ORIGIN, *refspec)
        return "SSH"
    except UpdateError as ssh_error:
        try:
            fetch_from_origin(repo, HTTPS_ORIGIN, *refspec)
            return "HTTPS 回退"
        except UpdateError as https_error:
            raise UpdateError(
                "SSH 与 HTTPS 拉取均失败。SSH: " + str(ssh_error)[:600]
                + "; HTTPS: " + str(https_error)[:600]
            ) from https_error


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


def json_from_github(url: str) -> dict:
    if not url.startswith(API + "/"):
        raise UpdateError("Unexpected GitHub API URL")
    req = urllib.request.Request(
        url, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            if response.geturl() != url:
                raise UpdateError("GitHub API redirect refused")
            return json.loads(response.read(2_000_000))
    except urllib.error.HTTPError as error:
        raise UpdateError("GitHub API returned HTTP {}".format(error.code)) from error


def ci_is_green(sha: str, *, api_fetch=json_from_github) -> tuple[bool, str]:
    if not SHA.fullmatch(sha):
        raise UpdateError("Invalid GitHub commit SHA")
    data = api_fetch(API + "/actions/runs?head_sha=" + sha + "&event=push&per_page=100")
    latest = {}
    for item in data.get("workflow_runs", []):
        name = item.get("name")
        if name in CI_NAMES and name not in latest:
            latest[name] = item
    missing = CI_NAMES - set(latest)
    if missing:
        return False, "GitHub CI 尚未完成：" + ", ".join(sorted(missing))
    bad = [name for name, item in latest.items()
           if item.get("status") != "completed" or item.get("conclusion") != "success"]
    if bad:
        return False, "GitHub CI 未通过：" + ", ".join(sorted(bad))
    return True, ""


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
    if channel not in ("main", "release"):
        raise UpdateError("Unsupported update channel")
    transport = fetch_prefer_ssh(
        repo, "refs/heads/main:refs/remotes/origin/main"
    )
    if channel == "main":
        sha = git(repo, "rev-parse", "refs/remotes/origin/main")
        label = "main · " + sha[:12] + " · " + transport
    else:
        release = json_from_github(API + "/releases/latest")
        tag = release.get("tag_name", "")
        if not isinstance(tag, str) or not TAG.fullmatch(tag):
            raise UpdateError("GitHub release has an unsupported version tag")
        tag_transport = fetch_prefer_ssh(repo, "tag", tag)
        sha = git(repo, "rev-list", "-n", "1", "refs/tags/" + tag)
        label = tag + " · " + tag_transport
    if not SHA.fullmatch(sha):
        raise UpdateError("Invalid Git commit from remote")
    return sha, label


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
    for url in ("http://127.0.0.1:3080/readyz",
                "http://127.0.0.1:3080/api/config"):
        try:
            with urllib.request.urlopen(url, timeout=15) as response:
                if response.status != 200:
                    raise UpdateError("HTTP smoke verification failed: " + url)
                data = response.read(200_000)
                if url.endswith("/api/config") and not isinstance(json.loads(data), dict):
                    raise UpdateError("Startup configuration is not a JSON object")
        except (urllib.error.URLError, ValueError) as error:
            raise UpdateError("HTTP smoke verification failed: " + url + " " +
                              str(error)[:200]) from error
    return ("Post-deploy validation PASSED: git SHA=" + actual[:12]
            + "; container healthy; /readyz HTTP 200; /api/config HTTP 200")


def deploy(repo: Path, old: str, target: str, *, on_progress=None) -> tuple[str, str, str]:
    """Return outcome, log, error. Never remove Docker volumes."""
    log = []
    previous_image_saved = False
    def advance(stage: str, percent: int, detail: str) -> None:
        log.append("[{}] {}% {}".format(stage, percent, detail))
        if on_progress:
            on_progress(stage, percent, detail)
    try:
        # Preserve the exact known-good image before a source build can replace its tag.
        advance("backup", 35, "保存旧版 Docker 镜像")
        run(["docker", "image", "tag", "mv3c:local", "mv3c:rollback"], repo, timeout=30)
        previous_image_saved = True
        advance("merging", 43, "Git 快进到验证通过的提交")
        git(repo, "merge", "--ff-only", target, timeout=60)
        log.append("Git fast-forward: " + old[:12] + " -> " + target[:12])
        advance("building", 50, "正在构建 Docker 镜像；此阶段可能需要数分钟")
        log.append(run(["docker", "compose", "build", "mv3c"], repo, timeout=3600)[-9500:])
        advance("restarting", 75, "正在重新创建 mv3c 服务")
        log.append(run(["docker", "compose", "up", "-d", "--no-deps", "--force-recreate", "mv3c"],
                       repo, timeout=240)[-3000:])
        advance("verifying", 86, "检查 Docker 健康状态")
        wait_healthy(repo)
        advance("verifying", 93, "验证 Git 提交、readyz 和应用配置 API")
        log.append(verify_deployment(repo, target))
        return "success", "\n".join(log)[-24000:], ""
    except Exception as error:
        failure = str(error)[:1600]
        log.append("Deployment failed: " + failure)
        try:
            advance("rollback", 94, "更新失败，开始恢复旧版本")
            git(repo, "reset", "--hard", old, timeout=60)
            if previous_image_saved:
                log.append(run(["docker", "image", "tag", "mv3c:rollback", "mv3c:local"],
                               repo, timeout=30)[-1000:])
            else:
                log.append(run(["docker", "compose", "build", "mv3c"], repo,
                               timeout=3600)[-4000:])
            log.append(run(["docker", "compose", "up", "-d", "--no-deps",
                            "--force-recreate", "mv3c"], repo, timeout=240)[-2000:])
            wait_healthy(repo)
            validation = verify_deployment(repo, old)
            log.append("Rollback validation PASSED: " + validation)
            log.append("Previous application version restored")
            return "rolled_back", "\n".join(log)[-24000:], failure
        except Exception as rollback_error:
            log.append("Rollback failed: " + str(rollback_error)[:1500])
            return "failed", "\n".join(log)[-24000:], failure + "; rollback failed"


def check_needed(state: dict) -> bool:
    checked = state.get("checkedAt")
    requested = state.get("checkRequestedAt")
    # The bridge exposes checkRequestedAt separately from the admin response.
    interval = state.get("config", {}).get("intervalMinutes", 10)
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


def execute(repo: Path) -> None:
    state = bridge(repo, "state")
    if not isinstance(state, dict):
        raise UpdateError("Invalid update state")
    try:
        old = verify_repo(repo)
    except Exception as error:
        report(repo, status="blocked", lastError=str(error)[:1800])
        raise
    report(repo, currentSha=old)
    if not check_needed(state) and not state.get("pendingJob"):
        return

    pending = state.get("pendingJob")
    try:
        target, label = target_for_channel(repo, state["config"]["channel"])
        if not is_descendant(repo, old, target):
            raise UpdateError("Target commit is not a fast-forward descendant of deployed version")
        available = target != old
        good, reason = ci_is_green(target) if available else (True, "")
        report(repo, currentSha=old, latestSha=target, latestLabel=label,
               latestUrl="https://github.com/" + REPO + "/commit/" + target,
               checkedAt=utc_now(), updateAvailable=available,
               **({"status": "blocked", "lastError": reason}
                  if available and not good and not pending
                  else {"status": "idle", "lastError": ""}
                  if not available and not pending else {}))
    except Exception as error:
        message = str(error)[:1800]
        report(repo, checkedAt=utc_now(), lastError=message,
               **({"status": "blocked"} if not pending else {}))
        if pending:
            job = bridge(repo, "claim")
            if job:
                bridge(repo, "complete", {
                    "jobId": job["id"], "outcome": "failed", "error": message,
                    "log": "Unable to resolve or verify GitHub update", "sha": old,
                })
        raise

    if not available:
        if pending:
            job = bridge(repo, "claim")
            if job:
                bridge(repo, "complete", {
                    "jobId": job["id"], "outcome": "skipped",
                    "error": "", "log": "Already running the latest commit", "sha": old,
                })
        return
    if not good:
        if pending:
            job = bridge(repo, "claim")
            if job:
                bridge(repo, "complete", {
                    "jobId": job["id"], "outcome": "failed",
                    "error": reason, "log": "GitHub CI gate blocked deployment", "sha": old,
                })
        return

    if not pending and state["config"]["autoEnabled"]:
        if target == state.get("blockedSha"):
            report(repo, status="blocked",
                   lastError="此提交上次部署失败，已暂停自动重试；可手动重试或等待新的 GitHub 提交")
            return
        bridge(repo, "queue-auto")
    job = bridge(repo, "claim")
    if not job:
        return
    print("Deploying verified commit", target, flush=True)
    outcome, log, error = deploy(repo, old, target)
    bridge(repo, "complete", {
        "jobId": job["id"], "outcome": outcome, "log": log, "error": error,
        "sha": target if outcome == "success" else old,
        "attemptedSha": target,
    })
    print("mv3c update:", outcome, flush=True)


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
