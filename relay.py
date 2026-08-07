#!/usr/bin/env python3
"""Mailbox relay for agent-to-agent messaging (email-style, multi-party).

Auth is enforced by the hostd gateway (auth: bearer); this process is
loopback-only. Stdlib only — no dependencies.

Concepts:
  - A *box* is a named mailbox, auto-created on first use. Names: [a-z0-9-_]{1,32}.
  - A message is addressed to one or more boxes via `to` (primary recipients)
    and optionally `cc` (carbon copies). Every recipient gets the same
    envelope, which shows the full addressing — exactly like email headers.
  - `from` is the sender's stable box name (reply address). `alias` is a
    display name attached per message; senders may change it any time and
    the new name simply shows up on subsequent messages.

Endpoints:
  GET  /                 this documentation (self-describing; start here)
  GET  /health           liveness (used by the platform probe)
  POST /send             JSON {from, alias?, to, cc?, body}; `to`/`cc` are a
                         box name or list of box names
  GET  /poll?box=X&wait=N   long-poll X's mailbox; drains and returns messages
  GET  /peek?box=X       look without taking
  GET  /boxes            active boxes with pending counts

Envelope: {"id": n, "ts": iso8601, "from": box, "alias": str, "to": [...],
           "cc": [...], "body": str}

Long-poll wait defaults to 25s, capped at 55s.
"""
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# Auth happens at the hostd gateway (auth: bearer); this process is loopback-only.
PORT = int(os.environ.get("PORT", os.environ.get("RELAY_PORT", "8790")))
HOST = "127.0.0.1" if os.environ.get("PORT") else "0.0.0.0"
MAX_BODY = 256 * 1024
MAX_QUEUE = 500
MAX_BOXES = 200
BOX_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

USAGE = {
    "service": "cloud-bridge-relay",
    "detail": ("Email-style mailbox relay between agent sessions. A box is a "
               "named mailbox, auto-created on first use. Address a message "
               "to one or more boxes with `to`, copy others with `cc`. Poll "
               "your own box to receive. Identity has two layers: `from` is "
               "your stable box name — machines use it to reply and to "
               "identify you; `alias` is your SESSION NAME, attached to every "
               "message purely for the human reading the traffic. Session "
               "names get renamed mid-flight, so send your current one each "
               "time — never cache another sender's alias, and never route "
               "by it."),
    "endpoints": {
        "GET /": "this document",
        "POST /send": ("JSON {from, alias?, to, cc?, body}. `to`/`cc`: box "
                       "name or list. Delivers one envelope to every "
                       "recipient's box."),
        "GET /poll?box=X&wait=N": ("long-poll box X (N<=55s, default 25); "
                                   "returns {messages:[...]} and removes them"),
        "GET /peek?box=X": "like poll but non-destructive and no wait",
        "GET /boxes": "active boxes with pending message counts",
    },
    "envelope": {"id": "int", "ts": "iso8601", "from": "sender box (stable id; reply here)",
                 "alias": "sender's current session name (display only)",
                 "to": ["boxes"], "cc": ["boxes"], "body": "string"},
    "example": ('curl -s -X POST .../send -H "Authorization: Bearer $CRED" '
                '-H "Content-Type: application/json" -d \'{"from":"manager",'
                '"alias":"MWG manager","to":"mac","body":"hello"}\''),
    "box_name_rule": "[a-z0-9][a-z0-9_-]{0,31}",
}


class Box:
    def __init__(self):
        self.items = []
        self.cond = threading.Condition()

    def push(self, env):
        with self.cond:
            if len(self.items) >= MAX_QUEUE:
                self.items.pop(0)
            self.items.append(env)
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


boxes: dict = {}
boxes_lock = threading.Lock()
id_lock = threading.Lock()
next_id = 1


def get_box(name, create=True):
    with boxes_lock:
        b = boxes.get(name)
        if b is None and create:
            if len(boxes) >= MAX_BOXES:
                return None
            b = boxes[name] = Box()
        return b


def as_box_list(v):
    """Normalize a box-name-or-list into a validated list, or None on error."""
    if v is None:
        return []
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        return None
    if any(not BOX_RE.match(x) for x in v):
        return None
    return list(dict.fromkeys(v))  # dedupe, keep order


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _query(self):
        return parse_qs(urlparse(self.path).query)

    def _wait_param(self, q):
        try:
            return min(max(int(q.get("wait", ["25"])[0]), 0), 55)
        except ValueError:
            return 25

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            return self._send(200, USAGE)
        if path == "/health":
            return self._send(200, {"ok": True})
        if path in ("/poll", "/peek"):
            q = self._query()
            name = q.get("box", [""])[0]
            if not BOX_RE.match(name):
                return self._send(400, {"error": "bad_box",
                                        "detail": USAGE["box_name_rule"]})
            b = get_box(name)
            if b is None:
                return self._send(507, {"error": "too_many_boxes"})
            if path == "/poll":
                return self._send(200, {"messages": b.drain(self._wait_param(q))})
            return self._send(200, {"messages": b.peek()})
        if path == "/boxes":
            with boxes_lock:
                stats = {n: len(b.items) for n, b in sorted(boxes.items())}
            return self._send(200, {"boxes": stats})
        return self._send(404, {"error": "not_found", "detail": "GET / lists endpoints"})

    def do_POST(self):
        global next_id
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            self.close_connection = True
            return self._send(413, {"error": "body_too_large"})
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        if path != "/send":
            return self._send(404, {"error": "not_found", "detail": "POST /send only"})
        try:
            msg = json.loads(raw)
            assert isinstance(msg, dict)
        except Exception:
            return self._send(400, {"error": "bad_json",
                                    "detail": "body must be a JSON object; GET / for the shape"})
        sender = msg.get("from", "")
        if not isinstance(sender, str) or not BOX_RE.match(sender):
            return self._send(400, {"error": "bad_from", "detail": USAGE["box_name_rule"]})
        to = as_box_list(msg.get("to"))
        cc = as_box_list(msg.get("cc"))
        if to is None or cc is None or not to:
            return self._send(400, {"error": "bad_recipients",
                                    "detail": "`to` required; `to`/`cc` are a box name or list"})
        body = msg.get("body", "")
        if not isinstance(body, str) or not body.strip():
            return self._send(400, {"error": "empty_body"})
        alias = msg.get("alias", "")
        if not isinstance(alias, str):
            alias = str(alias)
        with id_lock:
            mid = next_id
            next_id += 1
        env = {
            "id": mid,
            "ts": datetime.now(timezone.utc).isoformat(),
            "from": sender,
            "alias": alias[:200],
            "to": to,
            "cc": [c for c in cc if c not in to],
            "body": body,
        }
        recipients = env["to"] + env["cc"]
        for name in recipients:
            b = get_box(name)
            if b is None:
                return self._send(507, {"error": "too_many_boxes"})
            b.push(env)
        return self._send(200, {"ok": True, "id": mid, "delivered_to": recipients})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"relay v2 listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
