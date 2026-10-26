"""Prebuilt release evidence checks: no Docker or network access required."""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / "prebuilt.py"
spec = importlib.util.spec_from_file_location("mv3c_prebuilt", PATH)
prebuilt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prebuilt)
SHA = "b" * 40
VERSION = "v0.1.25"
ARCHIVE = "a" * 64
IMAGE = "sha256:" + "c" * 64


def proof(**changes):
    fields = {
        "release": VERSION,
        "sha": SHA,
        "archive_sha256": ARCHIVE,
        "archive_size": "2048",
        "image_id": IMAGE,
        "image_size": "4096",
        "build_run_id": "123456",
    }
    fields.update(changes)
    return ("object " + SHA + "\n" +
            "type commit\ntag mv3c-image/" + VERSION + "\n" +
            "tagger actions <bot@example.invalid> 1700000000 +0000\n\n" +
            "MV3C_PREBUILT_IMAGE_V1\n" +
            "".join(f"{key}={value}\n" for key, value in fields.items()))


class PrebuiltTests(unittest.TestCase):
    def test_filename_is_sha_and_release_scoped(self):
        self.assertEqual(prebuilt.filename(VERSION, SHA),
                         "mv3c-" + VERSION + "-" + SHA + ".tar.gz")
        for unsafe in ("../v1", "v0.1.25-rc", "v1.0.0/evil", "", "latest"):
            with self.assertRaises(prebuilt.PrebuiltError):
                prebuilt.filename(unsafe, SHA)

    def test_annotated_proof_must_bind_release_and_archive(self):
        def good(_repo, command, *args):
            if command == "cat-file" and args[0] == "-t":
                return "tag"
            if command == "rev-parse":
                return SHA
            return proof()
        values = prebuilt.verified_image_proof(pathlib.Path("/tmp"),
                                              VERSION, SHA, good)
        self.assertEqual(values["archive_sha256"], ARCHIVE)
        for data in (proof(archive_sha256="short"), proof(image_id="wrong"),
                     proof(sha="d"*40), proof(build_run_id="0"),
                     proof(image_size="0"), proof(release="v9.9.9"),
                     proof(archive_size="9999999999999999999999999999")):
            def wrong(_repo, command, *args):
                if command == "cat-file" and args[0] == "-t":
                    return "tag"
                if command == "rev-parse":
                    return SHA
                return data
            with self.assertRaises(prebuilt.PrebuiltError):
                prebuilt.verified_image_proof(pathlib.Path("/tmp"),
                                              VERSION, SHA, wrong)

    def test_invalid_proof_blocks_all_docker_commands(self):
        with (patch.object(prebuilt, "_quarantine") as quarantine,
              patch.object(prebuilt.subprocess, "run") as docker):
            with self.assertRaises(prebuilt.PrebuiltError):
                prebuilt.import_prebuilt(pathlib.Path("/tmp"), SHA, VERSION,
                                        lambda *args: "missing", lambda _: 10**10)
            quarantine.assert_not_called()
            docker.assert_not_called()

    def test_quarantine_refuses_symlink_and_wrong_size(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            incoming = root / "incoming"
            incoming.mkdir()
            target = incoming / prebuilt.filename(VERSION, SHA)
            target.symlink_to(root / "missing")
            with (patch.object(prebuilt, "INCOMING", incoming),
                  patch.object(prebuilt, "VERIFIED", root / "verified"),
                  patch.object(prebuilt, "_root_only_directory")):
                with self.assertRaises(prebuilt.PrebuiltError):
                    prebuilt._quarantine(VERSION, SHA, {"archive_size": "2048"})

    def test_small_disk_does_not_execute_docker_load(self):
        with tempfile.TemporaryDirectory() as folder:
            file = pathlib.Path(folder) / "dummy"
            file.write_bytes(b"payload")
            metadata = {
                "archive_sha256": prebuilt.hashlib.sha256(b"payload").hexdigest(),
                "archive_size": "7",
                "image_size": "4096",
                "image_id": IMAGE,
                "release": VERSION,
                "sha": SHA,
                "build_run_id": "123",
            }
            with (patch.object(prebuilt, "verified_image_proof", return_value=metadata),
                  patch.object(prebuilt, "_quarantine", return_value=file),
                  patch.object(prebuilt.subprocess, "run") as load):
                with self.assertRaisesRegex(prebuilt.PrebuiltError, "Insufficient space"):
                    prebuilt.import_prebuilt(pathlib.Path(folder), SHA, VERSION,
                                            None, lambda _: 1024**3)
                load.assert_not_called()

    def test_canonical_agent_uses_no_build_in_all_runtime_jobs(self):
        text = (PATH.parent / "agent.py").read_text()
        self.assertIn("prebuilt_only=True", text)
        self.assertIn("import_prebuilt(repo, target", text)
        self.assertIn("refs/tags/mv3c-image/v*:refs/mv3c-release/images/v*", text)
        flow = (PATH.parents[2] / ".github/workflows/mv3c-prebuilt.yml").read_text()
        self.assertIn("docker save", flow)
        self.assertIn("mv3c-image/$VERSION", flow)
        self.assertIn("refs/mv3c-release/proofs/$VERSION", flow)
        self.assertIn("StrictHostKeyChecking=yes", flow)
        self.assertIn("group: mv3c-prebuilt-delivery", flow)
        self.assertIn("Insufficient host disk:", flow)
        self.assertLess(flow.index("docker pull mongo:8.0.20"),
                        flow.index("docker compose -f docker-compose.mv3c.yml up -d --no-build --pull never"))


if __name__ == "__main__":
    unittest.main()
