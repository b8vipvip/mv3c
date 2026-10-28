"""Offline tests for resumable GHCR blob staging (no network/Docker calls)."""
import hashlib
import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "mv3c_oci_proxy_blob_test", ROOT / "oci_proxy_blob.py")
blob = importlib.util.module_from_spec(spec)
spec.loader.exec_module(blob)

PROXY = "socks5h://127.0.0.1:11808"
PAYLOAD = b"protected GHCR blob content for offline tests"
DIGEST = "sha256:" + hashlib.sha256(PAYLOAD).hexdigest()


class ResumableBlobTests(unittest.TestCase):
    def test_invalid_digest_proxy_or_size_never_touch_disk(self):
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root) / "stage"
            for digest, size, proxy in (
                ("sha256:latest", len(PAYLOAD), PROXY),
                (DIGEST, 0, PROXY),
                (DIGEST, len(PAYLOAD), "socks5h://remote.example:11808"),
                (DIGEST, len(PAYLOAD), "https://admin:secret@localhost:11808"),
            ):
                with self.assertRaises(blob.BlobTransferError):
                    blob.stage_blob(stage, digest, size, proxy=proxy)
                self.assertFalse(stage.exists())

    def test_valid_immutable_blob_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            original = stage / DIGEST.removeprefix("sha256:")
            original.write_bytes(PAYLOAD)
            with patch.object(blob.subprocess, "run") as run:
                result = blob.stage_blob(
                    stage, DIGEST, len(PAYLOAD), proxy=PROXY)
            self.assertEqual(result, original)
            run.assert_not_called()

    def test_interrupted_transfer_resumes_and_hashes_before_promotion(self):
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            stage.joinpath(DIGEST.removeprefix("sha256:") + ".part").write_bytes(
                PAYLOAD[:5])
            observed = []
            calls = []

            def fake_run(args, **kwargs):
                calls.append((args, kwargs))
                if "ghcr.io/token?" in args[-1]:
                    return types.SimpleNamespace(
                        returncode=0, stdout='{"token":"PRIVATE.TOKEN"}')
                self.assertNotIn("PRIVATE.TOKEN", " ".join(args))
                self.assertIn("PRIVATE.TOKEN", kwargs["input"])
                self.assertEqual(kwargs["env"]["HTTPS_PROXY"], PROXY)
                output = pathlib.Path(args[args.index("--output") + 1])
                # Simulate a broken connection, then a clean resumed Range.
                if len([c for c in calls if "--output" in c[0]]) == 1:
                    with output.open("ab") as f:
                        f.write(PAYLOAD[5:15])
                    return types.SimpleNamespace(returncode=18, stdout="")
                with output.open("ab") as f:
                    f.write(PAYLOAD[15:])
                return types.SimpleNamespace(returncode=0, stdout="")

            with patch.object(blob.subprocess, "run", side_effect=fake_run):
                result = blob.stage_blob(
                    stage, DIGEST, len(PAYLOAD), proxy=PROXY,
                    progress=observed.append)
            self.assertEqual(result.read_bytes(), PAYLOAD)
            self.assertFalse(
                stage.joinpath(DIGEST.removeprefix("sha256:") + ".part").exists())
            self.assertEqual(len(observed), 2)
            self.assertEqual(observed[-1]["durable_bytes"], len(PAYLOAD))
            self.assertNotIn("PRIVATE.TOKEN", str(observed))
            self.assertTrue(all("--continue-at" in args
                                for args, _ in calls if "--output" in args))

    def test_digest_mismatch_never_publishes_candidate(self):
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)

            def fake_run(args, **kwargs):
                if "ghcr.io/token?" in args[-1]:
                    return types.SimpleNamespace(
                        returncode=0, stdout='{"token":"PRIVATE.TOKEN"}')
                pathlib.Path(args[args.index("--output") + 1]).write_bytes(
                    b"x" * len(PAYLOAD))
                return types.SimpleNamespace(returncode=0, stdout="")

            with patch.object(blob.subprocess, "run", side_effect=fake_run):
                with self.assertRaisesRegex(
                        blob.BlobTransferError, "SHA256 mismatch"):
                    blob.stage_blob(stage, DIGEST, len(PAYLOAD), proxy=PROXY)
            self.assertFalse((stage / DIGEST.removeprefix("sha256:")).exists())
            self.assertTrue(
                (stage / (DIGEST.removeprefix("sha256:") + ".part")).exists())

    def test_stalled_transfer_stops_without_cleaning_partial(self):
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                if "ghcr.io/token?" in args[-1]:
                    return types.SimpleNamespace(
                        returncode=0, stdout='{"token":"PRIVATE.TOKEN"}')
                return types.SimpleNamespace(returncode=28, stdout="")

            with patch.object(blob.subprocess, "run", side_effect=fake_run):
                with self.assertRaisesRegex(
                        blob.BlobTransferError, "forward progress"):
                    blob.stage_blob(stage, DIGEST, len(PAYLOAD), proxy=PROXY)
            self.assertEqual(len(calls), 4)  # token + 3 attempts
            self.assertFalse((stage / DIGEST.removeprefix("sha256:")).exists())

    def test_disk_reserve_fails_before_network(self):
        with tempfile.TemporaryDirectory() as root:
            with (patch.object(blob.shutil, "disk_usage",
                               return_value=types.SimpleNamespace(free=0)),
                  patch.object(blob.subprocess, "run") as run):
                with self.assertRaisesRegex(blob.BlobTransferError, "disk reserve"):
                    blob.stage_blob(
                        pathlib.Path(root), DIGEST, len(PAYLOAD), proxy=PROXY)
                run.assert_not_called()

    def test_stage_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            p = pathlib.Path(root)
            (p / "link").symlink_to(p, target_is_directory=True)
            with self.assertRaisesRegex(blob.BlobTransferError, "symbolic link"):
                blob.stage_blob(p / "link", DIGEST, len(PAYLOAD), proxy=PROXY)

    def test_existing_corrupt_immutable_blob_not_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            p = pathlib.Path(root)
            (p / DIGEST.removeprefix("sha256:")).write_bytes(
                b"x" * len(PAYLOAD))
            with patch.object(blob.subprocess, "run") as run:
                with self.assertRaisesRegex(blob.BlobTransferError, "wrong size or SHA256"):
                    blob.stage_blob(p, DIGEST, len(PAYLOAD), proxy=PROXY)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
