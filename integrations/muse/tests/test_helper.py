"""The helper and the hook against a stub relay: placement, redirects, splitting, hook decisions.

Runs anywhere with python3, bash and jq; no relay, no network. The end-to-end run against a real
relay is test_e2e.py.
"""
import json
import time
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SURROGATE, Installed, Stub  # noqa: E402


def ok(body):
    return 200, {"content-type": "application/json"}, json.dumps(body).encode()


class HelperRequests(unittest.TestCase):
    def setUp(self):
        self.replies = []
        self.stub = Stub(self.respond)
        self.inbox = {"ok": True, "messages": [], "cursor": 0}

    def tearDown(self):
        self.stub.close()

    def respond(self, req):
        if req["path"].endswith("/redirect/ping") or "redirect" in req["path"]:
            return 302, {"location": "https://elsewhere.example.com/"}, b""
        if req["path"].endswith("/ping"):
            return ok({"ok": True, "mailbox": "demo", "role": "agent", "pending": 0})
        if "/inbox" in req["path"]:
            return ok(self.inbox)
        if req["path"].endswith("/reply"):
            body = json.loads(req["body"])
            if body["session"] == "gone":
                return 404, {"content-type": "application/json"}, b'{"ok":false,"error":"unknown session"}'
            self.replies.append(body)
            return ok({"ok": True, "seq": len(self.replies)})
        return 404, {}, b"{}"

    def install(self, placement, base=None):
        inst = Installed(base or self.stub.url, placement)
        self.addCleanup(inst.cleanup)
        return inst

    def test_path_placement_puts_the_placeholder_in_raw(self):
        inst = self.install("path")
        proc = inst.helper_run("ping")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["mailbox"], "demo")
        req = self.stub.requests[-1]
        self.assertEqual(req["path"], f"/agent{SURROGATE}/ping")
        self.assertNotIn("Authorization", req["headers"])

    def test_bearer_placement_uses_the_header(self):
        inst = self.install("bearer")
        self.assertEqual(inst.helper_run("ping").returncode, 0)
        req = self.stub.requests[-1]
        self.assertEqual(req["path"], "/agent/ping")
        self.assertEqual(req["headers"]["Authorization"], f"Bearer {SURROGATE}")

    def test_redirects_are_refused(self):
        inst = self.install("bearer", base=self.stub.url + "/redirect")
        proc = inst.helper_run("ping")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("redirect refused", json.loads(proc.stderr)["error"])
        self.assertEqual(len(self.stub.requests), 1)

    def test_plain_http_only_for_loopback(self):
        inst = self.install("bearer", base="http://mailbox.example.com")
        proc = inst.helper_run("ping")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("https", json.loads(proc.stderr)["error"])
        self.assertEqual(self.stub.requests, [])

    def test_inbox_passes_the_cursor(self):
        inst = self.install("path")
        inst.helper_run("inbox", "--after", "7", "--limit", "5")
        self.assertEqual(self.stub.requests[-1]["path"], f"/agent{SURROGATE}/inbox?after=7&limit=5")

    def test_long_final_is_split_into_messages_and_a_final(self):
        inst = self.install("bearer")
        text = ("paragraph " * 400 + "\n\n") * 6  # ~24k characters
        proc = inst.helper_run("reply", "--session", "s1", "--turn", "t1", "--type", "final", "--text", "-", stdin=text)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([r["type"] for r in self.replies], ["message", "final"])
        self.assertEqual("".join(r["text"] for r in self.replies), text)
        self.assertTrue(all(r["turn"] == "t1" and r["session"] == "s1" for r in self.replies))
        self.assertTrue(all(len(r["text"]) <= 15000 for r in self.replies))
        self.assertEqual(json.loads(proc.stdout), {"ok": True, "seqs": [1, 2]})

    def test_progress_is_cut_not_split(self):
        inst = self.install("bearer")
        inst.helper_run("reply", "--session", "s1", "--turn", "t1", "--type", "progress", "--text", "x" * 5000)
        self.assertEqual(len(self.replies), 1)
        self.assertEqual(len(self.replies[0]["text"]), 2000)

    def test_unprompted_message_has_no_turn(self):
        inst = self.install("bearer")
        inst.helper_run("reply", "--session", "s1", "--type", "message", "--text", "done in the background")
        self.assertNotIn("turn", self.replies[0])

    def test_final_needs_a_turn(self):
        inst = self.install("bearer")
        proc = inst.helper_run("reply", "--session", "s1", "--type", "final", "--text", "x")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(self.replies, [])

    def test_http_errors_come_back_as_json_on_stderr(self):
        inst = self.install("bearer")
        proc = inst.helper_run("reply", "--session", "gone", "--turn", "t", "--type", "final", "--text", "x")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stderr), {"ok": False, "error": "HTTP 404: unknown session", "status": 404})


