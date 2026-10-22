import hashlib
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "export_scp_image.sh"
FULL_SHA = "4ff76cee4d3d7633406f743921d5888714c40ea2"


@unittest.skipUnless(shutil.which("ssh-keygen"), "requires OpenSSH")
class ScpHostIdentityPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.private_key = self.root / "key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.private_key)], check=True)
        self.public_key = self.private_key.with_suffix(".pub").read_text().split()[:2]
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        fake_ssh = self.bin_dir / "ssh"
        fake_ssh.write_text("#!/bin/sh\nexit 0\n")
        fake_ssh.chmod(0o755)

    def invoke(self, known_host, port="22"):
        env = os.environ.copy()
        env.update({
            "GITHUB_SHA": FULL_SHA,
            "MV3C_SCP_HOST": "example.test",
            "MV3C_SCP_USER": "mv3c-transfer",
            "MV3C_SCP_PRIVATE_KEY": self.private_key.read_text(),
            "MV3C_SCP_KNOWN_HOSTS": known_host,
            "MV3C_SCP_PORT": port,
            "RUNNER_TEMP": str(self.root),
            "PATH": str(self.bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        })
        return subprocess.run(["bash", str(SCRIPT), "--preflight"],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, timeout=20)

    def key_line(self, host):
        return " ".join([host, *self.public_key])

    def test_wrong_known_hosts_name_fails_before_docker_export(self):
        result = self.invoke(self.key_line("another.example.test"))
        self.assertEqual(result.returncode, 47, result.stderr)
        self.assertIn("known_hosts mismatch", result.stderr)
        self.assertNotIn("Exporting already-tested", result.stdout)

    def test_known_host_at_port_22_passes_preflight_without_export(self):
        result = self.invoke(self.key_line("example.test"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("preflight succeeded", result.stdout)
        self.assertNotIn("Exporting already-tested", result.stdout)

    def test_custom_port_requires_bracketed_host(self):
        wrong = self.invoke(self.key_line("example.test"), "2222")
        self.assertEqual(wrong.returncode, 47, wrong.stderr)
        good = self.invoke(self.key_line("[example.test]:2222"), "2222")
        self.assertEqual(good.returncode, 0, good.stderr)


if __name__ == "__main__":
    unittest.main()
