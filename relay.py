#!/usr/bin/env python3
"""Mailbox relay v3: MCP server + REST, SQLite-persistent, email-style.

Auth is enforced by the hostd gateway (auth: bearer); this process is
loopback-only.

Two ways in, same mailboxes:
  MCP (Streamable HTTP, endpoint /mcp): tools send_mail / check_mail /
      peek_mail / list_boxes — any MCP client discovers these natively.
  REST (unchanged from v2): GET /, /health, /poll, /peek, /boxes, POST /send.

Semantics:
  - A *box* is a named mailbox, auto-created on first use: [a-z0-9][a-z0-9_-]{0,31}
  - `from` = sender's stable box name (machines reply to and identify by it).
  - `alias` = sender's CURRENT SESSION NAME, attached per message, display
    only. Senders keep it in sync with their session title; never route by it.
  - `to` (act) and `cc` (FYI) — every recipient sees full addressing, plus
    `delivered_as`: "to" | "cc" so a cc copy is distinguishable at a glance.
  - Messages persist in SQLite under $HOSTD_DATA_DIR: a redeploy no longer
    loses queued mail. Delivered (drained) messages are kept, flagged, and
    pruned after PRUNE_DAYS.
"""
import asyncio
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

PORT = int(os.environ.get("PORT", os.environ.get("RELAY_PORT", "8790")))
DATA_DIR = Path(os.environ.get("HOSTD_DATA_DIR", str(Path.home() / ".relay_data")))
DB = DATA_DIR / "relay.db"
MAX_BODY = 256 * 1024
MAX_WAIT = 55
PRUNE_DAYS = 14
BOX_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

DATA_DIR.mkdir(parents=True, exist_ok=True)
_local = threading.local()


def db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _local.conn = sqlite3.connect(DB)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.row_factory = sqlite3.Row
    return conn


def init_db():
    c = sqlite3.connect(DB)
    c.executescript("""
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, sender TEXT NOT NULL, alias TEXT NOT NULL,
      to_json TEXT NOT NULL, cc_json TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(
      msg_id INTEGER NOT NULL REFERENCES messages(id),
      recipient TEXT NOT NULL, delivered_as TEXT NOT NULL,
      taken_ts TEXT, PRIMARY KEY (msg_id, recipient));
    CREATE INDEX IF NOT EXISTS idx_deliv_pending
      ON deliveries(recipient) WHERE taken_ts IS NULL;
    CREATE TABLE IF NOT EXISTS boxes(
      box TEXT PRIMARY KEY, alias TEXT NOT NULL DEFAULT '',
      created_ts TEXT NOT NULL, last_seen TEXT NOT NULL);
    """)
    c.commit()
    c.close()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def as_box_list(v):
    if v is None:
        return []
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        return None
    if any(not BOX_RE.match(x) for x in v):
        return None
    return list(dict.fromkeys(v))


def envelope(row, drow):
    return {"id": row["id"], "ts": row["ts"], "from": row["sender"],
            "alias": row["alias"], "to": json.loads(row["to_json"]),
            "cc": json.loads(row["cc_json"]), "delivered_as": drow["delivered_as"],
            "body": row["body"]}


def touch_box(box, alias=None):
    conn = db()
    conn.execute(
        "INSERT INTO boxes(box,alias,created_ts,last_seen) VALUES(?,?,?,?) "
        "ON CONFLICT(box) DO UPDATE SET last_seen=excluded.last_seen, "
        "alias=CASE WHEN excluded.alias!='' THEN excluded.alias ELSE boxes.alias END",
        (box, alias or "", now(), now()))
    conn.commit()


def do_send(sender, alias, to, cc, body):
    if not isinstance(sender, str) or not BOX_RE.match(sender):
        return None, {"error": "bad_from", "detail": BOX_RE.pattern}
    to, cc = as_box_list(to), as_box_list(cc)
    if to is None or cc is None or not to:
        return None, {"error": "bad_recipients",
                      "detail": "`to` required; `to`/`cc` are a box name or list"}
    if not isinstance(body, str) or not body.strip():
        return None, {"error": "empty_body"}
    if len(body) > MAX_BODY:
        return None, {"error": "body_too_large"}
    cc = [c for c in cc if c not in to]
    conn = db()
    cur = conn.execute(
        "INSERT INTO messages(ts,sender,alias,to_json,cc_json,body) VALUES(?,?,?,?,?,?)",
        (now(), sender, str(alias)[:200], json.dumps(to), json.dumps(cc), body))
    mid = cur.lastrowid
    for r in to:
        conn.execute("INSERT INTO deliveries(msg_id,recipient,delivered_as) VALUES(?,?,?)",
                     (mid, r, "to"))
    for r in cc:
        conn.execute("INSERT INTO deliveries(msg_id,recipient,delivered_as) VALUES(?,?,?)",
                     (mid, r, "cc"))
    conn.execute("DELETE FROM messages WHERE ts < datetime('now', ?) AND id IN "
                 "(SELECT msg_id FROM deliveries GROUP BY msg_id "
                 " HAVING count(*) = count(taken_ts))", (f"-{PRUNE_DAYS} days",))
    conn.commit()
    touch_box(sender, str(alias)[:200])
    return {"ok": True, "id": mid, "delivered_to": to + cc}, None


