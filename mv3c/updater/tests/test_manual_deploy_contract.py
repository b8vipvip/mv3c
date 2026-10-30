"""Regression contract: release discovery may be scheduled, deployment may not.

Static checks complement backend runtime tests and ensure the host runner,
bridge, and admin UI do not accidentally reintroduce an unattended path.
"""
from pathlib import Path
import unittest

UPDATER = Path(__file__).resolve().parents[1]
ROOT = UPDATER.parents[1]


class ManualOnlyDeployContract(unittest.TestCase):
    def test_host_updater_cannot_auto_queue_a_release(self):
        agent = (UPDATER / "agent.py").read_text(encoding="utf-8")
        self.assertNotIn('bridge(repo, "queue-auto")', agent)
        self.assertNotIn('autoDeployEnabled', agent)
        self.assertIn('if job.get("mode") != "manual":', agent)
        self.assertIn('target_for_channel(repo, "release"', agent,
                      "scheduled version discovery must remain supported")

    def test_bridge_has_no_automatic_deploy_command(self):
        bridge = (UPDATER / "bridge.cjs").read_text(encoding="utf-8")
        self.assertNotIn("queue-auto", bridge)
        self.assertIn("case 'claim'", bridge)

    def test_web_api_rejects_automatic_mode_and_ui_hides_toggle(self):
        service = (ROOT / "api/server/services/Config/mv3cUpdater.js").read_text(
            encoding="utf-8")
        ui = (ROOT / "client/src/routes/Mv3cAdmin.tsx").read_text(
            encoding="utf-8")
        self.assertIn("if (mode !== 'manual')", service)
        self.assertIn("'pendingJob.mode': 'manual'", service)
        self.assertNotIn("checked={updateConfig.autoDeployEnabled}", ui)
        self.assertNotIn("允许无人值守自动部署", ui)
        self.assertIn("自动检查 GitHub 正式版", ui)
        self.assertIn("检查并智能更新", ui)
        self.assertIn("唯一宿主机更新器", ui)


if __name__ == "__main__":
    unittest.main()
