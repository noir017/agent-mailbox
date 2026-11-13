#!/usr/bin/env python3
"""Agent-side helper for an agent-mailbox relay (custom.agent-mailbox connector).

Commands:
  ping                                    harmless read: which mailbox this credential opens
  inbox [--after N] [--limit N]           messages for the agent; --after confirms up to N
  progress [TEXT]                         a status line for the open turn
  final [TEXT]                            the answer for the open turn; ends it
  message --session S [TEXT]              text outside a turn, for session S
  reply --session S --type T [--turn X]   the long form of the three above
        (--text TEXT | --text-file PATH | --text -)
progress, final and message read TEXT from stdin when it is not given (`final <<'EOF' … EOF`), and
take --session/--turn to pick a turn when more than one is open. bin/mbx is this script under a
shorter name, linked as ~/mbx.

The open turns: `inbox` notes each message it hands over in ~/.agent-mailbox/turns.json, and a
final removes it, so the agent need not copy ids into every reply. A gateway runs one turn per
session at a time, so a new message replaces its session's older turn; a turn idle for
OPEN_TTL_SECS is dropped. With exactly one turn open, progress and final go to it; with none or
several they refuse rather than guess (AGENT_MAILBOX_TURNS overrides the path, for tests).

The relay token never appears here. It comes from dynamic_credentials as an hsurr: surrogate,
which Muse swaps for the real token only on an approved request to the registered host. The
surrogate is placed as-is: percent-encoding its colon breaks the swap (the Telegram bridge this
is adapted from measured a 404 that way, 2026-11-03).

Settings live in config.json next to bin/ (or the file AGENT_MAILBOX_CONFIG names):
  {"base_url": "https://mailbox.example.com", "placement": "bearer" | "path"}
"placement" must match how the credential was registered: an Authorization: Bearer header, or
the path segment /agent{}.
"""
import argparse
import fcntl
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CREDENTIAL = "custom.agent-mailbox"
CONFIG = os.environ.get("AGENT_MAILBOX_CONFIG") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json"
)
TURNS = os.environ.get("AGENT_MAILBOX_TURNS") or os.path.expanduser("~/.agent-mailbox/turns.json")
# Longer than the gateway waits on a quiet turn (5 minutes after pickup), so a turn is never
# dropped while the gateway still listens for it, yet a turn nobody finished does not linger.
OPEN_TTL_SECS = 15 * 60
TIMEOUT = 20
# The relay refuses texts over its MAX_TEXT_CHARS (16000 by default); stay under it and split.
CHUNK = 15000
PROGRESS_MAX = 2000


class Fail(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise Fail("redirect refused, check base_url")


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except OSError as exc:
        raise Fail(f"cannot read {CONFIG}: {exc.strerror}")
    except ValueError:
        raise Fail(f"{CONFIG} is not valid JSON")
    base = str(cfg.get("base_url", "")).rstrip("/")
    placement = cfg.get("placement", "bearer")
    parts = urllib.parse.urlsplit(base)
    if parts.scheme != "https" and not (parts.scheme == "http" and is_loopback(parts.hostname)):
        raise Fail("base_url must be https (plain http only for a local test relay)")
    if not parts.hostname or parts.query or parts.fragment:
        raise Fail("base_url must be scheme://host[/prefix] with no query")
    if placement not in ("bearer", "path"):
        raise Fail('placement must be "bearer" or "path"')
    return base, placement


def is_loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


def surrogate():
    value = str(dynamic_credential_entry(CREDENTIAL)["surrogate"]).strip()
    if not value or any(c in value for c in "/?#") or any(c.isspace() for c in value):
        raise Fail("the credential placeholder cannot go into a URL; reconnect the credential")
    return value


def build_request(op, query=None, payload=None):
    base, placement = load_config()
    token = surrogate()
    if placement == "path":
        # Raw, never quoted: see the module docstring.
        url = f"{base}/agent{token}/{op}"
        headers = {}
    else:
        url = f"{base}/agent/{op}"
        headers = {"Authorization": f"Bearer {token}"}
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    # Not urllib's default: Cloudflare's Browser Integrity Check answers Python-urllib/x.y with 403
    # (error 1010) on a relay whose zone has it on (measured 2026-11-13).
    headers["User-Agent"] = "agent-mailbox-helper/1"
    return urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")


def call(op, query=None, payload=None):
    request = build_request(op, query, payload)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=TIMEOUT) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read() or b"{}").get("error", "")
        except ValueError:
            pass
        raise Fail(f"HTTP {exc.code}" + (f": {detail}" if detail else ""), exc.code)
    except urllib.error.URLError as exc:
        raise Fail(f"cannot reach the relay: {exc.reason}")
    try:
        return json.loads(body)
    except ValueError:
        raise Fail("the relay answered something that is not JSON")


def split_text(text, limit=CHUNK):
    """Chunks of at most `limit` characters, cut at paragraph, then line, then anywhere."""
    chunks = []
    while len(text) > limit:
        window = text[:limit]
        cut = window.rfind("\n\n")
        if cut >= limit // 2:
            cut += 2
        else:
            cut = window.rfind("\n")
            cut = cut + 1 if cut >= limit // 2 else limit
        chunks.append(text[:cut])
        text = text[cut:]
    if text:
        chunks.append(text)
    return chunks


def reply(session, kind, turn, text):
    """Send one reply, split if long. A long final goes out as messages plus a last final."""
    if not text:
        raise Fail("empty text")
    if kind == "progress":
        if len(text) > PROGRESS_MAX:
            text = text[: PROGRESS_MAX - 1] + "…"
        parts = [(kind, text)]
    else:
        chunks = split_text(text)
        parts = [("message", c) for c in chunks[:-1]] + [(kind, chunks[-1])]
    seqs = []
    for part_kind, part in parts:
        payload = {"session": session, "type": part_kind, "text": part}
        if turn:
            payload["turn"] = turn
        seqs.append(call("reply", payload=payload).get("seq"))
    return {"ok": True, "seqs": seqs}


