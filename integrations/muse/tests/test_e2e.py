"""End to end against a running relay: the real hook and helper, the fake Hatch runtime, and a
proxy playing Muse's credential swap. Both token placements.

Needs RELAY_URL, AGENT_TOKEN and CLIENT_TOKEN for one mailbox (test/e2e/run.mjs starts a local
`wrangler dev` relay and sets them). Skipped without them.
"""
import json
import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Installed, SwapProxy, client  # noqa: E402

RELAY = os.environ.get("RELAY_URL")
AGENT = os.environ.get("AGENT_TOKEN")
CLIENT = os.environ.get("CLIENT_TOKEN")


@unittest.skipUnless(RELAY and AGENT and CLIENT, "set RELAY_URL, AGENT_TOKEN, CLIENT_TOKEN (test/e2e/run.mjs does)")
class EndToEnd(unittest.TestCase):
    def drain(self):
        """Run the hook until the relay has nothing left for this install."""
        for _ in range(5):
            if self.inst.hook_run()["action"] == "silent":
                return
        self.fail("inbox did not drain")

    def run_for(self, placement):
        self.proxy = SwapProxy(RELAY, AGENT)
        self.inst = Installed(self.proxy.url, placement)
        self.addCleanup(self.proxy.close)
        self.addCleanup(self.inst.cleanup)
        session = f"e2e-{placement}-{uuid.uuid4().hex[:8]}"

        # ping through the swap
        proc = self.inst.helper_run("ping")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        mailbox = json.loads(proc.stdout)["mailbox"]
        self.drain()  # whatever an earlier run left

        # nothing to do: silent, no state written
        self.assertEqual(self.inst.hook_run()["action"], "silent")

        # one turn
        status, sent = client(RELAY, CLIENT, "POST", "/client/send", {"session": session, "turn": "t1", "type": "message", "text": "你好，Muse"})
        self.assertEqual(status, 200, sent)
        woke = self.inst.hook_run()
        self.assertEqual(woke["action"], "wake")
        self.assertEqual(woke["payload"]["messages"], [{"seq": sent["seq"], "session": session, "turn": "t1", "type": "message", "text": "你好，Muse"}])
        self.assertEqual(self.inst.state()["cursor"], sent["seq"])
        _, st = client(RELAY, CLIENT, "GET", "/client/status")
        self.assertGreaterEqual(st["agent"]["fetched_upto"], sent["seq"])
        self.assertIsNotNone(st["agent"]["last_poll_at"])

        # replies: progress, then a final long enough to be split
        answer = "\n\n".join(f"第{i}段：" + "内容" * 900 for i in range(10))
        for args, stdin in (
            (["--type", "progress", "--text", "在看"], None),
            (["--type", "final", "--text", "-"], answer),
        ):
            proc = self.inst.helper_run("reply", "--session", session, "--turn", "t1", *args, stdin=stdin)
            self.assertEqual(proc.returncode, 0, proc.stderr)
        _, got = client(RELAY, CLIENT, "GET", f"/client/replies?session={session}")
        types = [r["type"] for r in got["replies"]]
        self.assertEqual(types[0], "progress")
        self.assertEqual(types[-1], "final")
        self.assertTrue(set(types[1:-1]) <= {"message"} and len(types) >= 3, types)
        self.assertEqual("".join(r["text"] for r in got["replies"][1:]), answer)
        client(RELAY, CLIENT, "GET", f"/client/replies?session={session}&after={got['cursor']}")

        # the next tick confirms the message: nothing pending
        self.assertEqual(self.inst.hook_run()["action"], "silent")
        self.assertEqual(json.loads(self.inst.helper_run("ping").stdout)["pending"], 0)

        # a cancel for a fetched turn reaches the agent
        _, sent2 = client(RELAY, CLIENT, "POST", "/client/send", {"session": session, "turn": "t2", "type": "message", "text": "long job"})
        self.assertEqual(self.inst.hook_run()["action"], "wake")
        _, cancelled = client(RELAY, CLIENT, "POST", "/client/cancel", {"session": session, "turn": "t2"})
        self.assertEqual(cancelled["withdrawn"], 0)
        woke = self.inst.hook_run()
        self.assertEqual([(m["type"], m["turn"]) for m in woke["payload"]["messages"]], [("cancel", "t2")])

        # a message cancelled before pickup never reaches it
        client(RELAY, CLIENT, "POST", "/client/send", {"session": session, "turn": "t3", "type": "message", "text": "never mind"})
        _, withdrawn = client(RELAY, CLIENT, "POST", "/client/cancel", {"session": session, "turn": "t3"})
        self.assertEqual(withdrawn["withdrawn"], 1)
        self.drain()

        # a reply to a session nobody opened
        proc = self.inst.helper_run("reply", "--session", "nobody-" + session, "--turn", "t", "--type", "final", "--text", "x")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stderr)["status"], 404)

        # the relay is down for a tick: silent, cursor kept, next tick fine
        cursor = self.inst.state()["cursor"]
        self.proxy.fail_next = 1
        self.assertEqual(self.inst.hook_run(), {"action": "silent", "reason": "mailbox fetch failed"})
        self.assertEqual(self.inst.state()["cursor"], cursor)
        self.assertEqual(self.inst.hook_run()["action"], "silent")

        self.assertGreater(self.proxy.seen_raw, 0)
        self.assertEqual(self.proxy.seen_encoded, 0)
        return mailbox

    def test_bearer(self):
        self.run_for("bearer")

    def test_path(self):
        self.run_for("path")


if __name__ == "__main__":
    unittest.main()
