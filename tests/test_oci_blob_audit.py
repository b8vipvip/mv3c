"""Unit tests for compressed OCI manifest accounting (no registry required)."""
import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[1] / "mv3c/updater/oci_blob_audit.py"
spec = importlib.util.spec_from_file_location("oci_blob_audit", MODULE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def item(n, size):
    return {"digest": "sha256:" + f"{n:064x}", "size": size}


class OciBlobAuditTests(unittest.TestCase):
    def test_exact_compressed_digest_reuse(self):
        previous = {"layers": [item(1, 100), item(2, 250)]}
        current = {"layers": [item(1, 100), item(3, 90)]}
        result = audit.compare(current, previous)
        self.assertEqual(result["compressed_total_bytes"], 190)
        self.assertEqual(result["compressed_reusable_bytes"], 100)
        self.assertEqual(result["compressed_new_bytes"], 90)
        self.assertEqual(result["same_position_digests"], [1])

    def test_no_previous_manifest_is_unknown_not_zero_savings(self):
        result = audit.compare({"layers": [item(1, 60)]})
        self.assertIsNone(result["compressed_reusable_bytes"])
        self.assertIsNone(result["compressed_new_bytes"])

    def test_reordered_blobs_remain_reusable(self):
        previous = {"layers": [item(1, 100), item(2, 200)]}
        current = {"layers": [item(2, 200), item(1, 100)]}
        result = audit.compare(current, previous)
        self.assertEqual(result["compressed_reusable_bytes"], 300)
        self.assertEqual(result["same_position_digests"], [])

    def test_bad_digest_or_size_rejected(self):
        with self.assertRaises(ValueError):
            audit.compare({"layers": [{"digest": "sha256:bad", "size": 9}]})
        with self.assertRaises(ValueError):
            audit.compare({"layers": [item(1, -1)]})


if __name__ == "__main__":
    unittest.main()