class OpenTurns:
    """The turns handed to the agent and not yet finished, under a lock (hook and agent both write)."""

    def __init__(self):
        os.makedirs(os.path.dirname(TURNS), mode=0o700, exist_ok=True)
        self.lock = open(TURNS + ".lock", "a")
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.now = time.time()
        try:
            with open(TURNS, encoding="utf-8") as fh:
                raw = json.load(fh).get("open", [])
        except (OSError, ValueError, AttributeError):
            raw = []
        self.turns = [
            t for t in raw
            if isinstance(t, dict) and t.get("session") and t.get("turn")
            and self.now - float(t.get("at", 0)) < OPEN_TTL_SECS
        ]
        self.changed = len(self.turns) != len(raw)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if self.changed:
            tmp = TURNS + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"open": self.turns}, fh)
            os.replace(tmp, TURNS)
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()

    def fetched(self, messages):
        for m in messages:
            if m.get("type") != "message":
                continue  # a cancel keeps its turn open: the agent still owes it a final
            self.turns = [t for t in self.turns if t["session"] != m.get("session")]
            self.turns.append({"session": m.get("session"), "turn": m.get("turn"), "at": self.now})
            self.changed = True

    def pick(self, session, turn):
        if turn:
            if session:
                return session, turn
            match = [t for t in self.turns if t["turn"] == turn]
            if len(match) == 1:
                return match[0]["session"], turn
            raise Fail(f"turn {turn} is not open here: pass --session too")
        open_ = [t for t in self.turns if not session or t["session"] == session]
        if len(open_) == 1:
            return open_[0]["session"], open_[0]["turn"]
        if not open_:
            raise Fail("no open turn: pass --session and --turn")
        listed = ", ".join(f"--session {t['session']} --turn {t['turn']}" for t in open_)
        raise Fail(f"several turns are open, pass one of: {listed}")

    def touch(self, session, turn):
        for t in self.turns:
            if t["session"] == session and t["turn"] == turn:
                t["at"] = self.now
                self.changed = True

    def close(self, session, turn):
        before = len(self.turns)
        self.turns = [t for t in self.turns if not (t["session"] == session and t["turn"] == turn)]
        self.changed = self.changed or len(self.turns) != before


def short_reply(kind, session, turn, text):
    """progress / final / message without ids when one turn is open."""
    if text is None:
        if sys.stdin.isatty():
            raise Fail("give the text, or pipe it in: final <<'EOF' ... EOF")
        text = sys.stdin.read()
    if kind == "message" and not session:
        raise Fail("message needs --session")
    try:
        turns = OpenTurns()
    except OSError as exc:
        # Ids given: the bookkeeping is a convenience, not a condition for sending.
        if kind != "message" and not (session and turn):
            raise Fail(f"open turns not available ({exc}): pass --session and --turn")
        turns = None
    if turns is None:
        result = reply(session, kind, turn, text)
    else:
        with turns:
            if kind != "message":
                session, turn = turns.pick(session, turn)
            result = reply(session, kind, turn, text)
            if kind == "final":
                turns.close(session, turn)
            elif kind == "progress":
                turns.touch(session, turn)
    result["session"] = session
    if turn:
        result["turn"] = turn
    return result


def read_text(args):
    if args.text_file:
        with open(args.text_file, encoding="utf-8") as fh:
            return fh.read()
    if args.text == "-":
        return sys.stdin.read()
    return args.text or ""


def main():
    parser = argparse.ArgumentParser(description="agent-mailbox helper")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("ping")
    p_inbox = sub.add_parser("inbox")
    p_inbox.add_argument("--after", type=int, default=None)
    p_inbox.add_argument("--limit", type=int, default=None)
    for name in ("progress", "final", "message"):
        p_short = sub.add_parser(name)
        p_short.add_argument("text", nargs="?", default=None)
        p_short.add_argument("--session", default=None)
        p_short.add_argument("--turn", default=None)
    p_reply = sub.add_parser("reply")
    p_reply.add_argument("--session", required=True)
    p_reply.add_argument("--type", required=True, choices=["progress", "final", "message"])
    p_reply.add_argument("--turn", default=None)
    group = p_reply.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--text-file")
    args = parser.parse_args()

    try:
        if args.command == "ping":
            result = call("ping")
        elif args.command == "inbox":
            query = {}
            if args.after is not None:
                query["after"] = args.after
            if args.limit is not None:
                query["limit"] = args.limit
            result = call("inbox", query=query)
            if result.get("messages"):
                # Bookkeeping only: if it cannot be written, the messages still go to the agent,
                # which then answers with explicit ids instead of ~/mbx's defaults.
                try:
                    with OpenTurns() as turns:
                        turns.fetched(result["messages"])
                except OSError as exc:
                    print(json.dumps({"warning": f"open turns not recorded: {exc}"}), file=sys.stderr)
        elif args.command in ("progress", "final", "message"):
            result = short_reply(args.command, args.session, args.turn, args.text)
        else:
            if args.type != "message" and not args.turn:
                raise Fail(f"--type {args.type} needs --turn")
            result = reply(args.session, args.type, args.turn, read_text(args))
            if args.type == "final":
                with OpenTurns() as turns:
                    turns.close(args.session, args.turn)
    except Fail as exc:
        print(json.dumps({"ok": False, "error": str(exc), "status": exc.status}), file=sys.stderr)
        sys.exit(1)
    except OSError as exc:
        print(json.dumps({"ok": False, "error": f"open turns: {exc}", "status": None}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
