"""Updater heartbeat must be observability-only, not a second terminal owner."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]

class HeartbeatContract(unittest.TestCase):
    def test_bridge_exposes_scoped_heartbeat(self):
        source = (ROOT / "mv3c/updater/bridge.cjs").read_text(encoding="utf-8")
        self.assertIn("'heartbeat'", source)
        self.assertIn("updates.heartbeatJob(payload)", source)

    def test_database_does_not_change_terminal_or_progress(self):
        source = (ROOT / "api/server/services/Config/mv3cUpdater.js").read_text(encoding="utf-8")
        method = re.search(r"async function heartbeatJob\(payload\) \{(.*?)\n\}", source, re.S)
        self.assertIsNotNone(method)
        body = method.group(1)
        self.assertIn("'activeJob.id': payload.jobId", body)
        self.assertIn("agentHeartbeat: new Date()", body)
        self.assertNotIn("'activeJob.progress", body)
        self.assertNotIn("completeJob(", body)
        self.assertNotIn("status:", body)

    def test_host_heartbeat_is_bounded_and_nonterminal(self):
        source = (ROOT / "mv3c/updater/agent.py").read_text(encoding="utf-8")
        self.assertIn('bridge(repo, "heartbeat", {"jobId": job["id"]})', source)
        self.assertIn("heartbeat_stop.wait(40)", source)
        self.assertIn("heartbeat_stop.set()", source)
        self.assertIn("heartbeat_thread.join(timeout=2)", source)

    def test_ui_does_not_suggest_reinstall_while_task_pending(self):
        source = (ROOT / "client/src/routes/Mv3cAdmin.tsx").read_text(encoding="utf-8")
        self.assertIn("!updates.agentOnline && (updates.activeJob || updates.pendingJob)", source)
        self.assertIn("!updates.agentOnline && !updates.activeJob && !updates.pendingJob", source)

if __name__ == "__main__":
    unittest.main()