def fetch_box(box, take: bool):
    conn = db()
    rows = conn.execute(
        "SELECT m.*, d.delivered_as FROM deliveries d JOIN messages m ON m.id=d.msg_id "
        "WHERE d.recipient=? AND d.taken_ts IS NULL ORDER BY m.id", (box,)).fetchall()
    out = [envelope(r, r) for r in rows]
    if take and rows:
        conn.executemany(
            "UPDATE deliveries SET taken_ts=? WHERE msg_id=? AND recipient=?",
            [(now(), r["id"], box) for r in rows])
        conn.commit()
    return out


async def do_poll(box, wait_s: int):
    touch_box(box)
    deadline = time.monotonic() + min(max(wait_s, 0), MAX_WAIT)
    while True:
        msgs = fetch_box(box, take=True)
        if msgs or time.monotonic() >= deadline:
            return msgs
        await asyncio.sleep(1.0)


def do_boxes():
    conn = db()
    result = {}
    for b in conn.execute("SELECT * FROM boxes ORDER BY box"):
        pending = conn.execute(
            "SELECT count(*) AS n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
            (b["box"],)).fetchone()["n"]
        result[b["box"]] = {
            "session_name": b["alias"] or None,
            "pending": pending,
            "registered": b["created_ts"],
            "last_seen": b["last_seen"],
        }
    return result


def do_history(box, limit=50):
    conn = db()
    rows = conn.execute(
        "SELECT m.*, d.delivered_as, d.taken_ts FROM deliveries d "
        "JOIN messages m ON m.id=d.msg_id WHERE d.recipient=? "
        "ORDER BY m.id DESC LIMIT ?", (box, min(max(limit, 1), 500))).fetchall()
    out = []
    for r in rows:
        e = envelope(r, r)
        e["taken_ts"] = r["taken_ts"]  # null = still pending
        out.append(e)
    sent = conn.execute(
        "SELECT * FROM messages WHERE sender=? ORDER BY id DESC LIMIT ?",
        (box, min(max(limit, 1), 500))).fetchall()
    sent_out = [{"id": r["id"], "ts": r["ts"], "to": json.loads(r["to_json"]),
                 "cc": json.loads(r["cc_json"]), "body": r["body"]} for r in sent]
    return {"received": out, "sent": sent_out}


USAGE = {
    "service": "cloud-bridge-relay",
    "v": 3,
    "detail": ("Email-style mailbox relay between agent sessions, reachable as "
               "an MCP server (Streamable HTTP at /mcp — tools are "
               "self-describing: send_mail, check_mail, peek_mail, list_boxes) "
               "or as plain REST (endpoints below). Identity: `from` is your "
               "stable box name — machines reply to it and identify by it. "
               "`alias` is your CURRENT SESSION NAME, display only, attached "
               "per message; keep it in sync with your session title, never "
               "cache another sender's alias, never route by it. `to` = act, "
               "`cc` = FYI; each copy carries delivered_as so cc is "
               "distinguishable. Messages persist across redeploys (SQLite)."),
    "mcp": {"endpoint": "/mcp", "transport": "streamable-http",
            "auth": "same Authorization: Bearer header"},
    "endpoints": {
        "GET /": "this document",
        "POST /send": "JSON {from, alias?, to, cc?, body}; to/cc: box name or list",
        "GET /poll?box=X&wait=N": "long-poll (N<=55), returns+takes messages",
        "GET /peek?box=X": "look without taking",
        "GET /boxes": "directory: session_name, pending count, registered/last_seen per box",
        "POST /register": "JSON {box, session_name}: announce yourself so others see your name before you ever send",
        "GET /history?box=X&limit=N": "audit trail: past received (with taken_ts) and sent messages — drained mail stays visible here for ~14 days",
    },
    "box_name_rule": BOX_RE.pattern,
}

