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

    def test_registry_digest_must_be_in_original_protected_release_proof(self):
        registry = "ghcr.io/b8vipvip/mv3c"
        digest = "sha256:" + "d" * 64
        def as_proof(data):
            def fake(_repo, command, *args):
                if command == "cat-file" and args[0] == "-t":
                    return "tag"
                if command == "rev-parse":
                    return SHA
                return data
            return prebuilt.verified_image_proof(
                pathlib.Path("/tmp"), VERSION, SHA, fake)
        result = as_proof(proof(registry=registry, registry_digest=digest))
        self.assertEqual(result["registry_digest"], digest)
        for wrong in (
            proof(registry=registry),
            proof(registry_digest=digest),
            proof(registry="ghcr.io/attacker/mv3c", registry_digest=digest),
            proof(registry=registry, registry_digest="latest"),
        ):
            with self.assertRaises(prebuilt.PrebuiltError):
                as_proof(wrong)

    def test_optin_registry_import_does_not_stage_full_archive(self):
        import sys
        import types
        fake = types.ModuleType("oci_registry")
        fake.OCIProofError = type("OCIProofError", (RuntimeError,), {})
        fake.pull_registry_candidate = unittest.mock.Mock(
            return_value="Verified OCI manifest sha256:...")
        metadata = {
            "release": VERSION, "sha": SHA, "image_id": IMAGE,
            "image_size": "4096", "archive_size": "2048",
            "archive_sha256": ARCHIVE,
        }
        with (patch.dict(sys.modules, {"oci_registry": fake}),
              patch.dict(prebuilt.os.environ, {"MV3C_OCI_LAYER_TRANSPORT": "enabled"}),
              patch.object(prebuilt, "verified_image_proof", return_value=metadata),
              patch.object(prebuilt, "prepare_archive") as download,
              patch.object(prebuilt.subprocess, "run") as docker):
            result = prebuilt.import_prebuilt(
                pathlib.Path("/tmp"), SHA, VERSION, None, lambda _: 10**10)
            self.assertIn("Verified OCI manifest", result)
            download.assert_not_called()
            docker.assert_not_called()

    def test_unenabled_registry_never_contacts_registry_for_old_proofs(self):
        import sys
        import types
        fake = types.ModuleType("oci_registry")
        fake.pull_registry_candidate = unittest.mock.Mock()
        with (patch.dict(sys.modules, {"oci_registry": fake}),
              patch.dict(prebuilt.os.environ, {"MV3C_OCI_LAYER_TRANSPORT": ""}),
              patch.object(prebuilt, "verified_image_proof", return_value={
                  "release": VERSION, "sha": SHA, "image_id": IMAGE,
                  "image_size": "4096", "archive_size": "2048",
                  "archive_sha256": ARCHIVE,
              }),
              patch.object(prebuilt, "prepare_archive",
                           side_effect=prebuilt.PrebuiltError("Signed archive unavailable"))):
            with self.assertRaisesRegex(prebuilt.PrebuiltError, "Signed archive unavailable"):
                prebuilt.import_prebuilt(
                    pathlib.Path("/tmp"), SHA, VERSION, None, lambda _: 10**10)
            fake.pull_registry_candidate.assert_not_called()

    def test_signed_registry_manifest_candidate_requires_exact_repo_digest(self):
        import json
        digest = "sha256:" + "d" * 64
        proof_data = {"image_id": IMAGE, "registry_digest": digest,
                      "release": VERSION, "sha": SHA}
        with patch.object(prebuilt.subprocess, "check_output",
                          return_value=json.dumps(["ghcr.io/b8vipvip/mv3c@" + digest])):
            self.assertTrue(prebuilt.verified_local_candidate_id(
                pathlib.Path("/tmp"), SHA, VERSION, proof_data, digest, None))
        with patch.object(prebuilt.subprocess, "check_output",
                          return_value=json.dumps(["ghcr.io/attacker/mv3c@" + digest])):
            with self.assertRaises(prebuilt.PrebuiltError):
                prebuilt.verified_local_candidate_id(
                    pathlib.Path("/tmp"), SHA, VERSION, proof_data, digest, None)

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
                  patch.object(prebuilt, "prepare_archive", return_value=file),
                  patch.object(prebuilt.subprocess, "run") as load):
                with self.assertRaisesRegex(prebuilt.PrebuiltError, "Insufficient space"):
                    prebuilt.import_prebuilt(pathlib.Path(folder), SHA, VERSION,
                                            None, lambda _: 1024**3)
                load.assert_not_called()

    def test_containerd_disk_budget_matches_real_host_observation(self):
        # Production v0.1.27/v0.1.28 Docker 29 used ~3.72GB unique layers,
        # although Actions reported image_size ~=1.65GB. Keep the 2GiB
        # post-import reserve and refuse underestimated imports.
        size = 1646339292
        allowance = prebuilt._host_import_budget(size)
        self.assertGreaterEqual(allowance, 3723000000)
        self.assertLess(allowance, 5 * 1024**3)

    def test_host_5_6gib_free_refuses_download_before_full_disk(self):
        import types
        import os
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder)
            metadata = {
                "archive_size": "506127631",
                "image_size": "1646339292",
                "archive_sha256": "0" * 64,
            }
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.shutil, "disk_usage",
                               return_value=types.SimpleNamespace(free=10 * 1024**3)),
                  patch.object(prebuilt.subprocess, "run") as curl):
                with self.assertRaisesRegex(prebuilt.PrebuiltError, "Insufficient space"):
                    prebuilt._download_release_asset(
                        verified, VERSION, SHA, metadata,
                        lambda _: int(5.6 * 1024**3))
                curl.assert_not_called()

    def test_host_underestimated_image_size_refuses_docker_load(self):
        import types
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / "dummy.tar.gz"
            archive.write_bytes(b"fake-pinned-archive")
            metadata = {
                "archive_sha256": prebuilt.hashlib.sha256(archive.read_bytes()).hexdigest(),
                "archive_size": str(archive.stat().st_size),
                "image_size": "1646339292",
                "image_id": IMAGE,
                "release": VERSION, "sha": SHA, "build_run_id": "123",
            }
            with (patch.object(prebuilt, "verified_image_proof", return_value=metadata),
                  patch.object(prebuilt, "prepare_archive", return_value=archive),
                  patch.object(prebuilt.subprocess, "run") as loader):
                with self.assertRaisesRegex(prebuilt.PrebuiltError, "Insufficient space"):
                    prebuilt.import_prebuilt(
                        pathlib.Path(folder), SHA, VERSION, None,
                        lambda _: int(5.6 * 1024**3))
                loader.assert_not_called()

    def test_release_url_is_exact_official_host_and_no_url_injection(self):
        self.assertEqual(
            prebuilt.release_asset_url(VERSION, SHA),
            ("https://github.com/b8vipvip/mv3c/releases/download/"
             + VERSION + "/mv3c-" + VERSION + "-" + SHA + ".tar.gz"))
        for invalid in ("v1.0.0/evil", "https://evil.test/file", "../v1.0.0"):
            with self.assertRaises(prebuilt.PrebuiltError):
                prebuilt.release_asset_url(invalid, SHA)

    def test_undersized_disk_refuses_https_and_docker(self):
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder) / "verified"
            verified.mkdir()
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.subprocess, "run") as download):
                with self.assertRaisesRegex(prebuilt.PrebuiltError, "Insufficient space"):
                    prebuilt._download_release_asset(
                        pathlib.Path(folder), VERSION, SHA,
                        {"archive_size": "4096", "image_size": "1048576",
                         "archive_sha256": ARCHIVE},
                        lambda _: 1024)
                download.assert_not_called()

    def test_https_asset_download_checks_sha_and_uses_resumable_tls(self):
        import hashlib
        import types
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder) / "verified"
            verified.mkdir()
            payload = b"reproducible git release asset payload"
            meta = {"archive_size": str(len(payload)), "image_size": "4096",
                    "archive_sha256": hashlib.sha256(payload).hexdigest()}
            commands = []
            def mocked_curl(cmd, **_kwargs):
                commands.append(cmd)
                path = pathlib.Path(cmd[cmd.index("--output")+1])
                path.write_bytes(payload)
                return types.SimpleNamespace(returncode=0, stderr="")
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.os, "chown"),
                  patch.object(prebuilt.subprocess, "run", side_effect=mocked_curl)):
                resulting = prebuilt._download_release_asset(
                    pathlib.Path(folder), VERSION, SHA, meta,
                    lambda _: 16*1024**3)
            self.assertEqual(resulting.read_bytes(), payload)
            self.assertIn("--fail", commands[0])
            self.assertIn("--location", commands[0])
            self.assertEqual(commands[0][-1], prebuilt.release_asset_url(VERSION, SHA))
            self.assertIn("--continue-at", commands[0])



    def test_download_reconnects_three_curl_processes_and_checks_exact_hash(self):
        import hashlib
        import types
        import os
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder)
            payload = b"abcdefghijklmnopqrstuvwxyz"
            metadata = {
                "archive_size": str(len(payload)),
                "image_size": "4096",
                "archive_sha256": hashlib.sha256(payload).hexdigest(),
            }
            requests = []
            def broken_cdn(command, **kwargs):
                requests.append(command)
                partial = pathlib.Path(command[command.index("--output") + 1])
                previous = partial.stat().st_size if partial.exists() else 0
                end = [10, 19, len(payload)][len(requests) - 1]
                with partial.open("ab") as out:
                    out.write(payload[previous:end])
                assert command[-1] == prebuilt.release_asset_url(VERSION, SHA)
                return types.SimpleNamespace(
                    returncode=[18, 56, 0][len(requests) - 1],
                    stdout="200" if len(requests) == 1 else "206",
                    stderr="partial transfer" if len(requests) < 3 else "",
                )
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.shutil, "disk_usage", return_value=types.SimpleNamespace(free=100*1024**3)),
                  patch.object(prebuilt.subprocess, "run", side_effect=broken_cdn),
                  patch("time.sleep")):
                path = prebuilt._download_release_asset(
                    verified, VERSION, SHA, metadata, lambda _: 100*1024**3)
            self.assertEqual(path.read_bytes(), payload)
            self.assertEqual(len(requests), 3)
            self.assertFalse((verified / (prebuilt.filename(VERSION, SHA) + ".download")).exists())

    def test_download_refuses_endless_no_progress_and_preserves_partial(self):
        import types
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder)
            metadata = {"archive_size": "26", "image_size": "4096",
                        "archive_sha256": "0" * 64}
            calls = []
            def stalled(command, **kwargs):
                calls.append(command)
                pathlib.Path(command[command.index("--output") + 1]).touch()
                return types.SimpleNamespace(returncode=18, stdout="000", stderr="dropped")
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.shutil, "disk_usage", return_value=types.SimpleNamespace(free=100*1024**3)),
                  patch.object(prebuilt.subprocess, "run", side_effect=stalled),
                  patch("time.sleep")):
                with self.assertRaisesRegex(prebuilt.PrebuiltError, "stalled three times"):
                    prebuilt._download_release_asset(
                        verified, VERSION, SHA, metadata, lambda _: 100*1024**3)
            self.assertEqual(len(calls), 3)
            self.assertTrue((verified / (prebuilt.filename(VERSION, SHA) + ".download")).exists())

    def test_http_403_before_partial_reports_root_cause_and_stops(self):
        import types
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder)
            response = types.SimpleNamespace(
                returncode=22, stdout="403",
                stderr="curl: (22) The requested URL returned error: 403")
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.subprocess, "run", return_value=response) as curl):
                with self.assertRaisesRegex(prebuilt.PrebuiltError,
                                            "curl exit=22, http=403"):
                    prebuilt._download_release_asset(
                        verified, VERSION, SHA,
                        {"archive_size": "100", "image_size": "4096"},
                        lambda _: 100 * 1024**3)
            self.assertEqual(curl.call_count, 1)
            self.assertFalse((verified / (prebuilt.filename(VERSION, SHA) + ".download")).exists())

    def test_transient_no_partial_is_bounded_and_does_not_disable_timer(self):
        import types
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder)
            response = types.SimpleNamespace(
                returncode=28, stdout="000", stderr="curl: (28) Connection timed out")
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.subprocess, "run", return_value=response) as curl,
                  patch("time.sleep") as sleep):
                with self.assertRaisesRegex(prebuilt.PrebuiltError,
                                            "failed three times before creating partial"):
                    prebuilt._download_release_asset(
                        verified, VERSION, SHA,
                        {"archive_size": "100", "image_size": "4096"},
                        lambda _: 100 * 1024**3)
            self.assertEqual(curl.call_count, 3)
            self.assertEqual(sleep.call_count, 2)

    def test_transient_http_503_without_partial_recovers_and_hash_verifies(self):
        import hashlib
        import types
        with tempfile.TemporaryDirectory() as folder:
            verified = pathlib.Path(folder)
            payload = b"verified archive bytes"
            attempts = []
            def fake_curl(command, **kwargs):
                attempts.append(command)
                if len(attempts) == 1:
                    return types.SimpleNamespace(returncode=22, stdout="503",
                                                 stderr="curl: (22) HTTP 503")
                pathlib.Path(command[command.index("--output") + 1]).write_bytes(payload)
                return types.SimpleNamespace(returncode=0, stdout="200", stderr="")
            with (patch.object(prebuilt, "VERIFIED", verified),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.subprocess, "run", side_effect=fake_curl),
                  patch("time.sleep")):
                output = prebuilt._download_release_asset(
                    verified, VERSION, SHA,
                    {"archive_size": str(len(payload)), "image_size": "4096",
                     "archive_sha256": hashlib.sha256(payload).hexdigest()},
                    lambda _: 100 * 1024**3)
            self.assertEqual(output.read_bytes(), payload)
            self.assertEqual(len(attempts), 2)

    def test_one_time_bootstrap_keeps_timer_until_verified_archive(self):
        bootstrap = (PATH.parent / "bootstrap-prebuilt.sh").read_text()
        proof = bootstrap.index("artifact=p.prepare_archive(")
        pause = bootstrap.index("systemctl disable --now mv3c-updater.timer")
        queue = bootstrap.index("queueJob(")
        self.assertLess(proof, pause)
        self.assertLess(pause, queue)

    def test_download_proxy_is_loopback_only_and_redacted_from_argv(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {"MV3C_DOWNLOAD_PROXY": "socks5h://127.0.0.1:11808"}):
            self.assertEqual(prebuilt._validated_download_proxy(),
                             "socks5h://127.0.0.1:11808")
        for unsafe in ("socks5://127.0.0.1:11808", "http://outside.example:443",
                       "socks5h://user:secret@127.0.0.1:11808",
                       "http://127.0.0.1:8888/other",
                       "socks5h://127.0.0.1:99999"):
            with patch.dict(os.environ, {"MV3C_DOWNLOAD_PROXY": unsafe}):
                with self.assertRaises(prebuilt.PrebuiltError):
                    prebuilt._validated_download_proxy()
        import types
        payload = b"abc"
        with tempfile.TemporaryDirectory() as folder:
            proxy = "socks5h://127.0.0.1:11808"
            seen = []
            def fake(command, **kwargs):
                seen.append((command, kwargs["env"]))
                pathlib.Path(command[command.index("--output") + 1]).write_bytes(payload)
                return types.SimpleNamespace(returncode=0, stdout="200", stderr="")
            with (patch.dict(os.environ, {"MV3C_DOWNLOAD_PROXY": proxy}),
                  patch.object(prebuilt, "VERIFIED", pathlib.Path(folder)),
                  patch.object(prebuilt, "_root_only_directory"),
                  patch.object(prebuilt.shutil, "disk_usage", return_value=types.SimpleNamespace(free=100*1024**3)),
                  patch.object(prebuilt.subprocess, "run", side_effect=fake)):
                prebuilt._download_release_asset(
                    pathlib.Path(folder), VERSION, SHA,
                    {"archive_size": "3", "image_size": "4096",
                     "archive_sha256": prebuilt.hashlib.sha256(payload).hexdigest()},
                    lambda _: 100*1024**3)
            self.assertEqual(seen[0][1]["https_proxy"], proxy)
            self.assertNotIn(proxy, " ".join(seen[0][0]))
            self.assertIn("--noproxy", seen[0][0])


    def test_containerd_manifest_id_is_bound_to_official_config(self):
        import hashlib
        import io
        import json
        import tarfile

        rev = SHA
        config = {
            "architecture": "amd64", "os": "linux",
            "config": {
                "Labels": {
                    "org.opencontainers.image.revision": rev,
                    "org.opencontainers.image.version": VERSION,
                    "org.opencontainers.image.source": prebuilt.SOURCE,
                },
                "Env": ["BUILD_COMMIT=" + rev, "MV3C_VERSION=" + VERSION],
            },
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "a" * 64]},
        }
        cfg = json.dumps(config, sort_keys=True).encode()
        cfg_digest = "sha256:" + hashlib.sha256(cfg).hexdigest()
        tag = "mv3c:sha-" + rev
        manifest = {
            "schemaVersion": 2,
            "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                       "digest": cfg_digest},
            "layers": [{"digest": "sha256:" + "d" * 64}],
        }
        manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
        manifest_digest = "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()
        index = {"manifests": [{"digest": manifest_digest,
                               "mediaType": "application/vnd.oci.image.manifest.v1+json"}]}
        save_manifest = [{"Config": "blobs/sha256/" + cfg_digest[7:],
                          "RepoTags": [tag], "Layers": ["blobs/sha256/layer"]}]
        tiny_layer = b"\x1f\x8b\x08\x00not-json-oci-layer"
        binary_digest = hashlib.sha256(tiny_layer).hexdigest()
        data = {
            "manifest.json": json.dumps(save_manifest).encode(),
            "index.json": json.dumps(index).encode(),
            "blobs/sha256/" + cfg_digest[7:]: cfg,
            "blobs/sha256/" + manifest_digest[7:]: manifest_bytes,
            "blobs/sha256/" + binary_digest: tiny_layer,
        }
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / "image.tar.gz"
            with tarfile.open(archive, "w:gz") as dest:
                for name, payload in data.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    dest.addfile(info, io.BytesIO(payload))
            signed = {"image_id": cfg_digest, "sha": SHA, "release": VERSION}
            identities = prebuilt.archive_attested_image_ids(archive, signed, tag)
            self.assertEqual(identities, {cfg_digest, manifest_digest})
            self.assertTrue(prebuilt.verified_local_candidate_id(
                pathlib.Path(folder), SHA, VERSION, signed, cfg_digest, None))
            with patch.object(prebuilt, "prepare_archive", return_value=archive):
                self.assertTrue(prebuilt.verified_local_candidate_id(
                    pathlib.Path(folder), SHA, VERSION, signed, manifest_digest, None))
                self.assertFalse(prebuilt.verified_local_candidate_id(
                    pathlib.Path(folder), SHA, VERSION, signed,
                    "sha256:" + "e" * 64, None))
                # An arbitrary OCI manifest cannot borrow a valid config.
                altered = dict(signed, image_id="sha256:" + "f" * 64)
                with self.assertRaises(prebuilt.PrebuiltError):
                    prebuilt.archive_attested_image_ids(archive, altered, tag)


    def test_canonical_agent_uses_no_build_in_all_runtime_jobs(self):
        text = (PATH.parent / "agent.py").read_text()
        self.assertIn("prebuilt_only=True", text)
        self.assertIn("import_prebuilt(repo, target", text)
        self.assertIn("refs/tags/mv3c-image/v*:refs/mv3c-release/images/v*", text)
        flow = (PATH.parents[2] / ".github/workflows/mv3c-prebuilt.yml").read_text()
        self.assertIn("docker save", flow)
        self.assertIn("mv3c-image/$VERSION", flow)
        self.assertIn("refs/mv3c-release/proofs/$VERSION", flow)
        self.assertIn("gh release upload", flow)
        self.assertIn("group: mv3c-prebuilt-delivery", flow)
        self.assertNotIn("scp ", flow)
        self.assertIn("archive_sha256=$ARCHIVE_SHA", flow)
        self.assertLess(flow.index("docker pull mongo:8.0.20"),
                        flow.index("docker compose -f docker-compose.mv3c.yml up -d --no-build --pull never"))


if __name__ == "__main__":
    unittest.main()
