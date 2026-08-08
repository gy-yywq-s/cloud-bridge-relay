#!/usr/bin/env python3
"""crew sidecar for Codex: push-style mail delivery via codex app-server.

Spawns `codex app-server` (JSON-RPC over stdio, JSONL), starts/resumes a
thread, then long-polls crew for mail addressed to this box. Each message is
delivered into the codex session:

  - if a turn is in flight  -> turn/steer (injected at the next step)
  - if the thread is idle   -> turn/start (begins a new turn)

Mail is acked on crew ONLY after codex accepted the input, so a crash
anywhere re-delivers instead of losing mail. Stdlib only.

Env:
  RELAY_URL    e.g. https://relay.gaelis.cc
  RELAY_TOKEN  hostd credential
  RELAY_BOX    this session's box name
  RELAY_POOL   4-digit pool code (for first-time registration)
  RELAY_ENV    one-line runtime description  (default "codex / local")
  CODEX_THREAD resume an existing thread id (optional; default: new thread)
  CODEX_CWD    working directory for the thread (default: current dir)
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

RELAY_URL = os.environ["RELAY_URL"].rstrip("/")
TOKEN = os.environ["RELAY_TOKEN"]
# Box ids are server-assigned; persist ours so restarts keep the same address.
ID_FILE = os.path.expanduser("~/.crew_box_id_codex")
BOX = os.environ.get("RELAY_BOX", "")
if not BOX and os.path.exists(ID_FILE):
    BOX = open(ID_FILE).read().strip()
POOL = os.environ.get("RELAY_POOL", "")
RENV = os.environ.get("RELAY_ENV", "codex / local")
UA = "crew-codex-sidecar/1"


def relay(path, payload=None, timeout=70):
    req = urllib.request.Request(
        RELAY_URL + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": UA,
                 **({"Content-Type": "application/json"} if payload is not None else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


class Codex:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["codex", "app-server"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            bufsize=1)
        self.next_id = 1
        self.pending = {}          # id -> threading.Event + slot
        self.lock = threading.Lock()
        self.active_turn = None    # turn id while a turn is in flight
        self.thread_id = None
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                with self.lock:
                    slot = self.pending.pop(msg["id"], None)
                if slot:
                    slot["msg"] = msg
                    slot["ev"].set()
            elif msg.get("method") == "turn/started":
                self.active_turn = msg["params"]["turn"]["id"]
            elif msg.get("method") in ("turn/completed", "turn/failed"):
                self.active_turn = None

    def request(self, method, params, timeout=60):
        with self.lock:
            rid = self.next_id
            self.next_id += 1
            slot = {"ev": threading.Event(), "msg": None}
            self.pending[rid] = slot
        self.proc.stdin.write(json.dumps(
            {"id": rid, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        if not slot["ev"].wait(timeout):
            raise TimeoutError(method)
        if "error" in slot["msg"]:
            raise RuntimeError(f"{method}: {slot['msg']['error']}")
        return slot["msg"]["result"]

    def notify(self, method, params=None):
        self.proc.stdin.write(json.dumps(
            {"method": method, **({"params": params} if params else {})}) + "\n")
        self.proc.stdin.flush()

    def start(self):
        self.request("initialize", {"clientInfo": {
            "name": "crew_sidecar", "title": "crew sidecar", "version": "1.0"}})
        self.notify("initialized")
        tid = os.environ.get("CODEX_THREAD")
        if tid:
            r = self.request("thread/resume", {"threadId": tid})
        else:
            r = self.request("thread/start",
                             {"cwd": os.environ.get("CODEX_CWD", os.getcwd())})
        self.thread_id = r["thread"]["id"]
        print(f"[sidecar] codex thread {self.thread_id}", flush=True)

    def deliver(self, text):
        """Steer if a turn is active, else start a new turn. True = accepted."""
        turn = self.active_turn
        if turn:
            try:
                self.request("turn/steer", {
                    "threadId": self.thread_id, "expectedTurnId": turn,
                    "input": [{"type": "text", "text": text}]})
                return True
            except RuntimeError:
                pass  # turn just ended; fall through to turn/start
        self.request("turn/start", {
            "threadId": self.thread_id,
            "input": [{"type": "text", "text": text}]})
        return True


def render(m):
    f = m.get("from", {})
    head = (f"<crew-mail id={m['id']} kind={m['kind']} "
            f"delivered_as={m['delivered_as']} from={f.get('box')} "
            f"({f.get('display_name')}, {f.get('role') or 'no-role'}, "
            f"{f.get('platform')}) to={','.join(m.get('to', []))} "
            f"cc={','.join(m.get('cc', []))}>")
    parts = [head, m.get("directive", ""), "", m.get("body", "")]
    if m.get("team_info"):
        parts += ["", m["team_info"]]
    parts.append("</crew-mail>")
    return "\n".join(parts)


def main():
    cx = Codex()
    cx.start()
    global BOX
    if POOL:
        try:
            payload = {"platform": "codex", "environment": RENV,
                       "pool_code": POOL,
                       "session_name": os.environ.get("RELAY_NAME", "")}
            if BOX:
                payload["box_id"] = BOX
            r = relay("/register", payload)
            print("[sidecar] register:", r, flush=True)
            if r.get("ok") and r.get("box") and r["box"] != BOX:
                BOX = r["box"]
                open(ID_FILE, "w").write(BOX)
                print(f"[sidecar] assigned box id {BOX} (saved)", flush=True)
        except Exception as e:
            print(f"[sidecar] register failed: {e}", flush=True)
    if not BOX:
        sys.exit("no box id: set RELAY_POOL to register or RELAY_BOX to reuse one")
    while True:
        try:
            out = relay(f"/checkmail?box={BOX}&wait=50")
            msgs = out.get("messages", [])
            if not msgs:
                continue
            for m in sorted(msgs, key=lambda x: x["id"]):
                cx.deliver(render(m))
                relay("/ack", {"box": BOX, "through_id": m["id"]})
                print(f"[sidecar] delivered+acked #{m['id']}", flush=True)
        except Exception as e:
            print(f"[sidecar] {e}", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    main()
