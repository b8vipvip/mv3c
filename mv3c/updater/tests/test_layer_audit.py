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

    def test_duplicate_empty_diffid_is_counted_in_each_matching_position(self):
        # Production actual result: 10 positions, six equal; the same empty
        # diffID appears twice, so only five UNIQUE shared digests exist.
        repeated = "sha256:" + "6" * 64
        old = [A, B, C, D, "sha256:" + "e" * 64, repeated,
               "sha256:" + "f" * 64, repeated,
               "sha256:" + "0" * 64, "sha256:" + "1" * 64]
        new = [A, B, C, D, "sha256:" + "2" * 64, repeated,
               "sha256:" + "3" * 64, repeated,
               "sha256:" + "4" * 64, "sha256:" + "5" * 64]
        result = audit.compare_layers(new, old)
        self.assertEqual(result["identical_positions"], [1, 2, 3, 4, 6, 8])
        self.assertEqual(result["different_positions"], [5, 7, 9, 10])
        self.assertEqual(result["identical_position_count"], 6)
        self.assertEqual(result["shared_diff_ids"], 5)

    def test_dependency_fingerprint_is_measurable_only_for_known_layout(self):
        ordered = [A, B, C, D, A, B, C, D, A, B]
        self.assertEqual(audit.dependency_layer_fingerprint(ordered), A)
        self.assertIsNone(audit.dependency_layer_fingerprint([A, B, C, D]))
        self.assertIsNone(audit.dependency_layer_fingerprint(ordered, 8))

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