class ShortCommands(unittest.TestCase):
    """~/mbx progress / final / message: the open turn is remembered, so no ids to copy."""

    def setUp(self):
        self.replies = []
        self.inbox = {"ok": True, "messages": [], "cursor": 0}
        self.stub = Stub(self.respond)
        self.inst = Installed(self.stub.url, "bearer")

    def tearDown(self):
        self.stub.close()
        self.inst.cleanup()

    def respond(self, req):
        if "/inbox" in req["path"]:
            return ok(self.inbox)
        if req["path"].endswith("/reply"):
            self.replies.append(json.loads(req["body"]))
            return ok({"ok": True, "seq": len(self.replies)})
        return 404, {}, b"{}"

    def deliver(self, *msgs):
        """The hook fetching these messages (it is the only caller of inbox)."""
        self.inbox = {"ok": True, "cursor": 9, "messages": [
            {"seq": i + 1, "session": s, "turn": t, "type": kind, "text": "x", "at": 1}
            for i, (s, t, kind) in enumerate(msgs)
        ]}
        self.assertEqual(self.inst.helper_run("inbox").returncode, 0)

    def mbx(self, *args, stdin=None, ok_=True):
        proc = self.inst.mbx_run(*args, stdin=stdin)
        if ok_:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        return json.loads(proc.stderr)["error"]

    def test_one_open_turn_needs_no_ids(self):
        self.deliver(("s1", "t1", "message"))
        self.assertEqual(self.inst.open_turns(), [("s1", "t1")])
        self.mbx("progress", "looking")
        out = self.mbx("final", stdin="the answer\nin two lines\n")
        self.assertEqual(out, {"ok": True, "seqs": [2], "session": "s1", "turn": "t1"})
        self.assertEqual(
            [(r["session"], r["turn"], r["type"], r["text"]) for r in self.replies],
            [("s1", "t1", "progress", "looking"), ("s1", "t1", "final", "the answer\nin two lines\n")],
        )
        # The final closed it: another one has nowhere to go.
        self.assertEqual(self.inst.open_turns(), [])
        self.assertIn("no open turn", self.mbx("final", "again", ok_=False))
        self.assertEqual(len(self.replies), 2)

    def test_several_open_turns_are_refused_not_guessed(self):
        self.deliver(("s1", "t1", "message"), ("s2", "t7", "message"))
        err = self.mbx("final", "which?", ok_=False)
        self.assertIn("several turns are open", err)
        self.assertIn("--session s2 --turn t7", err)
        self.assertEqual(self.replies, [])
        self.mbx("final", "for t7", "--turn", "t7")
        self.mbx("final", "for t1")  # now the only one
        self.assertEqual([(r["session"], r["turn"]) for r in self.replies], [("s2", "t7"), ("s1", "t1")])

    def test_a_new_message_replaces_its_sessions_older_turn(self):
        self.deliver(("s1", "t1", "message"))
        self.deliver(("s1", "t2", "message"))
        self.assertEqual(self.inst.open_turns(), [("s1", "t2")])

    def test_a_cancel_keeps_the_turn_open_for_its_final(self):
        self.deliver(("s1", "t1", "message"))
        self.deliver(("s1", "t1", "cancel"))
        self.assertEqual(self.inst.open_turns(), [("s1", "t1")])
        self.mbx("final", "stopped")
        self.assertEqual(self.replies[-1]["turn"], "t1")

    def test_a_turn_left_open_too_long_is_dropped(self):
        self.deliver(("s1", "t1", "message"))
        path = os.path.join(self.inst.home, ".agent-mailbox", "turns.json")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        data["open"][0]["at"] -= 16 * 60
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        self.assertIn("no open turn", self.mbx("progress", "late", ok_=False))

    def test_progress_keeps_a_long_turn_open(self):
        self.deliver(("s1", "t1", "message"))
        path = os.path.join(self.inst.home, ".agent-mailbox", "turns.json")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        data["open"][0]["at"] -= 14 * 60
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        self.mbx("progress", "still at it")
        with open(path, encoding="utf-8") as fh:
            self.assertGreater(json.load(fh)["open"][0]["at"], time.time() - 60)

    def test_message_needs_a_session_and_has_no_turn(self):
        self.assertIn("--session", self.mbx("message", "done", ok_=False))
        self.mbx("message", "--session", "s1", "background job finished")
        self.assertEqual(self.replies, [{"session": "s1", "type": "message", "text": "background job finished"}])

    def test_empty_text_is_refused(self):
        self.deliver(("s1", "t1", "message"))
        self.assertIn("empty text", self.mbx("final", ok_=False))
        self.assertEqual(self.inst.open_turns(), [("s1", "t1")])

    def test_unwritable_bookkeeping_does_not_stop_delivery(self):
        state = os.path.join(self.inst.home, ".agent-mailbox")
        os.makedirs(state)
        os.chmod(state, 0o500)
        try:
            self.inbox = {"ok": True, "cursor": 1, "messages": [{"seq": 1, "session": "s1", "turn": "t1", "type": "message", "text": "x", "at": 1}]}
            self.assertEqual(self.inst.hook_run()["action"], "wake")
            # Without the record, ~/mbx asks for ids; with them it still answers.
            self.assertIn("open turns not available", self.mbx("final", "x", ok_=False))
            self.mbx("final", "x", "--session", "s1", "--turn", "t1")
            self.assertEqual(self.replies[-1]["turn"], "t1")
        finally:
            os.chmod(state, 0o700)

    def test_the_long_form_final_closes_the_turn_too(self):
        self.deliver(("s1", "t1", "message"))
        proc = self.inst.helper_run("reply", "--session", "s1", "--turn", "t1", "--type", "final", "--text", "done")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.inst.open_turns(), [])


