"""Pure, network-free tests for the privileged host updater."""
import importlib.util
import tempfile
import pathlib
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / "agent.py"
spec = importlib.util.spec_from_file_location("mv3c_host_agent", PATH)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
SHA1 = "a" * 40
SHA2 = "b" * 40


class HostUpdaterTests(unittest.TestCase):
    def test_only_canonical_updater_entrypoints_remain(self):
        root = pathlib.Path(__file__).resolve().parents[3]
        self.assertFalse((root / "mv3c/updater/migrate-git-only.sh").exists())
        self.assertFalse((root / "config/deployed-update.js").exists())
        self.assertFalse((root / "config/update.js").exists())
        installer = (root / "mv3c/updater/install.sh").read_text()
        self.assertIn("CONFLICTING_UNITS", installer)
        self.assertIn("mv3c-updater.service", installer)
        self.assertIn("mv3c-updater.timer", installer)
        self.assertIn("systemctl is-active --quiet mv3c-updater.service", installer)
        self.assertIn("Unexpected MV3C updater service drop-ins", installer)
        self.assertIn("systemctl disable --now mv3c-updater.timer", installer)
        script = (root / "mv3c/updater/agent.py").read_text()
        self.assertNotIn("--bootstrap-local", script)
        self.assertNotIn("reconcile_verified_bootstrap", script)

    def test_docker_build_error_report_keeps_original_npm_error(self):
        class Failed:
            returncode = 1

        def failed_build(_args, **kwargs):
            stream = kwargs["stdout"]
            stream.write(b"#20 10.1 npm ERR! EAI_AGAIN registry.npmjs.org\n")
            stream.write(b"#20 10.2 npm error network fetch failed\n")
            for number in range(40):
                stream.write(f"#20 11.{number} Some ordinary progress output\n".encode())
            stream.write(b"ERROR: failed to solve: process did not complete\n")
            return Failed()

        with tempfile.TemporaryDirectory() as folder:
            with (
                patch.object(agent, "BUILD_LOG_PATH", pathlib.Path(folder) / "build.log"),
                patch.object(agent.subprocess, "run", side_effect=failed_build),
            ):
                with self.assertRaises(agent.UpdateError) as caught:
                    agent.run_docker_build(["docker", "build", "."], pathlib.Path(folder),
                                           timeout=20, env=None)
            self.assertIn("npm ERR! EAI_AGAIN", str(caught.exception))
            self.assertIn("First root-cause candidates", str(caught.exception))

    def test_proof_tag_requires_exact_version_sha_and_ci_results(self):
        repo = pathlib.Path("/tmp")
        body = (
            "object " + SHA2 + "\n"
            "type commit\n"
            "tag mv3c-verified/v0.1.8\n"
            "tagger github-actions <bot@example.invalid> 1700000000 +0000\n\n"
            "MV3C_OFFICIAL_RELEASE_PROOF_V1\n"
            "release=v0.1.8\n"
            "sha=" + SHA2 + "\n"
            "validation_id=1234\n"
            "docker_id=5678\n"
            "validation=success\n"
            "docker=success\n"
            "published=success\n"
        )
        with patch.object(agent, "git", side_effect=["tag", SHA2, body]):
            agent.verify_release_proof(repo, "v0.1.8", SHA2)
        for wrong in (
            body.replace("docker=success", "docker=failure"),
            body.replace("release=v0.1.8", "release=v0.1.9"),
            body.replace("validation_id=1234", "validation_id=bad"),
            body.replace("published=success", "published=false"),
        ):
            with patch.object(agent, "git", side_effect=["tag", SHA2, wrong]):
                with self.assertRaises(agent.UpdateError):
                    agent.verify_release_proof(repo, "v0.1.8", SHA2)
        with patch.object(agent, "git", side_effect=["commit", SHA2, body]):
            with self.assertRaisesRegex(agent.UpdateError, "not an annotated"):
                agent.verify_release_proof(repo, "v0.1.8", SHA2)
        with patch.object(agent, "git", side_effect=agent.UpdateError("missing")):
            with self.assertRaisesRegex(agent.UpdateError, "Missing release CI proof"):
                agent.verify_release_proof(repo, "v0.1.8", SHA2)

    def test_release_workflow_creates_proof_after_actual_release_and_both_ci(self):
        workflow = (pathlib.Path(__file__).resolve().parents[3] /
                    ".github/workflows/mv3c-release.yml").read_text()
        self.assertIn("gh release create", workflow)
        self.assertIn('git tag -a "$proof"', workflow)
        self.assertIn('git push origin "refs/tags/$proof"', workflow)
        self.assertLess(workflow.index("gh release create"),
                        workflow.index('git tag -a "$proof"'))
        self.assertIn("validation_run_id=", workflow)
        self.assertIn("docker_run_id=", workflow)

    def test_resource_sampling_and_buildkit_timing_diagnostics(self):
        summary = agent.build_pressure_summary([
            {"mem_available_mib": 2000, "swap_used_mib": 100, "io_full_avg10": 5.3,
             "docker_free_gib": 5.5},
            {"mem_available_mib": 780, "swap_used_mib": 440, "io_full_avg10": 29.1,
             "docker_free_gib": 3.2},
        ])
        self.assertIn("780.00 MiB minimum", summary)
        self.assertIn("29.10 % peak", summary)
        self.assertIn("3.20 GiB minimum", summary)
        steps = agent.buildkit_summary({"23": "runtime exporting", "5": "npm ci"},
                                       {"23": 106.5, "5": 57.8}, 7)
        self.assertLess(steps.index("106.5s"), steps.index("57.8s"))
        self.assertIn("7 cached step(s)", steps)

    def test_unattended_auto_check_disabled_is_not_repeated(self):
        now = agent.utc_now()
        self.assertFalse(agent.check_needed({
            "checkedAt": now, "config": {"autoEnabled": False},
        }))
        self.assertFalse(agent.check_needed({
            "checkedAt": now, "config": {"autoEnabled": False},
            "checkRequestedAt": "2020-01-01T00:00:00Z",
        }))

    def test_requested_check_and_periodic_check(self):
        now = agent.utc_now()
        self.assertTrue(agent.check_needed({"config": {"intervalMinutes": 10}}))
        self.assertFalse(agent.check_needed({
            "checkedAt": now, "config": {"intervalMinutes": 10},
        }))
        self.assertTrue(agent.check_needed({
            "checkedAt": "2020-01-01T00:00:00+00:00",
            "config": {"intervalMinutes": 10},
        }))
        self.assertTrue(agent.check_needed({
            "checkedAt": "2020-01-01T00:00:00+00:00",
            "checkRequestedAt": now, "config": {"intervalMinutes": 60},
        }))

    def test_single_host_update_owner_and_no_bootstrap_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(agent.sys, "argv", ["agent.py", "--repo", directory]),
                patch.object(agent.os, "geteuid", return_value=0),
                patch.object(agent.Path, "open") as open_lock,
                patch.object(agent.fcntl, "flock", side_effect=BlockingIOError),
            ):
                open_lock.return_value.__enter__.return_value.fileno.return_value = 9
                self.assertEqual(agent.main(), 0)
            with patch.object(agent.sys, "argv",
                              ["agent.py", "--repo", directory, "--bootstrap-local"]):
                with self.assertRaises(SystemExit):
                    agent.main()

    def test_legacy_unversioned_rollback_accepts_only_original_healthy_image(self):
        repo = pathlib.Path("/tmp")
        old_image = "sha256:original-backup"
        def fake_run(args, _repo, **_kwargs):
            joined = " ".join(args)
            if args[:4] == ["docker", "compose", "ps", "-q"]:
                return "mv3c-container"
            if args[:3] == ["docker", "image", "inspect"]:
                if "{{.Id}}" in joined:
                    return old_image
                if "org.opencontainers.image.version" in joined:
                    return "unreleased"
                if "org.opencontainers.image.revision" in joined:
                    return ""
            if args[:2] == ["docker", "inspect"]:
                if "{{.Image}}" in joined:
                    return old_image
                return "healthy"
            raise AssertionError(args)
        class Response:
            status = 200
            def __init__(self, url):
                self.url = url
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self, _size):
                if self.url.endswith("/version"):
                    return b'{"version":"v0.1.5","sha":""}'
                return b'{}'
        with (
            patch.object(agent, "verify_deployment",
                         side_effect=agent.UpdateError("Docker image Release version mismatch")),
            patch.object(agent, "git", return_value=SHA1),
            patch.object(agent, "version_for_sha", return_value="v0.1.5"),
            patch.object(agent, "run", side_effect=fake_run),
            patch.object(agent.urllib.request, "urlopen",
                         side_effect=lambda url, timeout: Response(url)),
        ):
            result = agent.verify_restored_service(repo, SHA1)
        self.assertIn("Rollback recovery PASSED", result)
        self.assertIn("NOT a new deployment", result)

    def test_legacy_exception_never_admits_different_image_or_real_wrong_version(self):
        repo = pathlib.Path("/tmp")
        def bad_run(args, _repo, **_kwargs):
            joined = " ".join(args)
            if args[:4] == ["docker", "compose", "ps", "-q"]:
                return "container"
            if args[:3] == ["docker", "image", "inspect"] and "{{.Id}}" in joined:
                return "sha256:backup"
            if args[:2] == ["docker", "inspect"]:
                return "sha256:different" if "{{.Image}}" in joined else "healthy"
            return "unreleased"
        with (
            patch.object(agent, "verify_deployment",
                         side_effect=agent.UpdateError("Docker image Release version mismatch")),
            patch.object(agent, "git", return_value=SHA1),
            patch.object(agent, "run", side_effect=bad_run),
        ):
            with self.assertRaisesRegex(agent.UpdateError, "backed-up healthy"):
                agent.verify_restored_service(repo, SHA1)
        # A non-version-related verification failure must never be reclassified.
        with patch.object(agent, "verify_deployment",
                          side_effect=agent.UpdateError("Running container image does not match")):
            with self.assertRaisesRegex(agent.UpdateError, "does not match"):
                agent.verify_restored_service(repo, SHA1)

    def test_host_git_commands_enforce_noninteractive_ssh(self):
        with patch.object(agent, "run", return_value="ok") as run:
            self.assertEqual(agent.git(pathlib.Path("/tmp"), "fetch", "origin", "main"), "ok")
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["git", "fetch", "origin", "main"])
        self.assertEqual(kwargs["env"]["GIT_SSH_COMMAND"], agent.SSH_COMMAND)
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertIn("StrictHostKeyChecking=yes", agent.SSH_COMMAND)
        self.assertIn("BatchMode=yes", agent.SSH_COMMAND)

    def test_trusted_ssh_and_https_origin_validation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            (repo / ".git").mkdir()
            (repo / "docker-compose.yml").touch()
            for origin in (agent.SSH_ORIGIN, agent.HTTPS_ORIGIN):
                with patch.object(agent, "git", side_effect=[
                    origin, origin, "main", "", SHA1,
                ]):
                    self.assertEqual(agent.verify_repo(repo), SHA1)
            with patch.object(agent, "git", side_effect=[
                "https://evil.example/repo.git", agent.SSH_ORIGIN,
            ]):
                with self.assertRaisesRegex(agent.UpdateError, "固定"):
                    agent.verify_repo(repo)
            with patch.object(agent, "git", side_effect=[
                agent.SSH_ORIGIN, "https://evil.example/repo.git",
            ]):
                with self.assertRaisesRegex(agent.UpdateError, "固定"):
                    agent.verify_repo(repo)

    def test_unpublished_main_branch_cannot_be_deployed(self):
        with self.assertRaisesRegex(agent.UpdateError, "Only published"):
            agent.target_for_channel(pathlib.Path("/tmp"), "main")
        with self.assertRaises(agent.UpdateError):
            agent.target_for_channel(pathlib.Path("/tmp"), "evil")

    def test_release_lookup_accepts_only_git_proven_tags_on_main(self):
        repo = pathlib.Path("/tmp")
        with (
            patch.object(agent, "fetch_prefer_ssh", return_value="ssh-443") as fetch,
            patch.object(agent, "list_release_tags", return_value=["v0.1.6", "v0.1.8"]),
            patch.object(agent, "git", side_effect=[SHA2, SHA2]),
            patch.object(agent, "verify_release_proof") as proof,
            patch.object(agent, "is_descendant", return_value=True),
        ):
            self.assertEqual(agent.target_for_channel(repo, "release"), (SHA2, "v0.1.8"))
            fetch.assert_called_once_with(repo, *agent.GIT_REFSPECS)
            proof.assert_called_once_with(repo, "v0.1.8", SHA2)
        with patch.object(agent, "fetch_prefer_ssh"):
            with patch.object(agent, "list_release_tags", return_value=["v0.1.8"]):
                with patch.object(agent, "git", side_effect=[SHA2, SHA2]):
                    with patch.object(agent, "verify_release_proof",
                                      side_effect=agent.UpdateError("missing proof")):
                        with self.assertRaisesRegex(agent.UpdateError, "missing proof"):
                            agent.target_for_channel(repo, "release")
        with patch.object(agent, "fetch_prefer_ssh"):
            with patch.object(agent, "list_release_tags", return_value=["v0.1.8"]):
                with patch.object(agent, "git", side_effect=[SHA2, SHA2]):
                    with patch.object(agent, "verify_release_proof"):
                        with patch.object(agent, "is_descendant", return_value=False):
                            with self.assertRaisesRegex(agent.UpdateError, "trusted main"):
                                agent.target_for_channel(repo, "release")

    def test_pinned_release_proof_and_main_ancestry_are_mandatory(self):
        repo = pathlib.Path("/tmp")
        with (
            patch.object(agent, "fetch_prefer_ssh", return_value="ssh-443"),
            patch.object(agent, "list_release_tags",
                         return_value=["v0.1.22", "v0.1.23"]),
            patch.object(agent, "git", side_effect=[SHA1, SHA2]),
            patch.object(agent, "verify_release_proof") as proof,
            patch.object(agent, "is_descendant", return_value=True),
        ):
            self.assertEqual(agent.target_for_channel(
                repo, "release", "v0.1.22"), (SHA1, "v0.1.22"))
            proof.assert_called_once_with(repo, "v0.1.22", SHA1)
        with patch.object(agent, "fetch_prefer_ssh"), (
            patch.object(agent, "list_release_tags",
                         return_value=["v0.1.23"])
        ):
            with self.assertRaisesRegex(agent.UpdateError, "no fetched official tag"):
                agent.target_for_channel(repo, "release", "v0.1.22")
        for unsafe in ("v0.1.22-rc", "../tag", "main", "", "v0.1.23;rm"):
            with self.assertRaisesRegex(agent.UpdateError, "Invalid requested"):
                agent.target_for_channel(repo, "release", unsafe)
        with (
            patch.object(agent, "fetch_prefer_ssh"),
            patch.object(agent, "list_release_tags",
                         return_value=["v0.1.22"]),
            patch.object(agent, "git", side_effect=[SHA1, SHA2]),
            patch.object(agent, "verify_release_proof",
                         side_effect=agent.UpdateError("CI proof invalid")),
        ):
            with self.assertRaisesRegex(agent.UpdateError, "CI proof invalid"):
                agent.target_for_channel(repo, "release", "v0.1.22")

    def test_cached_only_missing_candidate_never_builds_or_cleans(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = pathlib.Path(folder)
            with (
                patch.object(agent, "verified_existing_candidate", return_value=None),
                patch.object(agent, "check_build_capacity") as gate,
                patch.object(agent, "cleanup_stale_mv3c_image_tags") as clean,
                patch.object(agent, "build_local_image") as build,
                patch.object(agent, "run") as docker,
                patch.object(agent, "git") as git,
            ):
                status, report, error = agent.deploy(
                    repo, SHA1, SHA2, reuse_only=True)
            self.assertEqual(status, "failed")
            self.assertIn("reuse-only", error)
            self.assertIn("live container, Git and image unchanged", report)
            for mock in (gate, clean, build, docker, git):
                mock.assert_not_called()

    def test_cached_only_valid_candidate_skips_build_and_preserves_other_tags(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = pathlib.Path(folder)
            with (
                patch.object(agent, "verified_existing_candidate",
                             return_value="sha256:" + "a" * 64),
                patch.object(agent, "disk_free_bytes", return_value=int(2.5 * 1024**3)),
                patch.object(agent, "cleanup_stale_mv3c_image_tags") as clean,
                patch.object(agent, "check_build_capacity") as gate,
                patch.object(agent, "build_local_image") as build,
                patch.object(agent, "run", return_value="ok"),
                patch.object(agent, "git"),
                patch.object(agent, "wait_healthy"),
                patch.object(agent, "verify_deployment",
                             return_value="Post-deploy validation PASSED"),
            ):
                status, report, error = agent.deploy(repo, SHA1, SHA2, reuse_only=True)
            self.assertEqual((status, error), ("success", ""))
            self.assertIn("skipped redundant Docker build", report)
            clean.assert_not_called()
            gate.assert_not_called()
            build.assert_not_called()

    def test_latest_release_without_proof_never_falls_back_to_older_version(self):
        with (
            patch.object(agent, "fetch_prefer_ssh"),
            patch.object(agent, "list_release_tags", return_value=["v0.1.6", "v0.1.8"]),
            patch.object(agent, "git", side_effect=[SHA2]),
            patch.object(agent, "verify_release_proof",
                         side_effect=agent.UpdateError("CI proof missing")),
        ):
            with self.assertRaisesRegex(agent.UpdateError, "CI proof missing"):
                agent.target_for_channel(pathlib.Path("/tmp"), "release")

    def test_release_tag_is_strict_and_unpublished_main_rejected(self):
        with self.assertRaisesRegex(agent.UpdateError, "Only published"):
            agent.target_for_channel(pathlib.Path("/tmp"), "main")
        with patch.object(agent, "fetch_prefer_ssh"):
            with patch.object(agent, "list_release_tags", return_value=[]):
                with self.assertRaisesRegex(agent.UpdateError, "No Git-published"):
                    agent.target_for_channel(pathlib.Path("/tmp"), "release")
        self.assertEqual(agent.version_key("v0.1.8"), (0, 1, 8))
        for value in ("v0.1.8-rc1", "v0.1", "../../evil", "latest"):
            with self.assertRaises(agent.UpdateError):
                agent.version_key(value)

    def test_version_for_sha_uses_fetched_release_refs_and_legacy_fallback(self):
        with patch.object(agent, "list_release_tags", return_value=["v0.1.8"]):
            with patch.object(agent, "git", return_value=SHA2):
                self.assertEqual(agent.version_for_sha(pathlib.Path("/tmp"), SHA2), "v0.1.8")
        with patch.object(agent, "list_release_tags", return_value=[]):
            with patch.object(agent, "git", return_value="v0.1.5\nother\n"):
                self.assertEqual(agent.version_for_sha(pathlib.Path("/tmp"), SHA2), "v0.1.5")

    def test_fetch_prefers_ssh_443_then_22_then_https_with_hard_timeouts(self):
        repo = pathlib.Path("/tmp")
        with patch.object(agent, "prepare_github_known_hosts"):
            with patch.object(agent, "fetch_from_origin", return_value=None) as fetch:
                self.assertEqual(agent.fetch_prefer_ssh(repo, "main"), "ssh-443")
                fetch.assert_called_once_with(
                    repo, agent.SSH_ORIGIN, "main", transport="ssh-443")
            with patch.object(agent, "fetch_from_origin", side_effect=[
                agent.UpdateError("443 unreachable"), None,
            ]) as fetch:
                self.assertEqual(agent.fetch_prefer_ssh(repo, "main"), "ssh-22")
                self.assertEqual(fetch.call_args_list[1].kwargs["transport"], "ssh-22")
            with patch.object(agent, "fetch_from_origin", side_effect=[
                agent.UpdateError("443 unreachable"), agent.UpdateError("22 unreachable"),
                None,
            ]) as fetch:
                self.assertEqual(agent.fetch_prefer_ssh(repo, "main"), "https")
                self.assertEqual(fetch.call_args_list[2].kwargs["transport"], "https")
            with patch.object(agent, "fetch_from_origin",
                              side_effect=agent.UpdateError("unreachable")):
                with patch.object(agent.time, "sleep"):
                    with self.assertRaisesRegex(agent.UpdateError, "all failed"):
                        agent.fetch_prefer_ssh(repo, "main")

    def test_fetch_rejects_git_url_rewrites_and_stays_bounded(self):
        repo = pathlib.Path("/tmp")
        for transport, origin in (("ssh-443", agent.SSH_ORIGIN),
                                  ("ssh-22", agent.SSH_ORIGIN),
                                  ("https", agent.HTTPS_ORIGIN)):
            with patch.object(agent, "git", side_effect=[origin, ""]) as git:
                agent.fetch_from_origin(repo, origin, "refs/heads/main:refs/remotes/origin/main",
                                        transport=transport)
            self.assertEqual(git.call_args_list[0].args[1:],
                             ("ls-remote", "--get-url", origin))
            fetch_call = git.call_args_list[1]
            self.assertEqual(fetch_call.kwargs["timeout"], 35)
            self.assertIn("--no-tags", fetch_call.args)
            self.assertIn("--prune", fetch_call.args)
            if transport == "ssh-443":
                self.assertIn("Port=443", fetch_call.kwargs["ssh_command"])
            elif transport == "ssh-22":
                self.assertIn("HostKeyAlias=github.com", fetch_call.kwargs["ssh_command"])
            else:
                self.assertIn("http.version=HTTP/1.1", fetch_call.args)
        with patch.object(agent, "git", return_value="https://evil.example/repo.git"):
            with self.assertRaisesRegex(agent.UpdateError, "rewrite"):
                agent.fetch_from_origin(repo, agent.SSH_ORIGIN, "main")
        with self.assertRaisesRegex(agent.UpdateError, "Invalid transport"):
            with patch.object(agent, "git", return_value=agent.SSH_ORIGIN):
                agent.fetch_from_origin(repo, agent.SSH_ORIGIN, "main", transport="https")

    def test_git_timeout_becomes_fallback_eligible_error(self):
        with patch.object(agent.subprocess, "run",
                          side_effect=agent.subprocess.TimeoutExpired(["git"], 5)):
            with self.assertRaisesRegex(agent.UpdateError, "timed out"):
                agent.run(["git", "fetch"], pathlib.Path("/tmp"), timeout=5)

    def test_image_reference_requires_full_immutable_sha(self):
        self.assertEqual(agent.image_for_sha(SHA2), "mv3c:sha-" + SHA2)
        with self.assertRaises(agent.UpdateError):
            agent.image_for_sha("latest")
        with self.assertRaises(agent.UpdateError):
            agent.image_for_sha("abcd")

    def test_failed_build_log_keeps_first_registry_error(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp:
            logfile = pathlib.Path(temp) / "build.log"
            def fake_build(_args, **kwargs):
                stream = kwargs["stdout"]
                stream.write(b"#10 ERROR: failed to fetch image: network timeout\\n")
                for index in range(80):
                    stream.write(("#10 downloading layer %s\\n" % index).encode())
                return SimpleNamespace(returncode=1)
            with patch.object(agent, "BUILD_LOG_PATH", logfile):
                with patch.object(agent.subprocess, "run", side_effect=fake_build):
                    with self.assertRaises(agent.UpdateError) as caught:
                        agent.run(["docker", "build", "-t", "mv3c:sha-" + SHA2, "."],
                                  pathlib.Path(temp), timeout=30)
            error = str(caught.exception)
            self.assertIn("failed to fetch image: network timeout", error)
            self.assertIn(str(logfile), error)
            self.assertIn("downloading layer 79", logfile.read_text())
            self.assertEqual(logfile.stat().st_mode & 0o777, 0o600)

    def test_runtime_python_index_is_project_scoped_and_configurable(self):
        compose = (pathlib.Path(__file__).resolve().parents[3] /
                   "docker-compose.yml").read_text(encoding="utf-8")
        expected = "${MV3C_PYPI_INDEX_URL:-https://pypi.org/simple}"
        self.assertIn("UV_DEFAULT_INDEX: " + expected, compose)
        self.assertIn("PIP_INDEX_URL: " + expected, compose)
        self.assertNotIn("UV_EXTRA_INDEX_URL:", compose)
        self.assertNotIn("PIP_EXTRA_INDEX_URL:", compose)
        smoke = (pathlib.Path(__file__).resolve().parents[3] /
                 "docker-compose.mv3c.yml").read_text(encoding="utf-8")
        self.assertIn("UV_DEFAULT_INDEX: " + expected, smoke)
        self.assertIn("PIP_INDEX_URL: " + expected, smoke)

    def test_dockerfile_keeps_build_dependencies_out_of_runtime_layers(self):
        dockerfile = (pathlib.Path(__file__).resolve().parents[3] /
                      "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("FROM node:24.16.0-alpine AS base", dockerfile)
        self.assertIn("FROM base AS build", dockerfile)
        self.assertIn("FROM base AS runtime", dockerfile)
        self.assertIn("COPY --from=prod-deps --chown=node:node", dockerfile)
        self.assertIn("tar -C /mv3c-built --exclude=node_modules", dockerfile)
        build_stage = dockerfile.split("FROM base AS build", 1)[1].split(
            "FROM base AS runtime", 1)[0]
        runtime_stage = dockerfile.split("FROM base AS runtime", 1)[1]
        self.assertIn("npm ci --no-audit --prefer-offline", build_stage)
        self.assertIn("npm run frontend", build_stage)
        self.assertNotIn("npm prune --omit=dev --prefer-offline", build_stage)
        self.assertIn("FROM base AS prod-deps", build_stage)
        self.assertIn("npm ci --omit=dev --no-audit", build_stage)
        self.assertNotIn("npm ci ", runtime_stage)
        self.assertIn('CMD ["node", "api/server/index.js"]', runtime_stage)
        self.assertIn("org.opencontainers.image.revision", runtime_stage)

    def test_dockerfile_avoids_unbounded_alpine_upgrade_and_has_signed_mirrors(self):
        dockerfile = (pathlib.Path(__file__).resolve().parents[3] /
                      "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("RUN apk upgrade", dockerfile)
        self.assertNotIn("--force-missing-repositories", dockerfile)
        self.assertIn("if timeout 120 apk add --no-cache jemalloc python3 py3-pip uv",
                      dockerfile)
        self.assertIn("https://mirrors.aliyun.com/alpine", dockerfile)
        self.assertIn("https://mirrors.tuna.tsinghua.edu.cn/alpine", dockerfile)
        self.assertIn("https://dl-cdn.alpinelinux.org/alpine", dockerfile)
        self.assertIn(r"main\n%s/%s/community\n", dockerfile)
        self.assertIn('> /etc/apk/repositories;', dockerfile)
        self.assertIn('if [ "$installed" != 1 ]; then', dockerfile)
        self.assertIn("RUN uv --version && uvx --version", dockerfile)

    def test_cache_report_is_monitor_only_and_parses_docker_units(self):
        self.assertEqual(agent.parse_docker_size("4.204GB"), 4204000000)
        self.assertEqual(agent.parse_docker_size("453MiB"), 453 * 1024 ** 2)
        with self.assertRaises(ValueError):
            agent.parse_docker_size("7 widgets")
        with patch.object(agent, "run", return_value='{"Type":"Build Cache","Size":"4.204GB"}') as runner:
            self.assertEqual(agent.build_cache_usage(pathlib.Path("/tmp")), 4204000000)
        self.assertEqual(runner.call_args.args[0][:3], ["docker", "system", "df"])
        self.assertFalse(any("prune" in word for word in runner.call_args.args[0]))

    def test_preflight_fails_closed_before_docker_mutation(self):
        # Must refuse an expensive local build while retaining enough reserve
        # for a healthy MongoDB/API and for the new image to be switched.
        with patch.object(agent, "disk_free_bytes", return_value=7 * 1024 ** 3 - 1):
            with patch.object(agent, "run") as runner:
                with self.assertRaisesRegex(agent.UpdateError, "7GiB required"):
                    agent.check_build_capacity(pathlib.Path("/tmp"))
                runner.assert_not_called()

    def test_preflight_accepts_exactly_seven_gib_and_warns_on_cache(self):
        with (
            patch.object(agent, "disk_free_bytes", return_value=7 * 1024 ** 3),
            patch.object(agent, "build_cache_usage", return_value=5 * 1024 ** 3),
            patch("builtins.print") as logger,
        ):
            agent.check_build_capacity(pathlib.Path("/tmp"))
            self.assertIn("minimum before NEW build: 7GiB", logger.call_args.args[0])
            self.assertIn("shared cache over soft limit", logger.call_args.args[0])

    def test_post_build_reserve_prevents_container_switch(self):
        calls = []
        def command(args, _repo, **_kwargs):
            calls.append(args)
            return "OK"
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            with (
                patch.object(agent, "check_build_capacity"),
                patch.object(agent, "disk_free_bytes", return_value=1024**3),
                patch.object(agent, "build_local_image"),
                patch.object(agent, "verified_existing_candidate",
                             side_effect=[None, "sha256:" + "a" * 64]),
                patch.object(agent, "run", side_effect=command),
                patch.object(agent, "git"),
                patch.object(agent, "wait_healthy") as wait_healthy,
                patch.object(agent, "verify_deployment", return_value="PASSED"),
            ):
                result = agent.deploy(repo, SHA1, SHA2)
        self.assertEqual(result[0], "failed")
        self.assertIn("less than 2GiB", result[2])
        self.assertIn("no Docker restart attempted", result[1])
        self.assertFalse(any(c[:3] == ["docker", "compose", "up"] for c in calls))
        wait_healthy.assert_not_called()

    def test_cached_verified_image_skips_build_only_three_gib_requirement(self):
        """A verified Release candidate can deploy with >=2GiB but <3GiB free."""
        calls = []
        def command(args, _repo, **_kwargs):
            calls.append(args)
            return "OK"
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            with (
                patch.object(agent, "check_build_capacity") as build_gate,
                patch.object(agent, "disk_free_bytes", return_value=int(2.5 * 1024**3)),
                patch.object(agent, "verified_existing_candidate",
                             return_value="sha256:" + "a" * 64),
                patch.object(agent, "build_local_image") as build,
                patch.object(agent, "run", side_effect=command),
                patch.object(agent, "git"),
                patch.object(agent, "wait_healthy"),
                patch.object(agent, "verify_deployment",
                             return_value="Post-deploy validation PASSED"),
            ):
                result = agent.deploy(repo, SHA1, SHA2)
            self.assertFalse(agent.transaction_path(repo).exists())
        self.assertEqual(result[0], "success")
        self.assertIn("skip 3GiB build-only preflight", result[1])
        build_gate.assert_not_called()
        build.assert_not_called()
        self.assertEqual(len([x for x in calls if x[:3] ==
                              ["docker", "compose", "up"]]), 1)

    def test_cached_candidate_below_two_gib_does_not_touch_live_or_git(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            with (
                patch.object(agent, "disk_free_bytes", return_value=1024**3),
                patch.object(agent, "verified_existing_candidate",
                             return_value="sha256:" + "a" * 64),
                patch.object(agent, "check_build_capacity") as gate,
                patch.object(agent, "build_local_image") as build,
                patch.object(agent, "run") as runner,
                patch.object(agent, "git") as git,
            ):
                outcome, message, error = agent.deploy(repo, SHA1, SHA2)
        self.assertEqual(outcome, "failed")
        self.assertIn("less than 2GiB", error)
        self.assertIn("Preflight failed", message)
        gate.assert_not_called()
        build.assert_not_called()
        runner.assert_not_called()
        git.assert_not_called()

    def test_project_scoped_sha_image_cleanup_preserves_live_and_rollback(self):
        stale = "c" * 40
        active_id = "sha256:current"
        rollback_id = "sha256:rollback"
        old_id = "sha256:stale"
        actions = []
        def command(args, _repo, **_kwargs):
            actions.append(args)
            if args[:3] == ["docker", "image", "inspect"] and "--format" in args:
                return active_id if args[-1] == "mv3c:local" else rollback_id
            if args[:3] == ["docker", "ps", "-aq"]:
                return "running-container\n"
            if args[:3] == ["docker", "inspect", "--format"]:
                return active_id
            if args[:3] == ["docker", "image", "ls"]:
                return ("mv3c:sha-" + SHA2 + "\n" +
                        "mv3c:sha-" + SHA1 + "\n" +
                        "mv3c:sha-" + stale + "\n" +
                        "some-other-project:sha-" + stale)
            if args[:3] == ["docker", "image", "inspect"]:
                tag = args[-1]
                sha = tag.removeprefix("mv3c:sha-")
                ident = {SHA1: rollback_id, SHA2: active_id, stale: old_id}[sha]
                return agent.json.dumps([{
                    "Id": ident, "Created": "2026-10-20T08:00:00Z",
                    "Config": {"Labels": {"org.opencontainers.image.revision": sha}},
                }])
            if args[:3] == ["docker", "image", "rm"]:
                return "Untagged"
            raise AssertionError(args)
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(agent, "run", side_effect=command):
                removed = agent.cleanup_stale_mv3c_image_tags(pathlib.Path(directory))
        self.assertEqual(removed, ["mv3c:sha-" + stale])
        self.assertEqual([a for a in actions if a[:3] == ["docker", "image", "rm"]],
                         [["docker", "image", "rm", "mv3c:sha-" + stale]])
        self.assertFalse(any("prune" in arg for a in actions for arg in a))


    def test_candidate_missing_preflight_reclaims_only_stale_mv3c_tags(self):
        """Preflight cleanup is run before the stricter build gate only if target absent."""
        stages = []
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            with (
                patch.object(agent, "verified_existing_candidate", return_value=None),
                patch.object(agent, "cleanup_stale_mv3c_image_tags",
                             return_value=["mv3c:sha-" + "c" * 40]) as maintenance,
                patch.object(agent, "check_build_capacity",
                             side_effect=agent.UpdateError("at least 7GiB required")) as gate,
                patch.object(agent, "run") as docker,
                patch.object(agent, "git") as git,
            ):
                state, report, error = agent.deploy(repo, SHA1, SHA2)
        self.assertEqual(state, "failed")
        self.assertIn("Pre-build MV3C stale SHA tags removed: 1", report)
        self.assertIn("7GiB", error)
        maintenance.assert_called_once_with(repo)
        gate.assert_called_once_with(repo)
        docker.assert_not_called()
        git.assert_not_called()

    def test_candidate_reuse_never_runs_image_cleanup_or_build_gate(self):
        """A verified 2.5GiB-space candidate remains usable without mutations during preflight."""
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            with (
                patch.object(agent, "verified_existing_candidate",
                             return_value="sha256:" + "a" * 64),
                patch.object(agent, "disk_free_bytes",
                             return_value=int(2.5 * 1024**3)),
                patch.object(agent, "cleanup_stale_mv3c_image_tags") as maintenance,
                patch.object(agent, "check_build_capacity") as gate,
                patch.object(agent, "run", return_value="ok"),
                patch.object(agent, "git"),
                patch.object(agent, "wait_healthy"),
                patch.object(agent, "verify_deployment",
                             return_value="Post-deploy validation PASSED"),
            ):
                outcome, _log, error = agent.deploy(repo, SHA1, SHA2)
        self.assertEqual((outcome, error), ("success", ""))
        maintenance.assert_called_once()
        # It is called exactly once *after* the transaction was completed.
        gate.assert_not_called()

    def test_pending_transaction_blocks_image_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            agent.save_transaction(repo, SHA1, SHA2)
            with patch.object(agent, "run") as command:
                with self.assertRaisesRegex(agent.UpdateError, "journal exists"):
                    agent.cleanup_stale_mv3c_image_tags(repo)
                command.assert_not_called()

    def test_local_build_reuses_docker_layers_and_npm_cache(self):
        commands = []
        def fake_run(args, _repo, **kwargs):
            commands.append((args, kwargs))
            if args[:3] == ["docker", "image", "inspect"]:
                return SHA2
            return "#1 CACHED\\n#2 build successful"
        with patch.object(agent, "run", side_effect=fake_run), (
            patch.object(agent, "meminfo_kib", return_value={"MemAvailable": 10 * 1024**2})
        ):
            with patch.object(agent, "git", return_value="v1.2.3"):
                agent.build_local_image(pathlib.Path("/tmp"), SHA2)
        build, kwargs = commands[0]
        self.assertEqual(build[:3], ["docker", "build", "--progress=plain"])
        self.assertEqual(build[-1], ".")
        self.assertIn("NODE_MAX_OLD_SPACE_SIZE=2560", build)
        self.assertIn("BUILD_COMMIT=" + SHA2, build)
        self.assertIn("BUILD_VERSION=v1.2.3", build)
        self.assertIn("NPM_CI_TIMEOUT_SECONDS=1800", build)
        self.assertNotIn("--no-cache", build)
        self.assertNotIn("--pull", build)
        self.assertEqual(kwargs["env"]["DOCKER_BUILDKIT"], "1")
        self.assertEqual(commands[1][0][-1], "mv3c:sha-" + SHA2)
        with patch.dict(agent.os.environ, {"MV3C_BUILD_NODE_HEAP_MB": "evil"}):
            with self.assertRaises(agent.UpdateError):
                agent.build_local_image(pathlib.Path("/tmp"), SHA2)


    def test_build_heap_reserves_memory_for_live_mongo_and_api(self):
        repo = pathlib.Path("/tmp")
        with (
            patch.object(agent, "meminfo_kib",
                         return_value={"MemAvailable": 1700 * 1024}),
            patch.object(agent, "run") as run,
        ):
            with self.assertRaisesRegex(agent.UpdateError,
                                        "protecting live MongoDB and API"):
                agent.build_local_image(repo, SHA2)
            run.assert_not_called()
        captures = []
        def fake_run(args, _repo, **_kwargs):
            captures.append(args)
            return "OK"
        with (
            patch.object(agent, "meminfo_kib",
                         return_value={"MemAvailable": 3000 * 1024}),
            patch.object(agent, "run", side_effect=fake_run),
            patch.object(agent, "version_for_sha", return_value="v0.1.21"),
            patch.object(agent, "verify_built_image"),
        ):
            agent.build_local_image(repo, SHA2)
        self.assertIn("NODE_MAX_OLD_SPACE_SIZE=1976", captures[0])
        self.assertIn("BUILD_COMMIT=" + SHA2, captures[0])

    def test_local_build_image_revision_mismatch_blocks_switch(self):
        with patch.object(agent, "run", return_value=SHA1):
            with self.assertRaisesRegex(agent.UpdateError, "revision mismatch"):
                agent.verify_built_image(pathlib.Path("/tmp"), SHA2)

    def test_exact_release_image_is_reusable_only_with_matching_metadata(self):
        repo = pathlib.Path("/tmp")
        valid = {
            "Id": "sha256:" + "a" * 64,
            "Config": {
                "Labels": {
                    "org.opencontainers.image.revision": SHA2,
                    "org.opencontainers.image.version": "v0.1.11",
                    "org.opencontainers.image.source": "https://github.com/b8vipvip/mv3c",
                },
                "Env": ["BUILD_COMMIT=" + SHA2, "MV3C_VERSION=v0.1.11"],
            },
            "RootFS": {"Layers": ["sha256:" + "b" * 64]},
        }
        with (
            patch.object(agent, "run", return_value=agent.json.dumps(valid)) as command,
            patch.object(agent, "version_for_sha", return_value="v0.1.11"),
        ):
            self.assertEqual(agent.verified_existing_candidate(repo, SHA2),
                             "sha256:" + "a" * 64)
            self.assertEqual(command.call_args.args[0][-1], agent.image_for_sha(SHA2))
        for change in (
            ("org.opencontainers.image.revision", SHA1),
            ("org.opencontainers.image.version", "unreleased"),
            ("org.opencontainers.image.source", "https://evil.example"),
        ):
            altered = agent.json.loads(agent.json.dumps(valid))
            altered["Config"]["Labels"][change[0]] = change[1]
            with (
                patch.object(agent, "run", return_value=agent.json.dumps(altered)),
                patch.object(agent, "version_for_sha", return_value="v0.1.11"),
            ):
                with self.assertRaisesRegex(agent.UpdateError, "refusing reuse"):
                    agent.verified_existing_candidate(repo, SHA2)
        altered = agent.json.loads(agent.json.dumps(valid))
        altered["Config"]["Env"] = ["BUILD_COMMIT=" + SHA1]
        with (
            patch.object(agent, "run", return_value=agent.json.dumps(altered)),
            patch.object(agent, "version_for_sha", return_value="v0.1.11"),
        ):
            with self.assertRaisesRegex(agent.UpdateError, "refusing reuse"):
                agent.verified_existing_candidate(repo, SHA2)

    def test_missing_candidate_rebuilds_but_daemon_failure_is_not_hidden(self):
        repo = pathlib.Path("/tmp")
        with patch.object(agent, "run",
                          side_effect=agent.UpdateError("No such image: mv3c:sha-" + SHA2)):
            self.assertIsNone(agent.verified_existing_candidate(repo, SHA2))
        with patch.object(agent, "run",
                          side_effect=agent.UpdateError("Cannot connect to Docker daemon")):
            with self.assertRaisesRegex(agent.UpdateError, "Cannot connect"):
                agent.verified_existing_candidate(repo, SHA2)

    def test_verified_candidate_skips_second_docker_build_and_switches(self):
        commands = []
        def fake_run(args, _repo, **_kwargs):
            commands.append(args)
            return "OK"
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            with (
                patch.object(agent, "check_build_capacity"),
                patch.object(agent, "disk_free_bytes", return_value=3 * 1024**3),
                patch.object(agent, "verified_existing_candidate",
                             return_value="sha256:" + "a" * 64),
                patch.object(agent, "build_local_image") as build,
                patch.object(agent, "run", side_effect=fake_run),
                patch.object(agent, "git"),
                patch.object(agent, "wait_healthy"),
                patch.object(agent, "verify_deployment",
                             return_value="Post-deploy validation PASSED"),
            ):
                result = agent.deploy(repo, SHA1, SHA2)
            self.assertFalse(agent.transaction_path(repo).exists())
        self.assertEqual(result[0], "success")
        self.assertIn("skipped redundant Docker build", result[1])
        build.assert_not_called()
        self.assertTrue(any(x[:3] == ["docker", "compose", "up"] for x in commands))

    def test_capacity_gate_preserves_host_when_disk_is_low(self):
        from collections import namedtuple
        Usage = namedtuple("Usage", "total used free")
        with patch.object(agent.shutil, "disk_usage", return_value=Usage(10, 9, 1)):
            with self.assertRaisesRegex(agent.UpdateError, "at least 7GiB required"):
                agent.check_build_capacity(pathlib.Path("/tmp"))

    def test_successful_local_build_is_verified_before_container_switch(self):
        commands = []
        phases = []
        def fake_run(args, _repo, **kwargs):
            commands.append(args)
            return "OK"
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            with patch.object(agent, "check_build_capacity"), patch.object(
                agent, "disk_free_bytes", return_value=40 * 1024 ** 3
            ):
                with (
                    patch.object(agent, "build_local_image") as build,
                    patch.object(agent, "verified_existing_candidate",
                                 side_effect=[None, None, "sha256:" + "a" * 64]),
                    patch.object(agent, "run", side_effect=fake_run),
                    patch.object(agent, "git"),
                    patch.object(agent, "wait_healthy"),
                    patch.object(agent, "verify_deployment",
                                 return_value="Post-deploy validation PASSED"),
                ):
                    result = agent.deploy(repo, SHA1, SHA2,
                        on_progress=lambda stage, pct, msg:
                            phases.append((stage, pct, msg)))
            self.assertFalse(agent.transaction_path(repo).exists())
        self.assertEqual((result[0], result[2]), ("success", ""))
        build.assert_called_once_with(repo, SHA2)
        self.assertIn("New Docker build image verified", result[1])
        self.assertIn("building", [step[0] for step in phases])
        self.assertEqual(len([cmd for cmd in commands if cmd[:3] ==
                              ["docker", "compose", "up"]]), 1)
        self.assertTrue(any(cmd[:3] == ["docker", "image", "tag"] and
                            "mv3c:rollback" in cmd for cmd in commands))
        self.assertFalse(any("--build" in cmd for cmd in commands))

    def test_failed_build_keeps_running_container_and_rolls_back_git(self):
        commands = []
        def fake_run(args, _repo, **kwargs):
            commands.append(args)
            return "OK"
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            with patch.object(agent, "check_build_capacity"):
                with (
                    patch.object(agent, "verified_existing_candidate",
                                 return_value=None),
                    patch.object(agent, "build_local_image",
                                 side_effect=agent.UpdateError("npm ci failed")),
                    patch.object(agent, "run", side_effect=fake_run),
                    patch.object(agent, "git") as git,
                    patch.object(agent, "wait_healthy"),
                    patch.object(agent, "verify_deployment",
                                 return_value="Post-deploy validation PASSED"),
                ):
                    result = agent.deploy(repo, SHA1, SHA2)
            self.assertFalse(agent.transaction_path(repo).exists())
        self.assertEqual(result[0], "failed")
        self.assertIn("npm ci failed", result[2])
        self.assertIn("original running image and container were never changed", result[1])
        self.assertFalse(any(cmd[:3] == ["docker", "compose", "up"]
                             for cmd in commands),
                         "Build failure must not interrupt live application")
        self.assertTrue(any(x.args[1:3] == ("reset", "--hard")
                            for x in git.call_args_list))

    def test_interrupted_transaction_restores_verified_old_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            agent.save_transaction(repo, SHA1, SHA2)
            def fake_run(args, _repo, **kwargs):
                if args[:3] == ["docker", "compose", "ps"]:
                    return "container-1"
                if args[:2] == ["docker", "inspect"]:
                    if "Health.Status" in " ".join(args):
                        return "healthy"
                    return "sha256:old-image"
                if args[:3] == ["docker", "image", "inspect"]:
                    return "sha256:old-image"
                return ""
            with patch.object(agent, "git", return_value=SHA2):
                with patch.object(agent, "run", side_effect=fake_run) as run:
                    with patch.object(agent, "wait_healthy"):
                        with patch.object(agent, "verify_deployment", return_value="PASSED"):
                            msg = agent.restore_interrupted_local_deploy(repo)
            self.assertIn("restored", msg)
            self.assertFalse(agent.transaction_path(repo).exists())
            self.assertFalse(any(x.args[0][:3] == ["docker", "compose", "up"]
                                 for x in run.call_args_list))

    def test_post_deploy_checks_sha_container_and_http(self):
        class Response:
            status = 200
            def __init__(self, url):
                self.url = url
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, size):
                if self.url.endswith("/version"):
                    return ('{"sha":"' + SHA2 + '","version":"unreleased"}').encode()
                return b'{"appTitle":"mv3c"}'
        def fake_run(args, _repo, **_kwargs):
            if args[:4] == ["docker", "compose", "ps", "-q"]:
                return "container-id"
            if args[:2] == ["docker", "inspect"]:
                return "sha256:running-image" if "{{.Image}}" in args else "healthy"
            if args[:3] == ["docker", "image", "inspect"]:
                return "sha256:running-image"
            raise AssertionError(args)
        with patch.object(agent, "git", return_value=SHA2):
            with patch.object(agent, "run", side_effect=fake_run):
                with patch.object(agent.urllib.request, "urlopen",
                                  side_effect=lambda url, timeout: Response(url)) as check:
                    result = agent.verify_deployment(pathlib.Path("/tmp"), SHA2)
        self.assertIn("Post-deploy validation PASSED", result)
        self.assertEqual(check.call_count, 3)
        with patch.object(agent, "git", return_value=SHA1):
            with self.assertRaisesRegex(agent.UpdateError, "SHA mismatch"):
                agent.verify_deployment(pathlib.Path("/tmp"), SHA2)

    def test_interrupted_job_is_reconciled_with_validation(self):
        active = {
            "id": "22222222-2222-4222-8222-222222222222",
            "fromSha": SHA1, "targetSha": SHA2,
            "progress": {"stage": "verifying", "percent": 93},
        }
        with patch.object(agent, "verify_deployment", return_value="verified"):
            with patch.object(agent, "bridge", return_value=True) as bridge:
                agent.recover_interrupted_job(pathlib.Path("/tmp"), active, SHA2)
        self.assertEqual(bridge.call_args_list[-1].args[1], "complete")
        self.assertEqual(bridge.call_args_list[-1].args[2]["outcome"], "success")
        with patch.object(agent, "verify_deployment", return_value="verified"):
            with patch.object(agent, "bridge", return_value=True) as bridge:
                agent.recover_interrupted_job(pathlib.Path("/tmp"), active, SHA1)
        self.assertEqual(bridge.call_args_list[-1].args[2]["outcome"], "failed")
        # A global latest SHA is not evidence that this particular interrupted
        # job reached its target; jobs without a pinned target cannot succeed.
        without_target = {"id": active["id"], "fromSha": SHA1}
        with patch.object(agent, "verify_deployment", return_value="verified"):
            with patch.object(agent, "bridge", return_value=True) as bridge:
                agent.recover_interrupted_job(pathlib.Path("/tmp"), without_target, SHA1)
        self.assertEqual(bridge.call_args_list[-1].args[2]["outcome"], "failed")
        not_restarted = dict(active)
        not_restarted["progress"] = {"stage": "building", "percent": 50}
        with patch.object(agent, "verify_deployment", return_value="verified"):
            with patch.object(agent, "bridge", return_value=True) as bridge:
                agent.recover_interrupted_job(pathlib.Path("/tmp"), not_restarted, SHA2)
        self.assertEqual(bridge.call_args_list[-1].args[2]["outcome"], "failed")


    def test_build_recorder_has_durable_sha_bound_evidence_without_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "build-state.json"
            with patch.object(agent, "BUILD_STATE_PATH", path):
                agent.write_build_state({
                    "targetSha": SHA2, "startUtc": "2026-10-25T10:15:24+00:00",
                    "state": "running", "minAvailableMemMiB": 180.0,
                    "resourceWarning": "Critically low host available memory while building",
                })
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                evidence = agent.read_build_state(SHA2)
                self.assertIn("minAvailableMemMiB", evidence)
                self.assertIn("180.0", evidence)
                self.assertNotIn(SHA2, evidence)  # report binds without repeating SHA
                self.assertIn("no matching SHA snapshot", agent.read_build_state(SHA1))

    def test_interrupted_job_includes_only_matching_host_build_evidence(self):
        active = {
            "id": "22222222-2222-4222-8222-222222222222",
            "fromSha": SHA1, "targetSha": SHA2,
            "progress": {"stage": "building", "percent": 54},
        }
        with (
            patch.object(agent, "verify_deployment", return_value="old healthy"),
            patch.object(agent, "read_build_state", return_value="memory-low") as evidence,
            patch.object(agent, "bridge", return_value=True) as bridge,
        ):
            agent.recover_interrupted_job(pathlib.Path("/tmp"), active, SHA1)
        evidence.assert_called_once_with(SHA2)
        completion = bridge.call_args_list[-1].args[2]
        self.assertEqual(completion["outcome"], "failed")
        self.assertIn("memory-low", completion["verification"])
        self.assertIn("memory-low", completion["log"])
        self.assertEqual(completion["sha"], SHA1)

    def test_deployment_rejects_running_image_mismatch(self):
        def fake_run(args, _repo, **_kwargs):
            if args[:4] == ["docker", "compose", "ps", "-q"]:
                return "container-id"
            if args[:2] == ["docker", "inspect"]:
                return "sha256:old" if "{{.Image}}" in args else "healthy"
            if args[:3] == ["docker", "image", "inspect"]:
                return "sha256:new"
            raise AssertionError(args)
        with patch.object(agent, "git", return_value=SHA2):
            with patch.object(agent, "run", side_effect=fake_run):
                with self.assertRaisesRegex(agent.UpdateError, "image does not match"):
                    agent.verify_deployment(pathlib.Path("/tmp"), SHA2)

    def test_prebuilt_cached_image_must_match_official_image_id(self):
        import sys
        import types
        repo = pathlib.Path("/tmp")
        proof = types.ModuleType("prebuilt")
        proof.verified_image_proof = lambda *_args: {
            "image_id": "sha256:" + "c" * 64
        }
        proof.verified_local_candidate_id = lambda *_args: False
        with (
            patch.dict(sys.modules, {"prebuilt": proof}),
            patch.object(agent, "version_for_sha", return_value="v0.1.25"),
            patch.object(agent, "verified_existing_candidate",
                         return_value="sha256:" + "d" * 64),
            patch.object(agent, "run") as docker,
            patch.object(agent, "build_local_image") as build,
            patch.object(agent, "cleanup_stale_mv3c_image_tags") as cleanup,
        ):
            outcome, detail, error = agent.deploy(
                repo, SHA1, SHA2, prebuilt_only=True)
        self.assertEqual(outcome, "failed")
        self.assertIn("official prebuilt image proof", error)
        docker.assert_not_called()
        build.assert_not_called()
        cleanup.assert_not_called()

    def test_prebuilt_candidate_disappearing_must_not_fall_back_to_build(self):
        import sys
        import types
        proof = types.ModuleType("prebuilt")
        accepted = "sha256:" + "c" * 64
        proof.verified_image_proof = lambda *_args: {"image_id": accepted}
        proof.verified_local_candidate_id = lambda *_args: True
        with tempfile.TemporaryDirectory() as folder:
            repo = pathlib.Path(folder)
            with (
                patch.dict(sys.modules, {"prebuilt": proof}),
                patch.object(agent, "version_for_sha", return_value="v0.1.25"),
                patch.object(agent, "verified_existing_candidate",
                             side_effect=[accepted, None]),
                patch.object(agent, "disk_free_bytes", return_value=4 * 1024**3),
                patch.object(agent, "run", return_value="tagged"),
                patch.object(agent, "git", return_value="ok"),
                patch.object(agent, "build_local_image") as build,
                patch.object(agent, "cleanup_stale_mv3c_image_tags") as cleanup,
            ):
                outcome, detail, error = agent.deploy(
                    repo, SHA1, SHA2, prebuilt_only=True)
        self.assertEqual(outcome, "failed")
        self.assertIn("refusing local Docker build", error)
        build.assert_not_called()
        cleanup.assert_not_called()

    def test_only_fast_forward_is_allowed(self):
        with patch.object(agent.subprocess, "run") as run:
            run.return_value.returncode = 1
            self.assertFalse(agent.is_descendant(pathlib.Path("/tmp"), SHA1, SHA2))
            run.return_value.returncode = 0
            self.assertTrue(agent.is_descendant(pathlib.Path("/tmp"), SHA1, SHA2))


if __name__ == "__main__":
    unittest.main()
