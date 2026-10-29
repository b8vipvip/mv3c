"""Side-nav contract: native browser link menu is not hijacked by row actions.

Runs in the existing small Python CI suite even when optional client Jest tests
are not installed in the validator environment.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
CONVOS = ROOT / "client/src/components/Conversations"


class SidebarContextMenuContract(unittest.TestCase):
    def test_history_title_is_native_link(self):
        src = (CONVOS / "ConvoLink.tsx").read_text(encoding="utf-8")
        self.assertIn("<a", src)
        self.assertIn("href={conversationId ?", src)
        self.assertIn("/c/", src)
        self.assertIn('event.button === 0', src)
        self.assertIn("event.preventDefault()", src)
        self.assertNotIn('onContextMenu=', src)

    def test_chat_row_never_hijacks_browser_context_menu(self):
        row = (CONVOS / "Convo.tsx").read_text(encoding="utf-8")
        self.assertNotIn("onContextMenu=", row)
        self.assertNotIn("setContextMenuPosition", row)
        self.assertIn("conversationId={conversationId ?? null}", row)
        self.assertIn("<ConvoActions", row)

    def test_ellipsis_is_the_only_action_menu_anchor(self):
        menu = (CONVOS / "ConvoOptions/ConvoOptions.tsx").read_text(
            encoding="utf-8"
        )
        self.assertIn("<Ariakit.MenuButton", menu)
        self.assertNotIn("getAnchorRect=", menu)
        self.assertNotIn("contextMenuPosition", menu)


if __name__ == "__main__":
    unittest.main()
