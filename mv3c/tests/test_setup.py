"""Tests for the secure .env generator."""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mv3c_setup", ROOT / "setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def test_url_validation(self):
        self.assertEqual(setup.validate_url("https://example.com/v1/", endpoint=True),
                         "https://example.com/v1")
        self.assertEqual(setup.validate_url("http://host.docker.internal:8000/v1", endpoint=True),
                         "http://host.docker.internal:8000/v1")
        for url in ("http://public.example/v1", "https://example.com/api", "ftp://example.com/v1",
                    "https://user:password@example.com/v1"):
            with self.assertRaises(ValueError):
                setup.validate_url(url, endpoint=True)

    def test_generate_persistent_secrets_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            original = setup.ROOT
            try:
                setup.ROOT = Path(directory)
                (setup.ROOT / ".env.mv3c.example").write_text(
                    (original / ".env.mv3c.example").read_text(encoding="utf-8"), encoding="utf-8")
                path = setup.initialize("https://api.example.com/v1", "https://mv3c.example.com", "sk-test")
                data = path.read_text(encoding="utf-8")
                self.assertIn("APP_TITLE=mv3c", data)
                self.assertIn("CHAT2API_API_KEY=sk-test", data)
                self.assertIn("DOMAIN_CLIENT=https://mv3c.example.com", data)
                self.assertRegex(data, r"JWT_SECRET=[a-f0-9]{64}")
                self.assertRegex(data, r"CREDS_IV=[a-f0-9]{32}")
                if os.name == "posix":
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    setup.initialize("https://api.example.com/v1", "https://mv3c.example.com", "sk-test")
            finally:
                setup.ROOT = original

    def test_no_multiline_key(self):
        with self.assertRaises(ValueError):
            setup.initialize("https://api.example.com/v1", "https://mv3c.example.com", "key\nINJECT=1")

if __name__ == "__main__":
    unittest.main()