mcp = FastMCP("cloud-bridge-relay", stateless_http=True, json_response=True)


@mcp.tool()
async def send_mail(sender_box: str, session_name: str, to: list[str],
                    body: str, cc: list[str] | None = None) -> dict:
    """Send a message to one or more mailboxes (email-style).

    sender_box: your stable box name (recipients reply here).
    session_name: your session's current display name, shown to the human
    reading the traffic — pass your live title every time.
    to: box names that should act; cc: boxes copied for information only.
    """
    res, err = do_send(sender_box, session_name, to, cc or [], body)
    return res if res else err


@mcp.tool()
async def check_mail(box: str, wait_seconds: int = 25) -> list[dict]:
    """Long-poll your mailbox: returns pending messages and removes them.

    Each message shows from/alias/to/cc and delivered_as ("to" = act,
    "cc" = FYI copy). wait_seconds is capped at 55.
    """
    if not BOX_RE.match(box):
        return [{"error": "bad_box"}]
    return await do_poll(box, wait_seconds)


@mcp.tool()
async def peek_mail(box: str) -> list[dict]:
    """Look at pending messages in a box without removing them."""
    if not BOX_RE.match(box):
        return [{"error": "bad_box"}]
    return fetch_box(box, take=False)


@mcp.tool()
async def list_boxes() -> dict:
    """Directory of known boxes: session_name, pending count, registered/last_seen."""
    return do_boxes()


@mcp.tool()
async def register_box(box: str, session_name: str) -> dict:
    """Claim your mailbox and announce your session name in the directory.

    Call this once when you come online (and again after a rename) so other
    sessions can see who you are before you ever send a message.
    """
    if not BOX_RE.match(box):
        return {"error": "bad_box", "detail": BOX_RE.pattern}
    touch_box(box, str(session_name)[:200])
    return {"ok": True, "box": box, "session_name": session_name}


@mcp.tool()
async def mail_history(box: str, limit: int = 50) -> dict:
    """Audit trail for a box: received messages (taken_ts null = still pending)
    and sent messages. Drained mail stays here ~14 days for cross-checking."""
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return do_history(box, limit)


async def rest_root(_):
    return JSONResponse(USAGE)


async def rest_health(_):
    return JSONResponse({"ok": True})


async def rest_send(req: Request):
    try:
        msg = json.loads(await req.body())
        assert isinstance(msg, dict)
    except Exception:
        return JSONResponse({"error": "bad_json"}, status_code=400)
    res, err = do_send(msg.get("from", ""), msg.get("alias", ""),
                       msg.get("to"), msg.get("cc"), msg.get("body", ""))
    return JSONResponse(res if res else err, status_code=200 if res else 400)


async def rest_poll(req: Request):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return JSONResponse({"error": "bad_box"}, status_code=400)
    try:
        wait = int(req.query_params.get("wait", "25"))
    except ValueError:
        wait = 25
    return JSONResponse({"messages": await do_poll(box, wait)})


async def rest_peek(req: Request):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return JSONResponse({"error": "bad_box"}, status_code=400)
    return JSONResponse({"messages": fetch_box(box, take=False)})


async def rest_boxes(_):
    return JSONResponse({"boxes": do_boxes()})


async def rest_register(req: Request):
    try:
        msg = json.loads(await req.body())
        box = msg.get("box", "")
        assert BOX_RE.match(box)
    except Exception:
        return JSONResponse({"error": "bad_box"}, status_code=400)
    touch_box(box, str(msg.get("session_name", ""))[:200])
    return JSONResponse({"ok": True, "box": box})


async def rest_history(req: Request):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return JSONResponse({"error": "bad_box"}, status_code=400)
    try:
        limit = int(req.query_params.get("limit", "50"))
    except ValueError:
        limit = 50
    return JSONResponse(do_history(box, limit))


init_db()
app = mcp.streamable_http_app()
app.router.routes.extend([
    Route("/", rest_root),
    Route("/health", rest_health),
    Route("/send", rest_send, methods=["POST"]),
    Route("/poll", rest_poll),
    Route("/peek", rest_peek),
    Route("/boxes", rest_boxes),
    Route("/register", rest_register, methods=["POST"]),
    Route("/history", rest_history),
])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1" if os.environ.get("PORT") else "0.0.0.0",
                port=PORT, log_level="info")
