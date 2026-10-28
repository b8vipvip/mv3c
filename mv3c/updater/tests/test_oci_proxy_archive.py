"""Offline tests for compressed OCI archive assembly and fail-closed staging."""
import gzip
import hashlib
import io
import json
import os
import pathlib
import shutil
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import oci_proxy_archive as arc  # noqa: E402
from oci_proxy_manifest import OCI_CONFIG, OCI_LAYER, OCI_MANIFEST  # noqa: E402

SHA = "a" * 40
VERSION = "v0.1.45"
SOURCE = "https://github.com/b8vipvip/mv3c"


def encoded(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def fixture():
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w") as tar:
        info = tarfile.TarInfo("hello.txt")
        content = b"MV3C attested image"
        info.size = len(content)
        tar.addfile(info, io.BytesIO(content))
    uncompressed = payload.getvalue()
    layer = gzip.compress(uncompressed, mtime=0)
    config = encoded({
        "architecture": "amd64", "os": "linux",
        "config": {
            "Labels": {
                "org.opencontainers.image.source": SOURCE,
                "org.opencontainers.image.version": VERSION,
                "org.opencontainers.image.revision": SHA,
            },
            "Env": ["BUILD_COMMIT=" + SHA, "MV3C_VERSION=" + VERSION],
        },
        "rootfs": {"type": "layers", "diff_ids": [digest(uncompressed)]},
    })
    manifest = encoded({
        "schemaVersion": 2,
        "mediaType": OCI_MANIFEST,
        "config": {
            "mediaType": OCI_CONFIG, "digest": digest(config),
            "size": len(config),
        },
        "layers": [{
            "mediaType": OCI_LAYER, "digest": digest(layer),
            "size": len(layer),
        }],
    })
    proof = {
        "registry": "ghcr.io/b8vipvip/mv3c",
        "registry_digest": digest(manifest),
        "image_id": digest(config),
        "release": VERSION,
        "sha": SHA,
    }
    return manifest, config, layer, proof


def put(stage, raw):
    p = stage / digest(raw)[7:]
    p.write_bytes(raw)
    p.chmod(0o600)
    return p


class ArchiveTests(unittest.TestCase):
    def test_verified_oci_archive_includes_exact_compressed_bytes(self):
        raw, conf, layer, proof = fixture()
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            stage.chmod(0o700)
            put(stage, conf)
            put(stage, layer)
            target = stage / ("oci-" + SHA + ".tar")
            arc.build_attested_oci_archive(
                stage, target, raw_manifest=raw, raw_config=conf,
                proof=proof, version=VERSION, sha=SHA)
            with tarfile.open(target) as tar:
                paths = tar.getnames()
                self.assertEqual(len(paths), 5)
                self.assertEqual(tar.extractfile("oci-layout").read(),
                                 b'{"imageLayoutVersion":"1.0.0"}')
                index = json.load(tar.extractfile("index.json"))
                desc = index["manifests"][0]
                self.assertEqual(desc["digest"], digest(raw))
                self.assertEqual(desc["annotations"]["org.opencontainers.image.ref.name"],
                                 "sha-" + SHA)
                self.assertEqual(
                    tar.extractfile("blobs/sha256/" + digest(raw)[7:]).read(), raw)
                self.assertEqual(
                    tar.extractfile("blobs/sha256/" + digest(conf)[7:]).read(), conf)
                self.assertEqual(
                    tar.extractfile("blobs/sha256/" + digest(layer)[7:]).read(), layer)
            self.assertFalse(target.with_name(target.name + ".part").exists())

    def test_corrupt_compressed_layer_cannot_publish_archive(self):
        raw, conf, layer, proof = fixture()
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            stage.chmod(0o700)
            put(stage, conf)
            put(stage, b"x" * len(layer)).rename(stage / digest(layer)[7:])
            target = stage / ("oci-" + SHA + ".tar")
            with self.assertRaisesRegex(arc.OCIArchiveError, "corrupted"):
                arc.build_attested_oci_archive(
                    stage, target, raw_manifest=raw, raw_config=conf,
                    proof=proof, version=VERSION, sha=SHA)
            self.assertFalse(target.exists())

    def test_mismatched_release_manifest_never_creates_tar(self):
        raw, conf, layer, proof = fixture()
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            stage.chmod(0o700)
            put(stage, conf)
            put(stage, layer)
            target = stage / ("oci-" + SHA + ".tar")
            proof["registry_digest"] = "sha256:" + "0" * 64
            with self.assertRaises(arc.ManifestProofError):
                arc.build_attested_oci_archive(
                    stage, target, raw_manifest=raw, raw_config=conf,
                    proof=proof, version=VERSION, sha=SHA)
            self.assertFalse(target.exists())

    def test_not_enough_space_refuses_archive(self):
        raw, conf, layer, proof = fixture()
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            stage.chmod(0o700)
            put(stage, conf)
            put(stage, layer)
            target = stage / ("oci-" + SHA + ".tar")
            with patch.object(arc.shutil, "disk_usage",
                              return_value=types.SimpleNamespace(free=1)):
                with self.assertRaisesRegex(arc.OCIArchiveError, "reserved disk"):
                    arc.build_attested_oci_archive(
                        stage, target, raw_manifest=raw, raw_config=conf,
                        proof=proof, version=VERSION, sha=SHA)
            self.assertFalse(target.exists())

    def test_refuse_symlink_stage_or_existing_archive(self):
        raw, conf, layer, proof = fixture()
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root) / "stage"
            stage.mkdir(mode=0o700)
            put(stage, conf)
            put(stage, layer)
            link = pathlib.Path(root) / "link"
            link.symlink_to(stage, target_is_directory=True)
            target = stage / ("oci-" + SHA + ".tar")
            with self.assertRaisesRegex(arc.OCIArchiveError, "symlink"):
                arc.build_attested_oci_archive(
                    link, link / target.name, raw_manifest=raw,
                    raw_config=conf, proof=proof, version=VERSION, sha=SHA)
            target.write_text("keep")
            with self.assertRaisesRegex(arc.OCIArchiveError, "overwrite"):
                arc.build_attested_oci_archive(
                    stage, target, raw_manifest=raw, raw_config=conf,
                    proof=proof, version=VERSION, sha=SHA)
            self.assertEqual(target.read_text(), "keep")

    def test_stage_layers_reuses_verified_cache_without_network(self):
        raw, conf, layer, proof = fixture()
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root)
            stage.chmod(0o700)
            put(stage, layer)
            manifest = arc.decode_attested_manifest(raw, proof, VERSION, SHA)
            with patch.object(arc, "stage_blob", return_value=stage / digest(layer)[7:]) as fetch:
                out = arc.stage_all_attested_layers(
                    stage, manifest, proxy="socks5h://127.0.0.1:11808")
            self.assertEqual(out["cached_blobs"], 1)
            self.assertIsNone(out["actual_wire_bytes"])
            self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
