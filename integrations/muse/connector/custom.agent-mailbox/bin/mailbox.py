#!/usr/bin/env python3
"""Agent-side helper for an agent-mailbox relay (custom.agent-mailbox connector).

Commands:
  ping                                    harmless read: which mailbox this credential opens
  inbox [--after N] [--limit N]           messages for the agent; --after confirms up to N
  reply --session S --type T [--turn X]   send progress / final / message
        (--text TEXT | --text-file PATH | --text -)

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
import ipaddress
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

CREDENTIAL = "custom.agent-mailbox"
CONFIG = os.environ.get("AGENT_MAILBOX_CONFIG") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json"
)
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
        else:
            if args.type != "message" and not args.turn:
                raise Fail(f"--type {args.type} needs --turn")
            result = reply(args.session, args.type, args.turn, read_text(args))
    except Fail as exc:
        print(json.dumps({"ok": False, "error": str(exc), "status": exc.status}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
