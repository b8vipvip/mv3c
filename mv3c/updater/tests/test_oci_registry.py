"""Offline tests: OCI distribution may accelerate only, never weaken Release proof."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mv3c_oci_registry_test", ROOT / "oci_registry.py")
oci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oci)

SHA = "a" * 40
VERSION = "v0.1.34"
CONFIG = "sha256:" + "b" * 64
DIGEST = "sha256:" + "c" * 64
REG = oci.REGISTRY
PROOF = {
    "release": VERSION, "sha": SHA, "image_id": CONFIG,
    "registry": REG, "registry_digest": DIGEST,
    "image_size": str(1_646_317_635),
}
METADATA = {
    "Id": DIGEST, "RepoDigests": [REG + "@" + DIGEST],
    "Config": {
        "Labels": {
            "org.opencontainers.image.source": "https://github.com/b8vipvip/mv3c",
            "org.opencontainers.image.revision": SHA,
            "org.opencontainers.image.version": VERSION,
        },
        "Env": ["BUILD_COMMIT=" + SHA, "MV3C_VERSION=" + VERSION],
    },
    "RootFS": {"Layers": ["sha256:" + "d" * 64]},
}


class OCIRegistryTests(unittest.TestCase):
    def test_v1_image_proof_without_registry_stays_archive_only(self):
        self.assertIsNone(oci.attested_registry_manifest(
            {"release": VERSION, "sha": SHA}, VERSION, SHA))

    def test_manifest_pinned_to_only_allowed_registry_and_exact_release(self):
        self.assertEqual(oci.attested_registry_manifest(PROOF, VERSION, SHA), DIGEST)
        for invalid in (
            dict(PROOF, registry="ghcr.io/attacker/mv3c"),
            dict(PROOF, registry_digest="sha256:" + "X" * 64),
            dict(PROOF, registry_digest=""),
            dict(PROOF, sha="f" * 40),
            dict(PROOF, release="v0.1.35"),
            dict(PROOF, registry_digest=None),
            dict(PROOF, registry=None),
        ):
            with self.assertRaises(oci.OCIProofError):
                oci.attested_registry_manifest(invalid, VERSION, SHA)

    def test_pulled_image_must_match_signed_manifest_and_app_metadata(self):
        oci.verify_registry_image(METADATA, VERSION, SHA, CONFIG, DIGEST)
        for invalid in (
            dict(METADATA, Id="sha256:" + "e" * 64),
            dict(METADATA, RepoDigests=[REG + "@sha256:" + "f" * 64]),
            dict(METADATA, RootFS={"Layers": []}),
            dict(METADATA, Config=dict(METADATA["Config"], Env=[])),
            dict(METADATA, Config={
                **METADATA["Config"],
                "Labels": {**METADATA["Config"]["Labels"],
                           "org.opencontainers.image.revision": "f" * 40},
            }),
        ):
            with self.assertRaises(oci.OCIProofError):
                oci.verify_registry_image(invalid, VERSION, SHA, CONFIG, DIGEST)

    def test_registry_success_uses_exact_digest_and_tags_only_after_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            def fake_run(args, **kwargs):
                calls.append(args)
                return types.SimpleNamespace(returncode=0)
            fake_deps = types.ModuleType("prebuilt")
            fake_deps._host_import_budget = lambda n: 2 * n
            with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
                  patch.object(oci.subprocess, "run", side_effect=fake_run),
                  patch.object(oci.subprocess, "check_output",
                               return_value=json.dumps(METADATA))):
                message = oci.pull_registry_candidate(
                    pathlib.Path(folder), VERSION, SHA, PROOF, None,
                    lambda _: 10 * 1024**3)
            self.assertIn("Verified OCI manifest", message)
            self.assertEqual(calls[0], [
                "docker", "image", "pull", "--platform", "linux/amd64", REG + "@" + DIGEST,
            ])
            self.assertEqual(calls[1], [
                "docker", "image", "tag", REG + "@" + DIGEST, "mv3c:sha-" + SHA,
            ])

    def test_public_registry_unavailable_uses_original_signed_archive_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            fake_deps = types.ModuleType("prebuilt")
            fake_deps._host_import_budget = lambda n: 2 * n
            with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
                  patch.object(oci.subprocess, "run",
                               return_value=types.SimpleNamespace(returncode=1)) as pull):
                self.assertIsNone(oci.pull_registry_candidate(
                    pathlib.Path(folder), VERSION, SHA, PROOF, None,
                    lambda _: 10 * 1024**3))
            self.assertEqual(pull.call_count, 1)

    def test_identity_mismatch_refuses_tagging_even_after_registry_pull(self):
        with tempfile.TemporaryDirectory() as folder:
            fake_deps = types.ModuleType("prebuilt")
            fake_deps._host_import_budget = lambda n: 2 * n
            wrong = dict(METADATA, RepoDigests=[REG + "@sha256:" + "e" * 64])
            with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
                  patch.object(oci.subprocess, "run",
                               return_value=types.SimpleNamespace(returncode=0)) as op,
                  patch.object(oci.subprocess, "check_output",
                               return_value=json.dumps(wrong))):
                with self.assertRaises(oci.OCIProofError):
                    oci.pull_registry_candidate(
                        pathlib.Path(folder), VERSION, SHA, PROOF, None,
                        lambda _: 10 * 1024**3)
            self.assertEqual(op.call_count, 1)  # pull only, never tag

    def test_low_disk_fails_before_network_or_tagging(self):
        fake_deps = types.ModuleType("prebuilt")
        fake_deps._host_import_budget = lambda n: 2 * n
        with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
              patch.object(oci.subprocess, "run") as network):
            with self.assertRaisesRegex(oci.OCIProofError, "Insufficient disk reserve"):
                oci.pull_registry_candidate(
                    pathlib.Path("/tmp"), VERSION, SHA, PROOF, None, lambda _: 0)
            network.assert_not_called()

    def test_missing_registry_proof_does_not_attempt_pull(self):
        with patch.object(oci.subprocess, "run") as network:
            self.assertIsNone(oci.pull_registry_candidate(
                pathlib.Path("/tmp"), VERSION, SHA,
                {"release": VERSION, "sha": SHA}, None, lambda _: 0))
            network.assert_not_called()

    def test_network_timeout_falls_back_without_tagging(self):
        fake_deps = types.ModuleType("prebuilt")
        fake_deps._host_import_budget = lambda n: 2 * n
        with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
              patch.object(oci.subprocess, "run",
                           side_effect=subprocess.TimeoutExpired("docker pull", 180)) as network):
            self.assertIsNone(oci.pull_registry_candidate(
                pathlib.Path("/tmp"), VERSION, SHA, PROOF, None,
                lambda _: 10 * 1024**3))
            self.assertEqual(network.call_count, 1)

    def test_inspection_failure_fails_closed(self):
        fake_deps = types.ModuleType("prebuilt")
        fake_deps._host_import_budget = lambda n: 2 * n
        with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
              patch.object(oci.subprocess, "run",
                           return_value=types.SimpleNamespace(returncode=0)) as network,
              patch.object(oci.subprocess, "check_output",
                           side_effect=subprocess.CalledProcessError(1, "inspect"))):
            with self.assertRaisesRegex(oci.OCIProofError, "cannot be inspected"):
                oci.pull_registry_candidate(
                    pathlib.Path("/tmp"), VERSION, SHA, PROOF, None,
                    lambda _: 10 * 1024**3)
            self.assertEqual(network.call_count, 1)

    def test_tag_failure_fails_closed_not_archive_fallback(self):
        fake_deps = types.ModuleType("prebuilt")
        fake_deps._host_import_budget = lambda n: 2 * n
        with (patch.dict(sys.modules, {"prebuilt": fake_deps}),
              patch.object(oci.subprocess, "run",
                           side_effect=[types.SimpleNamespace(returncode=0),
                                        types.SimpleNamespace(returncode=1)]) as network,
              patch.object(oci.subprocess, "check_output",
                           return_value=json.dumps(METADATA))):
            with self.assertRaisesRegex(oci.OCIProofError, "immutable local tag"):
                oci.pull_registry_candidate(
                    pathlib.Path("/tmp"), VERSION, SHA, PROOF, None,
                    lambda _: 10 * 1024**3)
            self.assertEqual(network.call_count, 2)

    def test_official_ghcr_acceptance_dispatch_after_proof_only(self):
        workflow = (ROOT.parents[1] / ".github/workflows/mv3c-prebuilt.yml").read_text()
        self.assertIn("  actions: write", workflow)
        self.assertIn("gh workflow run mv3c-ghcr-proof-acceptance.yml", workflow)
        self.assertIn("steps.registry.outcome == 'success'", workflow)
        self.assertIn("steps.registry.outputs.digest != ''", workflow)
        self.assertIn("vars.MV3C_ENABLE_OCI_REGISTRY == 'enabled'", workflow)
        proof = workflow.index("      - name: Record protected archive/image proof AFTER asset publication")
        dispatch = workflow.index("      - name: Dispatch official GHCR proof acceptance after publishing image proof")
        self.assertGreater(dispatch, proof)
        self.assertIn("manual verification required", workflow)
        self.assertIn("Official GHCR proof acceptance dispatched", workflow)

    def test_unchanged_archive_policy_retained(self):
        updater = (ROOT / "prebuilt.py").read_text()
        imageproof = (ROOT.parents[1] / ".github/workflows/mv3c-prebuilt.yml").read_text()
        self.assertIn('oci_mode in ("enabled", "required")', updater)
        self.assertIn("archive_attested_image_ids(path, proof, tag)", updater)
        self.assertIn('path = prepare_archive(repo, version, sha, proof, disk_free)', updater)
        self.assertIn('vars.MV3C_ENABLE_OCI_REGISTRY', imageproof)
        self.assertIn('continue-on-error: true', imageproof)
        self.assertIn('registry_digest=$REGISTRY_DIGEST', imageproof)
        self.assertIn('archive_sha256=$ARCHIVE_SHA', imageproof)


if __name__ == "__main__":
    unittest.main()
