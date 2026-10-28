"""Offline safety regressions for the read-only OCI host readiness report."""
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location(
    "mv3c_oci_host_preflight_test", ROOT / "oci_host_preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

SHA = "a" * 40
VERSION = "v0.1.42"
DIGEST = "sha256:" + "b" * 64


class HostPreflightTests(unittest.TestCase):
    def test_disk_threshold_matches_canonical_updater(self):
        image_size = 1648089712
        requirement = preflight.required_bytes(image_size)
        self.assertGreater(requirement, 6 * 1024**3)
        self.assertFalse(preflight.evaluate_disk(requirement - 1, image_size)["passed"])
        self.assertTrue(preflight.evaluate_disk(requirement, image_size)["passed"])

    def test_invalid_input_rejected_without_probing_host(self):
        with patch.object(preflight, "command") as read:
            with self.assertRaises(ValueError):
                preflight.check(pathlib.Path("/tmp"), "latest", SHA)
            with self.assertRaises(ValueError):
                preflight.check(pathlib.Path("/tmp"), VERSION, "not-sha")
            read.assert_not_called()

    def test_failed_proof_or_low_disk_never_attempts_image_pull(self):
        def fake_command(args, repo, timeout=15):
            self.assertNotIn("pull", args)
            self.assertNotIn("load", args)
            self.assertNotIn("tag", args)
            if args[:2] == ["docker", "info"]:
                return "/tmp"
            raise RuntimeError("No local proof/image staged")

        with (patch.object(preflight, "git", side_effect=ValueError("Missing proof")),
              patch.object(preflight, "command", side_effect=fake_command),
              patch.object(preflight, "inspect_local", side_effect=ValueError("No image")),
              patch.object(preflight.subprocess, "run",
                           return_value=types.SimpleNamespace(stdout="inactive")),
              patch.object(preflight, "urlopen",
                           side_effect=OSError("No live instance"))):
            result = preflight.check(pathlib.Path("/tmp"), VERSION, SHA)
        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["immutable_release_and_registry_proof"])
        self.assertFalse(result["checks"]["docker_filesystem_space"])
        self.assertEqual(result["mode"], "READ_ONLY_NO_PULL")

    def test_bootstrap_stages_all_three_python_modules_from_release(self):
        source = (ROOT / "bootstrap-prebuilt.sh").read_text(encoding="utf8")
        for item in ("agent.py", "prebuilt.py", "oci_registry.py"):
            self.assertIn('git show "$target:mv3c/updater/' + item + '"', source)
        self.assertIn('"$TMP/oci_registry.py"', source)
        self.assertIn('python3 "$TMP/agent.py"', source)

    def test_no_direct_host_image_mutation_path(self):
        source = (ROOT / "oci_host_preflight.py").read_text(encoding="utf8")
        for forbidden in (
            '["docker", "image", "pull"',
            '["docker", "image", "load"',
            '["docker", "image", "tag"',
            '"systemctl", "stop"',
            '"systemctl", "start"',
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
