"""Offline verified-manifest tests: no GHCR, Docker or containerd activity."""
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import oci_proxy_manifest as manifest  # noqa: E402

VERSION = "v0.1.45"
SHA = "a" * 40
PROXY = "socks5h://127.0.0.1:11808"
SOURCE = "https://github.com/b8vipvip/mv3c"


def encoded(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def checksum(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def example():
    config = encoded({
        "config": {
            "Labels": {
                "org.opencontainers.image.revision": SHA,
                "org.opencontainers.image.version": VERSION,
                "org.opencontainers.image.source": SOURCE,
            },
            "Env": ["BUILD_COMMIT=" + SHA, "MV3C_VERSION=" + VERSION],
        },
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "f" * 64]},
    })
    m = {
        "schemaVersion": 2,
        "mediaType": manifest.OCI_MANIFEST,
        "config": {"mediaType": manifest.OCI_CONFIG,
                   "digest": checksum(config), "size": len(config)},
        "layers": [{"mediaType": manifest.OCI_LAYER,
                    "digest": "sha256:" + "b" * 64, "size": 123456}],
    }
    raw = encoded(m)
    proof = {
        "release": VERSION,
        "sha": SHA,
        "registry": "ghcr.io/b8vipvip/mv3c",
        "registry_digest": checksum(raw),
        "image_id": checksum(config),
        "rootfs_diff_ids": "sha256:" + "f" * 64,
    }
    return proof, raw, config, m


class AttestedManifestTests(unittest.TestCase):
    def test_exact_immutable_manifest_and_runtime(self):
        proof, raw, config, _ = example()
        inspected = manifest.decode_attested_manifest(raw, proof, VERSION, SHA)
        self.assertEqual(inspected["compressed_layer_bytes"], 123456)
        manifest.decode_attested_config(config, inspected["config"],
                                        proof, VERSION, SHA, 1)

    def test_manifest_tampering_never_trusts_decoded_json(self):
        proof, raw, _, _ = example()
        with self.assertRaisesRegex(manifest.ManifestProofError, "SHA256"):
            manifest.decode_attested_manifest(
                raw + b" ", proof, VERSION, SHA)
        with self.assertRaisesRegex(manifest.ManifestProofError, "Release"):
            manifest.decode_attested_manifest(raw, proof, "v0.1.99", SHA)

    def test_wrong_protected_config_id_refused(self):
        proof, raw, _, _ = example()
        proof["image_id"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(manifest.ManifestProofError, "config digest"):
            manifest.decode_attested_manifest(raw, proof, VERSION, SHA)

    def test_unsupported_index_foreign_layers_and_external_urls(self):
        proof, raw, _, m = example()
        for change in (
            {"mediaType": "application/vnd.oci.image.index.v1+json"},
            {"layers": [{**m["layers"][0], "urls": ["https://example.com"]}]},
            {"layers": [{**m["layers"][0], "mediaType": "foreign.layer"}]},
            {"layers": [{**m["layers"][0], "size": True}]},
            {"layers": []},
            {"schemaVersion": 1},
        ):
            candidate = {**m, **change}
            item = encoded(candidate)
            signed = dict(proof, registry_digest=checksum(item))
            with self.assertRaises(manifest.ManifestProofError):
                manifest.decode_attested_manifest(item, signed, VERSION, SHA)

    def test_runtime_metadata_or_rootfs_mismatch_refused(self):
        proof, raw, config, _ = example()
        parsed = manifest.decode_attested_manifest(raw, proof, VERSION, SHA)
        wrong = encoded({"config": {"Env": []},
                         "rootfs": {"diff_ids": []}})
        with self.assertRaises(manifest.ManifestProofError):
            manifest.decode_attested_config(
                wrong, {**parsed["config"], "digest": checksum(wrong),
                        "size": len(wrong)}, proof, VERSION, SHA, 1)
        proof["rootfs_diff_ids"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(manifest.ManifestProofError, "protected Release"):
            manifest.decode_attested_config(
                config, parsed["config"], proof, VERSION, SHA, 1)

    def test_end_to_end_inspector_only_stages_small_config(self):
        proof, raw, config, _ = example()
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "config"
            path.write_bytes(config)
            with (patch.object(manifest, "_fetch_manifest", return_value=raw) as fetch,
                  patch.object(manifest, "stage_blob", return_value=path) as stage):
                report = manifest.inspect_attested_manifest(
                    proof, VERSION, SHA, proxy=PROXY,
                    stage=pathlib.Path(folder))
            self.assertEqual(report["compressed_layer_bytes"], 123456)
            fetch.assert_called_once_with(proof["registry_digest"], PROXY)
            self.assertEqual(stage.call_args.args[1], checksum(config))
            self.assertEqual(stage.call_args.args[2], len(config))

    def test_large_config_never_triggers_blob_download(self):
        proof, raw, config, m = example()
        m["config"]["size"] = manifest.MAX_CONFIG + 1
        altered = encoded(m)
        proof["registry_digest"] = checksum(altered)
        with tempfile.TemporaryDirectory() as folder:
            with (patch.object(manifest, "_fetch_manifest", return_value=altered),
                  patch.object(manifest, "stage_blob") as stage):
                with self.assertRaises(manifest.ManifestProofError):
                    manifest.inspect_attested_manifest(
                        proof, VERSION, SHA, proxy=PROXY,
                        stage=pathlib.Path(folder))
                stage.assert_not_called()


if __name__ == "__main__":
    unittest.main()
