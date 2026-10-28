"""Offline fail-closed validation of the Docker candidate import adapter."""
import json
import pathlib
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import oci_proxy_import as adapter  # noqa: E402
from oci_proxy_archive import build_attested_oci_archive
from test_oci_proxy_archive import SHA, VERSION, digest, fixture, put


def prepared(root):
    stage = pathlib.Path(root)
    stage.chmod(0o700)
    manifest, conf, layer, proof = fixture()
    put(stage, conf)
    put(stage, layer)
    candidate = stage / ("oci-" + SHA + ".tar")
    build_attested_oci_archive(stage, candidate, raw_manifest=manifest,
                               raw_config=conf, proof=proof,
                               version=VERSION, sha=SHA)
    return candidate, proof, json.loads(conf)


def image_metadata(proof, config):
    return {
        "Id": proof["registry_digest"],
        "Config": config["config"],
        "RootFS": {"Layers": config["rootfs"]["diff_ids"]},
    }


class DockerImportUnitTests(unittest.TestCase):
    def test_offline_full_archive_verification(self):
        with tempfile.TemporaryDirectory() as root:
            archive, proof, _ = prepared(root)
            manifest, config = adapter.verify_oci_archive(
                archive, proof, VERSION, SHA)
            self.assertEqual(manifest["manifest_digest"], proof["registry_digest"])
            self.assertEqual(config["architecture"], "amd64")

    def test_extra_archive_object_rejected_without_docker_write(self):
        with tempfile.TemporaryDirectory() as root:
            archive, proof, _ = prepared(root)
            with tarfile.open(archive, mode="a") as tar:
                info = tarfile.TarInfo("unapproved")
                info.size = 0
                tar.addfile(info)
            with patch.object(adapter, "_command") as docker:
                with self.assertRaisesRegex(adapter.OCIImportError,
                                             "untrusted extra"):
                    adapter.load_verified_oci_candidate(
                        archive, proof, VERSION, SHA, cwd=pathlib.Path(root),
                        min_free_bytes=2 * 1024**3)
                docker.assert_not_called()

    def test_wrong_manifest_proof_fails_before_docker(self):
        with tempfile.TemporaryDirectory() as root:
            archive, proof, _ = prepared(root)
            proof["registry_digest"] = "sha256:" + "0" * 64
            with patch.object(adapter, "_command") as docker:
                with self.assertRaises(adapter.OCIImportError):
                    adapter.load_verified_oci_candidate(
                        archive, proof, VERSION, SHA, cwd=pathlib.Path(root),
                        min_free_bytes=2 * 1024**3)
                docker.assert_not_called()

    def test_candidate_tag_only_after_identity_verified(self):
        with tempfile.TemporaryDirectory() as root:
            archive, proof, config = prepared(root)
            state = {"tagged": False}
            calls = []
            metadata = image_metadata(proof, config)

            def fake_command(args, **kwargs):
                calls.append(args)
                if args[:3] == ["docker", "image", "load"]:
                    return types.SimpleNamespace(returncode=0, stdout="")
                if args[:3] == ["docker", "image", "tag"]:
                    state["tagged"] = True
                    return types.SimpleNamespace(returncode=0, stdout="")
                if args[:3] == ["docker", "image", "inspect"]:
                    ref = args[-1]
                    if ref == proof["registry_digest"] or state["tagged"]:
                        return types.SimpleNamespace(
                            returncode=0, stdout=json.dumps(metadata))
                    return types.SimpleNamespace(returncode=1, stdout="")
                raise AssertionError(args)

            with patch.object(adapter, "_command", side_effect=fake_command):
                report = adapter.load_verified_oci_candidate(
                    archive, proof, VERSION, SHA, cwd=pathlib.Path(root),
                    min_free_bytes=2 * 1024**3)
            self.assertFalse(report["already_tagged"])
            self.assertEqual(report["candidate"], "mv3c:sha-" + SHA)
            self.assertEqual(sum(c[:3] == ["docker", "image", "load"]
                                 for c in calls), 0)
            self.assertEqual(sum(c[:3] == ["docker", "image", "tag"]
                                 for c in calls), 1)
            self.assertFalse(any("mv3c:local" in c for cmd in calls for c in cmd))

    def test_wrong_docker_image_refuses_tag(self):
        with tempfile.TemporaryDirectory() as root:
            archive, proof, config = prepared(root)
            wrong = image_metadata(proof, config)
            wrong["Id"] = "sha256:" + "0" * 64

            def fake_command(args, **kwargs):
                if args[:3] == ["docker", "image", "inspect"]:
                    return types.SimpleNamespace(
                        returncode=0, stdout=json.dumps(wrong))
                raise AssertionError("Must not load or tag when digest exists but differs")

            with patch.object(adapter, "_command", side_effect=fake_command):
                with self.assertRaisesRegex(
                        adapter.OCIImportError, "image ID differs"):
                    adapter.load_verified_oci_candidate(
                        archive, proof, VERSION, SHA, cwd=pathlib.Path(root),
                        min_free_bytes=2 * 1024**3)

    def test_low_space_refuses_before_docker(self):
        with tempfile.TemporaryDirectory() as root:
            archive, proof, config = prepared(root)
            with (patch.object(adapter.shutil, "disk_usage",
                               return_value=types.SimpleNamespace(free=0)),
                  patch.object(adapter, "_command") as cmd):
                with self.assertRaisesRegex(adapter.OCIImportError,
                                             "disk reserve"):
                    adapter.load_verified_oci_candidate(
                        archive, proof, VERSION, SHA, cwd=pathlib.Path(root))
                cmd.assert_not_called()


if __name__ == "__main__":
    unittest.main()