class HookDecisions(unittest.TestCase):
    def setUp(self):
        self.answer = ok({"ok": True, "messages": [], "cursor": 0})
        self.stub = Stub(lambda req: self.answer)
        self.inst = Installed(self.stub.url, "bearer")

    def tearDown(self):
        self.stub.close()
        self.inst.cleanup()

    def wait_left(self):
        """Seconds until the hook's next poll, as it stored it."""
        return self.inst.state()["next_at"] - time.time()

    def test_empty_inbox_stays_silent(self):
        self.assertEqual(self.inst.hook_run(), {"action": "silent", "reason": "no new mailbox messages"})
        self.assertEqual(set(self.inst.state()), {"next_at"})
        self.assertEqual(self.stub.requests[-1]["path"], "/agent/inbox")

    def test_a_tick_before_poll_after_sends_nothing(self):
        self.answer = ok({"ok": True, "messages": [], "cursor": 0, "poll_after": 30})
        self.inst.hook_run()
        self.assertTrue(27 <= self.wait_left() <= 29, self.wait_left())
        sent = len(self.stub.requests)
        self.assertEqual(self.inst.hook_run(due=False), {"action": "silent", "reason": "not due"})
        self.assertEqual(len(self.stub.requests), sent)
        # Once due, it polls again and takes the relay's new interval.
        self.answer = ok({"ok": True, "messages": [], "cursor": 0, "poll_after": 5})
        self.inst.hook_run()
        self.assertEqual(len(self.stub.requests), sent + 1)
        self.assertTrue(2 <= self.wait_left() <= 4, self.wait_left())
        # One second off the interval, so the 5 s hook tick after this one is due.
        self.inst.hook_run()
        self.assertEqual(len(self.stub.requests), sent + 2)

    def test_poll_after_is_bounded(self):
        for given, low, high in ((None, 2, 4), ("soon", 2, 4), (0, -2, 0), (100000, 297, 299)):
            body = {"ok": True, "messages": [], "cursor": 0}
            if given is not None:
                body["poll_after"] = given
            self.answer = ok(body)
            self.inst.hook_run()
            self.assertTrue(low <= self.wait_left() <= high, (given, self.wait_left()))

    def test_messages_wake_and_the_cursor_is_kept(self):
        msgs = [
            {"seq": 4, "session": "s1", "turn": "t1", "type": "message", "text": "hi", "at": 1},
            {"seq": 5, "session": "s1", "turn": "t1", "type": "cancel", "text": "", "at": 2},
        ]
        self.answer = ok({"ok": True, "messages": msgs, "cursor": 5})
        result = self.inst.hook_run()
        self.assertEqual(result["action"], "wake")
        self.assertEqual(
            result["payload"],
            {"messages": [{k: m[k] for k in ("seq", "session", "turn", "type", "text")} for m in msgs]},
        )
        self.assertEqual(self.inst.state()["cursor"], 5)
        self.assertEqual(self.inst.logs()[-1], {"event": "messages_received", "data": {"count": 2}})
        # The next tick confirms them.
        self.answer = ok({"ok": True, "messages": [], "cursor": 5})
        self.assertEqual(self.inst.hook_run()["action"], "silent")
        self.assertEqual(self.stub.requests[-1]["path"], "/agent/inbox?after=5")

    def test_a_failed_fetch_is_silent_and_keeps_the_cursor(self):
        # poll_after 0: due again at once, so the failing tick below really polls.
        self.answer = ok({"ok": True, "messages": [{"seq": 1, "session": "s", "turn": "1", "type": "message", "text": "x"}], "cursor": 1, "poll_after": 0})
        self.inst.hook_run()
        self.answer = (500, {"content-type": "application/json"}, b'{"ok":false}')
        before = self.inst.state()
        self.assertEqual(self.inst.hook_run(due=False), {"action": "silent", "reason": "mailbox fetch failed"})
        self.assertEqual(self.inst.state(), before)
        self.assertEqual(self.inst.logs()[-1], {"event": "fetch_failed", "data": {}})


if __name__ == "__main__":
    unittest.main()
