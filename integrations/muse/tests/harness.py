"""Test harness: install the Muse package into a throwaway HOME and run it like Hatch would.

Nothing here talks to Muse. The real hook script runs under the fake Hatch runtime
(fake_hatch/runtime.sh), the real helper imports the fake dynamic_credentials, and SwapProxy
stands in for Muse's egress: it replaces the hsurr: placeholder with the real token, exactly
where the helper put it, and refuses to forward a request whose placeholder was percent-encoded.
"""
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
CONNECTOR = os.path.join(PACKAGE, "connector", "custom.agent-mailbox")
HOOK = os.path.join(PACKAGE, "hooks", "agent-mailbox.sh")
RUNTIME = os.path.join(HERE, "fake_hatch", "runtime.sh")
FAKE_CREDS = os.path.join(HERE, "fake_creds")
SURROGATE = "hsurr:e2e-placeholder-0001"


class Installed:
    """The connector and hook laid out under a fresh HOME, the way the install guide puts them."""

    def __init__(self, base_url, placement):
        self.root = tempfile.mkdtemp(prefix="mbx-muse-")
        self.home = os.path.join(self.root, "home")
        self.hatch = os.path.join(self.root, "hatch")
        os.makedirs(self.hatch)
        dest = os.path.join(self.home, "workspace", "custom-connectors", "custom.agent-mailbox")
        shutil.copytree(CONNECTOR, dest)
        with open(os.path.join(dest, "config.json"), "w", encoding="utf-8") as fh:
            json.dump({"base_url": base_url, "placement": placement}, fh)
        self.helper = os.path.join(dest, "bin", "mailbox.py")
        scripts = os.path.join(self.home, "hooks", "scripts")
        os.makedirs(scripts)
        self.hook = os.path.join(scripts, "agent-mailbox.sh")
        shutil.copy2(HOOK, self.hook)

    def env(self):
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": self.home,
            "PYTHONPATH": FAKE_CREDS,
            "FAKE_SURROGATE": SURROGATE,
            "HATCH_HOOK_RUNTIME": RUNTIME,
            "FAKE_HATCH_DIR": self.hatch,
        }
        return env

    def helper_run(self, *args, stdin=None):
        proc = subprocess.run(
            ["python3", self.helper, *args],
            env=self.env(), input=stdin, capture_output=True, text=True, timeout=60,
        )
        return proc

    def hook_run(self):
        """One Hatch tick: run the hook, return its decision. state.json persists between ticks."""
        result = os.path.join(self.hatch, "result.json")
        if os.path.exists(result):
            os.remove(result)
        proc = subprocess.run(["bash", self.hook], env=self.env(), capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            raise AssertionError(f"hook exited {proc.returncode}: {proc.stderr}")
        with open(result, encoding="utf-8") as fh:
            return json.load(fh)

    def state(self):
        path = os.path.join(self.hatch, "state.json")
        if not os.path.exists(path):
            return {}
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def logs(self):
        path = os.path.join(self.hatch, "log.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


class Stub:
    """A local HTTP server answering from a handler function, recording every request."""

    def __init__(self, respond):
        self.requests = []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                record = {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
                stub.requests.append(record)
                status, headers, payload = respond(record)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = _serve
            do_POST = _serve

            def log_message(self, *args):
                pass

        self.server = _Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class SwapProxy(Stub):
    """Muse's egress, played locally: swap the placeholder for the real token, then forward."""

    def __init__(self, upstream, token):
        self.seen_raw = 0
        self.seen_encoded = 0
        self.fail_next = 0

        def respond(req):
            if self.fail_next > 0:
                self.fail_next -= 1
                return 502, {"content-type": "application/json"}, b'{"ok":false,"error":"bad gateway"}'
            path = req["path"]
            headers = {}
            if "hsurr%3A" in path or "hsurr%3a" in path:
                # Muse would not recognise an encoded placeholder; the request would go out
                # with a value that opens nothing.
                self.seen_encoded += 1
            if SURROGATE in path:
                self.seen_raw += 1
                path = path.replace(SURROGATE, token)
            auth = req["headers"].get("Authorization") or req["headers"].get("authorization")
            if auth:
                if SURROGATE in auth:
                    self.seen_raw += 1
                headers["authorization"] = auth.replace(SURROGATE, token)
            if req["body"]:
                headers["content-type"] = "application/json"
            fwd = urllib.request.Request(upstream + path, data=req["body"] or None, headers=headers, method=req["method"])
            try:
                with urllib.request.urlopen(fwd, timeout=30) as resp:
                    return resp.status, {"content-type": "application/json"}, resp.read()
            except urllib.error.HTTPError as exc:
                return exc.code, {"content-type": "application/json"}, exc.read()

        super().__init__(respond)


def client(base, token, method, path, body=None):
    """The gateway's side, for driving a test: a plain call with the client token."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"authorization": f"Bearer {token}"}
    if data:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")
