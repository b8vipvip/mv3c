"""Regression tests for mv3c branding and icon generation."""
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mv3c_brand", ROOT / "apply_branding.py")
brand = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand)

class BrandingTests(unittest.TestCase):
    def test_png_dimensions(self):
        for size in (16, 32, 180):
            data = brand.icon_png(size)
            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(struct.unpack(">II", data[16:24]), (size, size))

    def test_literal_replacement_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sample.txt").write_text("Hello LibreChat", encoding="utf-8")
            for _ in range(2):
                brand.replace_literal(root, "sample.txt", "Hello LibreChat", "Hello mv3c")
            self.assertEqual((root / "sample.txt").read_text(), "Hello mv3c")

    def test_upstream_anchor_change_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sample.txt").write_text("Unexpected", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                brand.replace_literal(root, "sample.txt", "LibreChat", "mv3c")

    def test_database_managed_endpoint_contract(self):
        core = (ROOT.parent / "mv3c/settingsCore.cjs").read_text(encoding="utf-8")
        self.assertIn("prompt_mode: 'full'", core)
        self.assertIn("useResponsesApi: false", core)
        self.assertIn("fetch: provider.fetchModels", core)
        self.assertIn("titleConvo: false", core)
        self.assertIn("decryptSecret(doc.chat2api.apiKeyCipher", core)
        compose = (ROOT.parent / "docker-compose.mv3c.yml").read_text(encoding="utf-8")
        self.assertNotIn("env_file:", compose)
        self.assertIn("mv3c/entrypoint.sh", compose)

if __name__ == "__main__":
    unittest.main()
