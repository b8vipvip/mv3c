"""Offline tests: canonical updater must retain one queue and fail-closed OCI opt-in."""
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import prebuilt  # noqa: E402

SHA = "a" * 40
VERSION = "v0.1.45"
PROOF = {
    "release": VERSION, "sha": SHA,
    "image_id": "sha256:" + "b" * 64,
    "registry": "ghcr.io/b8vipvip/mv3c",
    "registry_digest": "sha256:" + "c" * 64,
    "image_size": "1648116608",
}


class CanonicalProxyRouteTests(unittest.TestCase):
    def test_required_optin_uses_canonical_prebuilt_entrypoint_only(self):
        with (patch.object(prebuilt, "verified_image_proof",
                           return_value=PROOF),
              patch("oci_proxy_transport.prepare_proxy_candidate",
                    return_value="Verified proxy OCI candidate") as transport,
              patch.object(prebuilt, "prepare_archive") as archive,
              patch.dict(prebuilt.os.environ, {
                  "MV3C_OCI_PROXY_TRANSPORT": "required",
                  "MV3C_OCI_LAYER_TRANSPORT": "",
              })):
            result = prebuilt.import_prebuilt(
                pathlib.Path("/tmp"), SHA, VERSION, lambda *_: "",
                lambda _: 100 * 1024**3)
        self.assertIn("Verified proxy OCI candidate", result)
        transport.assert_called_once()
        archive.assert_not_called()

    def test_conflicting_transports_fail_before_download(self):
        with (patch.object(prebuilt, "verified_image_proof",
                           return_value=PROOF),
              patch("oci_proxy_transport.prepare_proxy_candidate") as transport,
              patch.object(prebuilt, "prepare_archive") as archive,
              patch.dict(prebuilt.os.environ, {
                  "MV3C_OCI_PROXY_TRANSPORT": "required",
                  "MV3C_OCI_LAYER_TRANSPORT": "enabled",
              })):
            with self.assertRaisesRegex(prebuilt.PrebuiltError,
                                         "Only one OCI transport"):
                prebuilt.import_prebuilt(
                    pathlib.Path("/tmp"), SHA, VERSION, lambda *_: "",
                    lambda _: 100 * 1024**3)
        transport.assert_not_called()
        archive.assert_not_called()

    def test_required_proxy_failure_never_downloads_archive(self):
        from oci_proxy_transport import OCIProxyTransportError
        with (patch.object(prebuilt, "verified_image_proof",
                           return_value=PROOF),
              patch("oci_proxy_transport.prepare_proxy_candidate",
                    side_effect=OCIProxyTransportError("unavailable")),
              patch.object(prebuilt, "prepare_archive") as archive,
              patch.dict(prebuilt.os.environ, {
                  "MV3C_OCI_PROXY_TRANSPORT": "required",
                  "MV3C_OCI_LAYER_TRANSPORT": "",
              })):
            with self.assertRaisesRegex(prebuilt.PrebuiltError, "unavailable"):
                prebuilt.import_prebuilt(
                    pathlib.Path("/tmp"), SHA, VERSION, lambda *_: "",
                    lambda _: 100 * 1024**3)
        archive.assert_not_called()

    def test_proxy_archive_receipt_is_not_accepted_on_labels_alone(self):
        with tempfile.TemporaryDirectory() as root:
            stage = pathlib.Path(root) / "oci-blob-cache"
            stage.mkdir()
            receipt = stage / ("oci-" + SHA + ".tar")
            receipt.write_bytes(b"isolated placeholder")
            with (patch.object(prebuilt, "VERIFIED", pathlib.Path(root)),
                  patch.object(prebuilt.subprocess, "check_output",
                               side_effect=["[]", '{"Id":"sha256:bad"}']),
                  patch("oci_proxy_import.verify_oci_archive",
                        return_value=({"layers": []}, {})) as verified,
                  patch("oci_proxy_import._assert_identity",
                        side_effect=RuntimeError("bad identity"))):
                with self.assertRaisesRegex(
                        prebuilt.PrebuiltError, "does not match signed Release"):
                    prebuilt.verified_local_candidate_id(
                        pathlib.Path(root), SHA, VERSION, PROOF,
                        PROOF["registry_digest"], lambda _: 100 * 1024**3)
            verified.assert_called_once()


if __name__ == "__main__":
    unittest.main()
