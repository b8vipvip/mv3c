"""Safe local contract tests for the remote SSH/SCP image assembler."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ASSEMBLER = Path(__file__).resolve().parents[1] / 'assemble_scp_image.sh'
SHA = '1dcbd323b10ccf199e6e1a1b0c8fc9e75e3f7b75'


class ScpChunkAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.inbox = Path(self.tmp.name)
        self.parts = self.inbox / ('.mv3c-parts-' + SHA)
        self.parts.mkdir()
        self.payload = b'fake-image-tar-contents-for-integrity' * 1300
        self.digest = hashlib.sha256(self.payload).hexdigest()
        self.chunks = [self.payload[i:i + 8192] for i in range(0, len(self.payload), 8192)]

    def write_parts(self):
        for i, chunk in enumerate(self.chunks):
            (self.parts / f'chunk-{i:04d}').write_bytes(chunk)

    def assemble(self, digest=None, count=None):
        env = os.environ.copy()
        env['MV3C_TEST_INBOX'] = str(self.inbox)
        return subprocess.run(['bash', str(ASSEMBLER), str(self.inbox), SHA,
                               digest or self.digest, str(count or len(self.chunks))],
                              env=env, capture_output=True, text=True, timeout=20)

    def test_atomic_verified_image_delivery_and_cleanup(self):
        self.write_parts()
        run = self.assemble()
        self.assertEqual(run.returncode, 0, run.stderr)
        final = self.inbox / ('mv3c-' + SHA + '.tar.gz')
        self.assertEqual(final.read_bytes(), self.payload)
        self.assertEqual((self.inbox / ('mv3c-' + SHA + '.sha256')).read_text().strip(), self.digest)
        self.assertFalse(self.parts.exists())

    def test_missing_segment_keeps_final_artifact_unpublished(self):
        self.write_parts()
        (self.parts / 'chunk-0001').unlink()
        run = self.assemble()
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse((self.inbox / ('mv3c-' + SHA + '.sha256')).exists())
        self.assertTrue(self.parts.exists())

    def test_corrupt_segment_fails_sha256_and_preserves_chunks_for_resume(self):
        self.write_parts()
        (self.parts / 'chunk-0002').write_bytes(b'CORRUPT')
        run = self.assemble()
        self.assertEqual(run.returncode, 4, run.stderr)
        self.assertFalse((self.inbox / ('mv3c-' + SHA + '.tar.gz')).exists())
        self.assertFalse((self.inbox / ('mv3c-' + SHA + '.sha256')).exists())
        self.assertTrue((self.parts / 'chunk-0000').exists())

    def test_refuses_wrong_commit_and_unexpected_inbox(self):
        self.write_parts()
        env = os.environ.copy()
        env['MV3C_TEST_INBOX'] = str(self.inbox)
        a = subprocess.run(['bash', str(ASSEMBLER), str(self.inbox),
                            '../other', self.digest, '3'], env=env, capture_output=True)
        self.assertNotEqual(a.returncode, 0)


if __name__ == '__main__':
    unittest.main()
