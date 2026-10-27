"""Guard the optional production dependency cache without mutating production."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/mv3c-prebuilt.yml"
DOCKERFILE = ROOT / "Dockerfile"


class ProductionDependencyCacheWorkflowTests(unittest.TestCase):
    def test_cache_is_off_by_default_and_default_publisher_is_unchanged(self):
        source = WORKFLOW.read_text()
        flag = "vars.MV3C_ENABLE_PROD_DEPS_CACHE"
        self.assertIn("if: " + flag + " != 'enabled'", source)
        self.assertGreaterEqual(source.count("if: " + flag + " == 'enabled'"), 4)
        self.assertIn("docker build --progress=plain", source)
        self.assertIn("-t \"mv3c:sha-$RELEASE_SHA\" .", source)
        self.assertIn("docker save \"mv3c:sha-$RELEASE_SHA\" | gzip -1", source)

    def test_caches_only_source_independent_prod_deps_across_runs(self):
        source = WORKFLOW.read_text()
        self.assertIn("uses: docker/setup-buildx-action@v4", source)
        self.assertIn("uses: docker/build-push-action@v7", source)
        self.assertIn("target: prod-deps", source)
        self.assertIn("type=gha,scope=mv3c-prod-deps,mode=min", source)
        self.assertIn("type=gha,scope=mv3c-prod-deps", source)
        self.assertIn("load: true", source)
        self.assertNotIn("cache-to: type=gha,scope=mv3c-build", source)
        self.assertNotIn("docker system prune", source)

    def test_manifest_copy_is_before_dependencies_and_source_after(self):
        source = DOCKERFILE.read_text()
        block = source.split("FROM base AS prod-deps", 1)[1].split(
            "FROM base AS runtime", 1)[0]
        self.assertIn("COPY --chown=node:node package.json package-lock.json ./", block)
        self.assertIn("npm ci --omit=dev", block)
        self.assertNotIn("COPY --chown=node:node . .", block)
        self.assertNotIn("RUN npm run frontend", block)

    def test_release_verification_stays_after_both_build_paths(self):
        source = WORKFLOW.read_text()
        fallback = source.index("      - name: Build version-bound runtime in Actions")
        cached = source.index("      - name: Build version-bound runtime with persistent")
        health = source.index("      - name: Smoke-test exact versioned image")
        image = source.index("      - name: Verify OCI revision/version/source")
        proof = source.index("      - name: Record protected archive/image proof")
        self.assertLess(cached, fallback)
        self.assertLess(fallback, health)
        self.assertLess(health, image)
        self.assertLess(image, proof)


if __name__ == "__main__":
    unittest.main()
