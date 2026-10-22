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
    def test_ci_requires_both_successful_workflows(self):
        def ok(_):
            return {"workflow_runs": [
                {"name": "mv3c validation", "status": "completed", "conclusion": "success"},
                {"name": "mv3c source Docker build", "status": "completed", "conclusion": "success"},
            ]}
        self.assertEqual(agent.ci_is_green(SHA1, api_fetch=ok), (True, ""))

        def missing(_):
            return {"workflow_runs": [
                {"name": "mv3c validation", "status": "completed", "conclusion": "success"}
            ]}
        good, reason = agent.ci_is_green(SHA1, api_fetch=missing)
        self.assertFalse(good)
        self.assertIn("source Docker build", reason)

        def failed(_):
            return {"workflow_runs": [
                {"name": "mv3c validation", "status": "completed", "conclusion": "failure"},
                {"name": "mv3c source Docker build", "status": "completed", "conclusion": "success"},
            ]}
        self.assertFalse(agent.ci_is_green(SHA1, api_fetch=failed)[0])
        self.assertIn("未通过", agent.ci_is_green(SHA1, api_fetch=failed)[1])

        def pending(_):
            return {"workflow_runs": [
                {"name": "mv3c validation", "status": "completed", "conclusion": "success"},
                {"name": "mv3c source Docker build", "status": "in_progress", "conclusion": None},
            ]}
        good, reason = agent.ci_is_green(SHA1, api_fetch=pending)
        self.assertFalse(good)
        self.assertIn("正在运行", reason)
        self.assertNotIn("未通过", reason)

        with self.assertRaises(agent.UpdateError):
            agent.ci_is_green("invalid", api_fetch=ok)

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

    def test_lock_contention_blocks_bootstrap_but_allows_timer_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            for bootstrap, should_fail in ((True, True), (False, False)):
                argv = ["agent.py", "--repo", directory]
                if bootstrap:
                    argv.append("--bootstrap-local")
                with patch.object(agent.sys, "argv", argv), \\
                     patch.object(agent.os, "geteuid", return_value=0), \\
                     patch.object(agent.Path, "open") as open_lock, \\
                     patch.object(agent.fcntl, "flock", side_effect=BlockingIOError):
                    open_lock.return_value.__enter__.return_value.fileno.return_value = 9
                    if should_fail:
                        with self.assertRaisesRegex(agent.UpdateError,
                                                    "Bootstrap was NOT run"):
                            agent.main()
                    else:
                        self.assertEqual(agent.main(), 0)

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

    def test_main_target_uses_only_pinned_origin(self):
        with patch.object(agent, "fetch_prefer_ssh", return_value="HTTPS 回退") as fetch:
            with patch.object(agent, "git", return_value=SHA2):
                sha, label = agent.target_for_channel(pathlib.Path("/tmp"), "main")
        self.assertEqual(sha, SHA2)
        self.assertIn(SHA2[:12], label)
        self.assertIn("HTTPS 回退", label)
        fetch.assert_called_once_with(
            pathlib.Path("/tmp"), "refs/heads/main:refs/remotes/origin/main")
        with self.assertRaises(agent.UpdateError):
            agent.target_for_channel(pathlib.Path("/tmp"), "evil")

    def test_release_tag_is_validated_before_git_fetch(self):
        with patch.object(agent, "json_from_github", return_value={"tag_name": "../../evil"}):
            with patch.object(agent, "fetch_prefer_ssh", return_value="SSH") as fetch:
                with self.assertRaises(agent.UpdateError):
                    agent.target_for_channel(pathlib.Path("/tmp"), "release")
                fetch.assert_called_once_with(
                    pathlib.Path("/tmp"), "refs/heads/main:refs/remotes/origin/main")

    def test_release_tag_fetch_prefers_ssh(self):
        with patch.object(agent, "json_from_github", return_value={"tag_name": "v1.2.3"}):
            with patch.object(agent, "fetch_prefer_ssh", return_value="SSH") as fetch:
                with patch.object(agent, "git", return_value=SHA2):
                    sha, label = agent.target_for_channel(pathlib.Path("/tmp"), "release")
        self.assertEqual(sha, SHA2)
        self.assertEqual(label, "v1.2.3 · SSH")
        self.assertEqual(fetch.call_args_list[1].args[1:], ("tag", "v1.2.3"))

    def test_fetch_prefers_ssh_and_falls_back_to_https(self):
        repo = pathlib.Path("/tmp")
        with patch.object(agent, "fetch_from_origin", return_value=None) as fetch:
            self.assertEqual(agent.fetch_prefer_ssh(repo, "main"), "SSH")
            fetch.assert_called_once_with(repo, agent.SSH_ORIGIN, "main")
        with patch.object(agent, "fetch_from_origin", side_effect=[
            agent.UpdateError("SSH unavailable"), None,
        ]) as fetch:
            self.assertEqual(agent.fetch_prefer_ssh(repo, "main"), "HTTPS 回退")
            self.assertEqual(fetch.call_args_list[0].args[1], agent.SSH_ORIGIN)
            self.assertEqual(fetch.call_args_list[1].args[1], agent.HTTPS_ORIGIN)
        with patch.object(agent, "fetch_from_origin", side_effect=[
            agent.UpdateError("SSH unavailable"), agent.UpdateError("HTTPS unavailable"),
        ]):
            with self.assertRaisesRegex(agent.UpdateError, "SSH 与 HTTPS"):
                agent.fetch_prefer_ssh(repo, "main")

    def test_explicit_fetch_blocks_url_rewrite(self):
        repo = pathlib.Path("/tmp")
        with patch.object(agent, "git", side_effect=[
            agent.SSH_ORIGIN, "",
        ]) as git:
            agent.fetch_from_origin(
                repo, agent.SSH_ORIGIN, "refs/heads/main:refs/remotes/origin/main")
            self.assertEqual(git.call_args_list[0].args[1:],
                             ("ls-remote", "--get-url", agent.SSH_ORIGIN))
            self.assertEqual(git.call_args_list[1].args[1:4],
                             ("fetch", "--quiet", "--prune"))
            self.assertEqual(git.call_args_list[1].args[4], agent.SSH_ORIGIN)
        with patch.object(agent, "git", return_value="https://evil.example/repo.git") as git:
            with self.assertRaisesRegex(agent.UpdateError, "rewrite"):
                agent.fetch_from_origin(repo, agent.SSH_ORIGIN, "main")
            self.assertEqual(git.call_count, 1)

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

    def test_local_build_reuses_docker_layers_and_npm_cache(self):
        commands = []
        def fake_run(args, _repo, **kwargs):
            commands.append((args, kwargs))
            if args[:3] == ["docker", "image", "inspect"]:
                return SHA2
            return "#1 CACHED\\n#2 build successful"
        with patch.object(agent, "run", side_effect=fake_run):
            agent.build_local_image(pathlib.Path("/tmp"), SHA2)
        build, kwargs = commands[0]
        self.assertEqual(build[:3], ["docker", "build", "--progress=plain"])
        self.assertEqual(build[-1], ".")
        self.assertIn("NODE_MAX_OLD_SPACE_SIZE=3072", build)
        self.assertIn("BUILD_COMMIT=" + SHA2, build)
        self.assertIn("NPM_CI_TIMEOUT_SECONDS=1800", build)
        self.assertNotIn("--no-cache", build)
        self.assertNotIn("--pull", build)
        self.assertEqual(kwargs["env"]["DOCKER_BUILDKIT"], "1")
        self.assertEqual(commands[1][0][-1], "mv3c:sha-" + SHA2)
        with patch.dict(agent.os.environ, {"MV3C_BUILD_NODE_HEAP_MB": "evil"}):
            with self.assertRaises(agent.UpdateError):
                agent.build_local_image(pathlib.Path("/tmp"), SHA2)

    def test_local_build_image_revision_mismatch_blocks_switch(self):
        with patch.object(agent, "run", return_value=SHA1):
            with self.assertRaisesRegex(agent.UpdateError, "revision mismatch"):
                agent.verify_built_image(pathlib.Path("/tmp"), SHA2)

    def test_capacity_gate_preserves_host_when_disk_is_low(self):
        from collections import namedtuple
        Usage = namedtuple("Usage", "total used free")
        with patch.object(agent.shutil, "disk_usage", return_value=Usage(10, 9, 1)):
            with self.assertRaisesRegex(agent.UpdateError, "less than 3 GiB"):
                agent.check_build_capacity(pathlib.Path("/tmp"))

    def test_successful_local_build_is_verified_before_container_switch(self):
        commands = []
        phases = []
        def fake_run(args, _repo, **kwargs):
            commands.append(args)
            return "OK"
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            with patch.object(agent, "check_build_capacity"):
                with patch.object(agent, "build_local_image") as build:
                    with patch.object(agent, "run", side_effect=fake_run):
                        with patch.object(agent, "git"):
                            with patch.object(agent, "wait_healthy"):
                                with patch.object(agent, "verify_deployment",
                                                  return_value="Post-deploy validation PASSED"):
                                    result = agent.deploy(repo, SHA1, SHA2,
                                        on_progress=lambda stage, pct, msg:
                                            phases.append((stage, pct, msg)))
            self.assertFalse(agent.transaction_path(repo).exists())
        self.assertEqual((result[0], result[2]), ("success", ""))
        build.assert_called_once_with(repo, SHA2)
        self.assertIn("Cached host Docker build", result[1])
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
                with patch.object(agent, "build_local_image",
                                  side_effect=agent.UpdateError("npm ci failed")):
                    with patch.object(agent, "run", side_effect=fake_run):
                        with patch.object(agent, "git") as git:
                            with patch.object(agent, "wait_healthy"):
                                with patch.object(agent, "verify_deployment",
                                                  return_value="Post-deploy validation PASSED"):
                                    result = agent.deploy(repo, SHA1, SHA2)
            self.assertFalse(agent.transaction_path(repo).exists())
        self.assertEqual(result[0], "rolled_back")
        self.assertIn("npm ci failed", result[2])
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
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, size):
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
                                  return_value=Response()) as check:
                    result = agent.verify_deployment(pathlib.Path("/tmp"), SHA2)
        self.assertIn("Post-deploy validation PASSED", result)
        self.assertEqual(check.call_count, 2)
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

    def test_only_fast_forward_is_allowed(self):
        with patch.object(agent.subprocess, "run") as run:
            run.return_value.returncode = 1
            self.assertFalse(agent.is_descendant(pathlib.Path("/tmp"), SHA1, SHA2))
            run.return_value.returncode = 0
            self.assertTrue(agent.is_descendant(pathlib.Path("/tmp"), SHA1, SHA2))


if __name__ == "__main__":
    unittest.main()
