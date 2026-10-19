"""Pure, network-free tests for the privileged host updater."""
import importlib.util
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

    def test_host_git_commands_enforce_noninteractive_ssh(self):
        with patch.object(agent, "run", return_value="ok") as run:
            self.assertEqual(agent.git(pathlib.Path("/tmp"), "fetch", "origin", "main"), "ok")
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["git", "fetch", "origin", "main"])
        self.assertEqual(kwargs["env"]["GIT_SSH_COMMAND"], agent.SSH_COMMAND)
        self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
        self.assertIn("StrictHostKeyChecking=yes", agent.SSH_COMMAND)
        self.assertIn("BatchMode=yes", agent.SSH_COMMAND)

    def test_ssh_only_origin_validation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            (repo / ".git").mkdir()
            (repo / "docker-compose.yml").touch()
            with patch.object(agent, "git", side_effect=[
                "https://github.com/b8vipvip/mv3c.git", agent.SSH_ORIGIN,
            ]):
                with self.assertRaisesRegex(agent.UpdateError, "SSH"):
                    agent.verify_repo(repo)
            with patch.object(agent, "git", side_effect=[
                agent.SSH_ORIGIN, "https://github.com/b8vipvip/mv3c.git",
            ]):
                with self.assertRaisesRegex(agent.UpdateError, "SSH"):
                    agent.verify_repo(repo)
            with patch.object(agent, "git", side_effect=[
                agent.SSH_ORIGIN, agent.SSH_ORIGIN, "main", "", SHA1,
            ]):
                self.assertEqual(agent.verify_repo(repo), SHA1)

    def test_main_target_uses_only_pinned_origin(self):
        with patch.object(agent, "git", side_effect=[
            "", SHA2,
        ]) as git:
            sha, label = agent.target_for_channel(pathlib.Path("/tmp"), "main")
        self.assertEqual(sha, SHA2)
        self.assertIn(SHA2[:12], label)
        self.assertEqual(git.call_args_list[0].args[1:4], ("fetch", "--quiet", "--prune"))
        with self.assertRaises(agent.UpdateError):
            agent.target_for_channel(pathlib.Path("/tmp"), "evil")

    def test_release_tag_is_validated_before_git_fetch(self):
        with patch.object(agent, "json_from_github", return_value={"tag_name": "../../evil"}):
            with patch.object(agent, "git", return_value="") as git:
                with self.assertRaises(agent.UpdateError):
                    agent.target_for_channel(pathlib.Path("/tmp"), "release")
                self.assertEqual(git.call_count, 1)

    def test_failed_build_restores_previous_image_without_rebuilding(self):
        commands = []

        def fake_run(args, _repo, **_kwargs):
            commands.append(args)
            if args[:3] == ["docker", "compose", "build"]:
                raise agent.UpdateError("Build failed")
            return "OK"

        with patch.object(agent, "run", side_effect=fake_run):
            with patch.object(agent, "git") as git:
                with patch.object(agent, "wait_healthy"):
                    outcome, _log, error = agent.deploy(
                        pathlib.Path("/tmp"), SHA1, SHA2)
        self.assertEqual(outcome, "rolled_back")
        self.assertIn("Build failed", error)
        self.assertTrue(any(c[:4] == ["docker", "image", "tag", "mv3c:rollback"]
                            for c in commands))
        self.assertEqual(sum(c[:3] == ["docker", "compose", "build"]
                             for c in commands), 1)
        self.assertIn("reset", str(git.call_args_list))

    def test_only_fast_forward_is_allowed(self):
        with patch.object(agent.subprocess, "run") as run:
            run.return_value.returncode = 1
            self.assertFalse(agent.is_descendant(pathlib.Path("/tmp"), SHA1, SHA2))
            run.return_value.returncode = 0
            self.assertTrue(agent.is_descendant(pathlib.Path("/tmp"), SHA1, SHA2))


if __name__ == "__main__":
    unittest.main()
