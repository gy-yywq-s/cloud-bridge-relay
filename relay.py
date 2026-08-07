#!/usr/bin/env python3
"""Message relay between a cloud Claude Code session (manager) and a Mac-local
session (worker). Stdlib only — no dependencies.

Endpoints (authentication is enforced by the hostd gateway, auth: bearer):
  POST /to-mac          manager pushes an instruction for the Mac
  GET  /to-mac/poll     Mac long-polls; drains and returns pending instructions
  POST /from-mac        Mac pushes a reply/report for the manager
  GET  /from-mac/poll   manager long-polls; drains and returns pending replies
  GET  /from-mac/peek   like poll but non-destructive, no wait
  GET  /health          no auth; liveness check

Poll responses: {"messages": [{"id": n, "ts": "...", "body": "..."}]}
Long-poll wait defaults to 25s, capped at 55s (?wait=N).
"""
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Auth happens at the hostd gateway (auth: bearer); this process is loopback-only.
PORT = int(os.environ.get("PORT", os.environ.get("RELAY_PORT", "8790")))
HOST = "127.0.0.1" if os.environ.get("PORT") else "0.0.0.0"
MAX_BODY = 256 * 1024
MAX_QUEUE = 500

class Queue:
    def __init__(self):
        self.items = []
        self.next_id = 1
        self.cond = threading.Condition()

    def push(self, body):
        with self.cond:
            if len(self.items) >= MAX_QUEUE:
                self.items.pop(0)
            self.items.append({
                "id": self.next_id,
                "ts": datetime.now(timezone.utc).isoformat(),
                "body": body,
            })
            self.next_id += 1
            self.cond.notify_all()

    def drain(self, wait_s):
        deadline = time.monotonic() + wait_s
        with self.cond:
            while not self.items:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return []
                self.cond.wait(remaining)
            out, self.items = self.items, []
            return out

    def peek(self):
        with self.cond:
            return list(self.items)


to_mac = Queue()
from_mac = Queue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _wait_param(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        try:
            return min(max(int(q.get("wait", ["25"])[0]), 0), 55)
        except ValueError:
            return 25

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            return self._send(200, {"ok": True})
        if path == "/to-mac/poll":
            return self._send(200, {"messages": to_mac.drain(self._wait_param())})
        if path == "/from-mac/poll":
            return self._send(200, {"messages": from_mac.drain(self._wait_param())})
        if path == "/from-mac/peek":
            return self._send(200, {"messages": from_mac.peek()})
        if path == "/to-mac/peek":
            return self._send(200, {"messages": to_mac.peek()})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            self.close_connection = True
            return self._send(413, {"error": "body too large"})
        body = self.rfile.read(length).decode("utf-8", errors="replace")
        if not body.strip():
            return self._send(400, {"error": "empty body"})
        if path == "/to-mac":
            to_mac.push(body)
            return self._send(200, {"ok": True, "queued_for": "mac"})
        if path == "/from-mac":
            from_mac.push(body)
            return self._send(200, {"ok": True, "queued_for": "manager"})
        return self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"relay listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
