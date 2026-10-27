"""Validate evidence-only OCI layer audit, without Docker or network."""
import importlib.util
import pathlib
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "layer_audit.py"
spec = importlib.util.spec_from_file_location("mv3c_layer_audit", SOURCE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
A = "sha256:" + "a" * 64
B = "sha256:" + "b" * 64
C = "sha256:" + "c" * 64
D = "sha256:" + "d" * 64


class LayerAuditTests(unittest.TestCase):
    def test_shared_prefix_reports_lower_bound_not_fake_download_size(self):
        result = audit.compare_layers([A, B, C, D], [A, B, D])
        self.assertEqual(result["layers"], 4)
        self.assertEqual(result["shared_base_prefix"], 2)
        self.assertEqual(result["shared_diff_ids"], 3)
        self.assertEqual(result["new_diff_ids"], 1)
        self.assertNotIn("bytes_saved", result)

    def test_uncached_previous_is_unknown_not_zero_bandwidth(self):
        result = audit.compare_layers([A, B], [])
        self.assertFalse(result["previous_available"])
        self.assertEqual(result["shared_base_prefix"], 0)

    def test_unique_previous_field_and_digest_validation(self):
        text = "object deadbeef\n\nMV3C_PREBUILT_IMAGE_V1\nrootfs_diff_ids=" + A + "," + B
        self.assertEqual(audit.previous_proof_diff_ids(text), [A, B])
        self.assertEqual(audit.previous_proof_diff_ids("old proof"), [])
        with self.assertRaises(ValueError):
            audit.previous_proof_diff_ids(text + "\nrootfs_diff_ids=" + A)
        for invalid in ("sha256:xyz", "sha256:" + "z" * 64, "not-digest", ""):
            with self.assertRaises(ValueError):
                audit.validated_layers([invalid])


if __name__ == "__main__":
    unittest.main()
