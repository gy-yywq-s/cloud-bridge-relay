#!/usr/bin/env python3
"""Mailbox relay v4: team formation, structured envelopes, MCP + REST.

Auth: hostd gateway (bearer / OAuth); this process is loopback-only.

Lifecycle a session follows (the MCP tool docs repeat this):
  1. register_box(box, platform, environment, session_name?) -> waiting pool
  2. The owner hands a 4-digit team code to ONE session; it calls
     create_team(code, its_box) -> every waiting box becomes a numbered member
  3. That coordinator asks the owner for a team name (set_team_name) and
     optional per-member aliases (set_member_alias). Unset alias displays as
     "<team_name>-<member_no>".
  4. list_team(code) -> one-call roster.

Every delivery carries an explicit `directive` line (ACTION / THIS IS A CC /
SYSTEM NOTICE) and the sender's platform stamp, so a cc'd Codex session can
never mistake a copy for an order or a Claude Code peer for its own kind.
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
CODE_RE = re.compile(r"^\d{4}$")
PLATFORMS = ("claude-code", "codex")

DIRECTIVES = {
    "to": ("ACTION: THIS MESSAGE IS ADDRESSED TO YOU. Read it, act on it, "
           "and reply to the sender's box."),
    "cc": ("THIS IS A CC — FOR YOUR INFORMATION ONLY. You are NOT the "
           "primary recipient. Do not act on it and do not reply unless it "
           "explicitly asks you by name."),
    "system": ("SYSTEM NOTICE from the relay itself (not from any session). "
               "It describes a team lifecycle event. Follow its instructions "
               "exactly; do not reply to it."),
}

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
      ts TEXT NOT NULL, sender TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'mail',
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
    CREATE TABLE IF NOT EXISTS teams(
      code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      coordinator TEXT NOT NULL, created_ts TEXT NOT NULL);
    """)
    for col, decl in [("session_name", "TEXT NOT NULL DEFAULT ''"),
                      ("platform", "TEXT NOT NULL DEFAULT ''"),
                      ("env", "TEXT NOT NULL DEFAULT ''"),
                      ("status", "TEXT NOT NULL DEFAULT 'active'"),
                      ("team_code", "TEXT"),
                      ("member_no", "INTEGER")]:
        try:
            c.execute(f"ALTER TABLE boxes ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    for col, decl in [("kind", "TEXT NOT NULL DEFAULT 'mail'")]:
        try:
            c.execute(f"ALTER TABLE messages ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
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


def box_row(box):
    return db().execute("SELECT * FROM boxes WHERE box=?", (box,)).fetchone()


def display_name(b) -> str:
    """Resolved display name: explicit alias, else team default, else box."""
    if b is None:
        return ""
    if b["alias"]:
        return b["alias"]
    if b["team_code"] and b["member_no"]:
        t = db().execute("SELECT name FROM teams WHERE code=?",
                         (b["team_code"],)).fetchone()
        base = (t["name"] if t and t["name"] else f"team{b['team_code']}")
        return f"{base}-{b['member_no']}"
    return b["session_name"] or b["box"]


def sender_stamp(box, fallback_alias=""):
    b = box_row(box)
    if b is None:
        return {"box": box, "display_name": fallback_alias or box,
                "member_no": None, "team": None, "platform": "unknown"}
    return {"box": box, "display_name": display_name(b) or fallback_alias,
            "member_no": b["member_no"], "team": b["team_code"],
            "platform": b["platform"] or "unknown"}


def _insert_message(sender, alias, kind, to, cc, body):
    conn = db()
    cur = conn.execute(
        "INSERT INTO messages(ts,sender,alias,kind,to_json,cc_json,body) "
        "VALUES(?,?,?,?,?,?,?)",
        (now(), sender, alias, kind, json.dumps(to), json.dumps(cc), body))
    mid = cur.lastrowid
    for r in to:
        conn.execute("INSERT OR REPLACE INTO deliveries(msg_id,recipient,delivered_as) "
                     "VALUES(?,?,?)", (mid, r, "to"))
    for r in cc:
        conn.execute("INSERT OR REPLACE INTO deliveries(msg_id,recipient,delivered_as) "
                     "VALUES(?,?,?)", (mid, r, "cc"))
    conn.commit()
    return mid


def system_mail(to_box, body):
    _insert_message("relay", "relay", "system", [to_box], [], body)


def do_send(sender, to, cc, body, fallback_alias=""):
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
    stamp = sender_stamp(sender, fallback_alias)
    mid = _insert_message(sender, stamp["display_name"], "mail", to, cc, body)
    conn = db()
    conn.execute("DELETE FROM messages WHERE ts < datetime('now', ?) AND id IN "
                 "(SELECT msg_id FROM deliveries GROUP BY msg_id "
                 " HAVING count(*) = count(taken_ts))", (f"-{PRUNE_DAYS} days",))
    conn.commit()
    touch_box(sender)
    return {"ok": True, "id": mid, "delivered_to": to + cc, "from": stamp}, None


def touch_box(box, **fields):
    conn = db()
    b = box_row(box)
    if b is None:
        conn.execute(
            "INSERT INTO boxes(box,alias,session_name,created_ts,last_seen,"
            "platform,env,status) VALUES(?,?,?,?,?,?,?,?)",
            (box, fields.get("alias", ""), fields.get("session_name", ""),
             now(), now(), fields.get("platform", ""), fields.get("env", ""),
             fields.get("status", "active")))
    else:
        sets, vals = ["last_seen=?"], [now()]
        for k in ("alias", "session_name", "platform", "env", "status"):
            if k in fields and fields[k] != "":
                sets.append(f"{k}=?")
                vals.append(fields[k])
        vals.append(box)
        conn.execute(f"UPDATE boxes SET {', '.join(sets)} WHERE box=?", vals)
    conn.commit()


def envelope(row):
    stamp = (sender_stamp(row["sender"], row["alias"])
             if row["sender"] != "relay" else
             {"box": "relay", "display_name": "relay", "member_no": None,
              "team": None, "platform": "relay"})
    kind = row["kind"]
    dkey = "system" if kind == "system" else row["delivered_as"]
    return {"id": row["id"], "ts": row["ts"], "kind": kind,
            "from": stamp,
            "to": json.loads(row["to_json"]), "cc": json.loads(row["cc_json"]),
            "delivered_as": row["delivered_as"],
            "directive": DIRECTIVES[dkey],
            "body": row["body"]}


def fetch_box(box, take: bool):
    conn = db()
    rows = conn.execute(
        "SELECT m.*, d.delivered_as FROM deliveries d JOIN messages m ON m.id=d.msg_id "
        "WHERE d.recipient=? AND d.taken_ts IS NULL ORDER BY m.id", (box,)).fetchall()
    out = [envelope(r) for r in rows]
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


def do_register(box, session_name, platform, environment):
    if not BOX_RE.match(box or ""):
        return {"error": "bad_box", "detail": BOX_RE.pattern}
    if platform not in PLATFORMS:
        return {"error": "bad_platform",
                "detail": f"declare your platform: one of {PLATFORMS}. This is "
                          "mandatory so teammates know what they are talking to."}
    b = box_row(box)
    status = "waiting" if not (b and b["team_code"]) else b["status"]
    touch_box(box, session_name=str(session_name or "")[:200], platform=platform,
              env=str(environment or "")[:500], status=status)
    return {"ok": True, "box": box, "status": status,
            "directive": ("REGISTERED. YOU ARE IN THE WAITING POOL. Now poll "
                          "your box (check_mail) and WAIT. Do not send mail "
                          "yet. When a team is formed you will receive a "
                          "SYSTEM NOTICE with your member number.")}


def team_roster(code):
    rows = db().execute(
        "SELECT * FROM boxes WHERE team_code=? ORDER BY member_no", (code,)).fetchall()
    t = db().execute("SELECT * FROM teams WHERE code=?", (code,)).fetchone()
    pending = {r["box"]: db().execute(
        "SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
        (r["box"],)).fetchone()["n"] for r in rows}
    return {
        "team_code": code,
        "team_name": t["name"] if t else "",
        "coordinator": t["coordinator"] if t else "",
        "members": [{
            "member_no": r["member_no"], "box": r["box"],
            "display_name": display_name(r),
            "alias_explicit": bool(r["alias"]),
            "session_name": r["session_name"],
            "platform": r["platform"] or "unknown",
            "environment": r["env"],
            "last_seen": r["last_seen"], "pending_mail": pending[r["box"]],
        } for r in rows],
    }


def do_create_team(code, coordinator_box):
    if not CODE_RE.match(str(code)):
        return {"error": "bad_code", "detail": "team code is exactly 4 digits"}
    code = str(code)
    conn = db()
    if conn.execute("SELECT 1 FROM teams WHERE code=?", (code,)).fetchone():
        return {"error": "team_exists",
                "detail": "this code is taken; use join_team to add members"}
    coord = box_row(coordinator_box)
    if coord is None or coord["status"] != "waiting":
        return {"error": "not_registered",
                "detail": "coordinator must register_box first (waiting pool)"}
    waiting = conn.execute(
        "SELECT * FROM boxes WHERE status='waiting' ORDER BY created_ts").fetchall()
    conn.execute("INSERT INTO teams(code,name,coordinator,created_ts) VALUES(?,?,?,?)",
                 (code, "", coordinator_box, now()))
    ordered = ([b for b in waiting if b["box"] == coordinator_box] +
               [b for b in waiting if b["box"] != coordinator_box])
    for i, b in enumerate(ordered, start=1):
        conn.execute("UPDATE boxes SET status='teamed', team_code=?, member_no=? "
                     "WHERE box=?", (code, i, b["box"]))
    conn.commit()
    for i, b in enumerate(ordered, start=1):
        if b["box"] == coordinator_box:
            continue
        system_mail(b["box"],
                    f"TEAM FORMED. You are member #{i} of team {code} "
                    f"({len(ordered)} members; coordinator: {coordinator_box}). "
                    "Your display name defaults to <team_name>-{no} until an "
                    "alias is assigned. KEEP POLLING your box; a name "
                    "assignment notice may follow. Use list_team "
                    f"('{code}') any time to see the roster.")
    return {"ok": True, **team_roster(code),
            "directive": ("TEAM CREATED AND YOU ARE THE COORDINATOR (member #1). "
                          "NOW DO THIS, IN ORDER: 1) ASK THE OWNER (the human) "
                          "for a team name, then call set_team_name. 2) ASK THE "
                          "OWNER whether to give each member an alias — read "
                          "them the roster. For each alias chosen, call "
                          "set_member_alias. Members without an alias keep the "
                          "default '<team_name>-<member_no>'. 3) Report the "
                          "final roster back to the owner.")}


def do_join_team(code, box):
    code = str(code)
    t = db().execute("SELECT * FROM teams WHERE code=?", (code,)).fetchone()
    if not t:
        return {"error": "no_such_team"}
    b = box_row(box)
    if b is None:
        return {"error": "not_registered", "detail": "register_box first"}
    if b["team_code"] == code:
        return {"ok": True, "already_member": True, **team_roster(code)}
    nxt = (db().execute("SELECT MAX(member_no) m FROM boxes WHERE team_code=?",
                        (code,)).fetchone()["m"] or 0) + 1
    db().execute("UPDATE boxes SET status='teamed', team_code=?, member_no=? "
                 "WHERE box=?", (code, nxt, box))
    db().commit()
    system_mail(t["coordinator"],
                f"TEAM UPDATE: box '{box}' joined team {code} as member #{nxt}.")
    return {"ok": True, "member_no": nxt, **team_roster(code)}


def do_set_team_name(code, name):
    code = str(code)
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (code,)).fetchone():
        return {"error": "no_such_team"}
    db().execute("UPDATE teams SET name=? WHERE code=?", (str(name)[:100], code))
    db().commit()
    for m in team_roster(code)["members"]:
        system_mail(m["box"],
                    f"TEAM NAME SET: your team {code} is now named '{name}'. "
                    f"Your display name is '{m['display_name']}' "
                    "(default <team_name>-<member_no> unless an alias was assigned).")
    return {"ok": True, **team_roster(code)}


def do_set_member_alias(code, member_no, alias):
    code = str(code)
    r = db().execute("SELECT * FROM boxes WHERE team_code=? AND member_no=?",
                     (code, int(member_no))).fetchone()
    if not r:
        return {"error": "no_such_member"}
    db().execute("UPDATE boxes SET alias=? WHERE box=?", (str(alias)[:200], r["box"]))
    db().commit()
    system_mail(r["box"], f"NAME ASSIGNED: the owner named you '{alias}'. "
                          "This is now your display name on every message you send.")
    return {"ok": True, **team_roster(code)}


def do_boxes():
    conn = db()
    result = {}
    for b in conn.execute("SELECT * FROM boxes ORDER BY box"):
        pending = conn.execute(
            "SELECT count(*) AS n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
            (b["box"],)).fetchone()["n"]
        result[b["box"]] = {
            "display_name": display_name(b) or None,
            "platform": b["platform"] or "unknown",
            "status": b["status"], "team": b["team_code"],
            "member_no": b["member_no"], "pending": pending,
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
        e = envelope(r)
        e["taken_ts"] = r["taken_ts"]
        out.append(e)
    sent = conn.execute(
        "SELECT * FROM messages WHERE sender=? ORDER BY id DESC LIMIT ?",
        (box, min(max(limit, 1), 500))).fetchall()
    sent_out = [{"id": r["id"], "ts": r["ts"], "kind": r["kind"],
                 "to": json.loads(r["to_json"]), "cc": json.loads(r["cc_json"]),
                 "body": r["body"]} for r in sent]
    return {"received": out, "sent": sent_out}


USAGE = {
    "service": "cloud-bridge-relay",
    "v": 4,
    "detail": ("Team-aware mailbox relay for agent sessions. MCP server at /mcp "
               "(Streamable HTTP; tools are self-describing) plus the REST "
               "mirror below. Lifecycle: register_box (declares platform "
               "claude-code|codex + runtime environment, enters waiting pool) "
               "-> owner gives ONE session a 4-digit code -> create_team "
               "scoops the waiting pool into numbered members -> coordinator "
               "asks the owner for team name (set_team_name) and optional "
               "aliases (set_member_alias); unset aliases display as "
               "<team_name>-<member_no> -> list_team for a one-call roster. "
               "Every delivery carries an explicit `directive` (ACTION / "
               "THIS IS A CC / SYSTEM NOTICE) and the sender's platform stamp."),
    "mcp": {"endpoint": "/mcp", "transport": "streamable-http"},
    "endpoints": {
        "GET /": "this document",
        "POST /register": "{box, session_name?, platform, environment}",
        "POST /team/create": "{code, coordinator_box}",
        "POST /team/join": "{code, box}",
        "POST /team/name": "{code, name}",
        "POST /team/alias": "{code, member_no, alias}",
        "GET /team?code=X": "roster",
        "POST /send": "{from, to, cc?, body}",
        "GET /poll?box=X&wait=N": "long-poll (take)",
        "GET /peek?box=X": "look, don't take",
        "GET /boxes": "directory across teams",
        "GET /history?box=X&limit=N": "audit trail incl. taken mail (~14 days)",
    },
    "box_name_rule": BOX_RE.pattern,
}

mcp = FastMCP("cloud-bridge-relay", stateless_http=True, json_response=True)


@mcp.tool()
async def register_box(box: str, platform: str, environment: str,
                       session_name: str = "") -> dict:
    """Register your mailbox and enter the team waiting pool.

    box: your stable box name (lowercase, digits, - _; you keep it forever).
    platform: MANDATORY, exactly "claude-code" or "codex" — teammates must
    know what they are talking to; it is stamped on every message you send.
    environment: one line about where you run (host/OS/model), e.g.
    "MacBook M1 Pro / macOS / local".
    session_name: your session's current display title, if you know it.
    After registering: poll check_mail and WAIT for the team-formation notice.
    """
    return do_register(box, session_name, platform, environment)


@mcp.tool()
async def create_team(code: str, coordinator_box: str) -> dict:
    """Form a team from every session currently in the waiting pool.

    Call this ONLY if the owner (the human) gave YOU a 4-digit team code.
    You become member #1 and the coordinator. The response directive tells
    you exactly what to ask the owner next (team name, optional aliases).
    """
    return do_create_team(code, coordinator_box)


@mcp.tool()
async def join_team(code: str, box: str) -> dict:
    """Join an existing team late (you must have registered first)."""
    return do_join_team(code, box)


@mcp.tool()
async def set_team_name(code: str, name: str) -> dict:
    """Coordinator only: set the team's name (ask the owner for it first).
    Members without an explicit alias will display as '<name>-<member_no>'."""
    return do_set_team_name(code, name)


@mcp.tool()
async def set_member_alias(code: str, member_no: int, alias: str) -> dict:
    """Coordinator only: assign the alias the owner chose for one member.
    Skipping a member keeps their default '<team_name>-<member_no>'."""
    return do_set_member_alias(code, member_no, alias)


@mcp.tool()
async def list_team(code: str) -> dict:
    """One-call roster: number, box, display name, platform, environment,
    last_seen and pending-mail count for every member."""
    if not CODE_RE.match(str(code)):
        return {"error": "bad_code"}
    return team_roster(str(code))


@mcp.tool()
async def send_mail(sender_box: str, to: list[str], body: str,
                    cc: list[str] | None = None) -> dict:
    """Send a message. `to` = must act; `cc` = FYI copy only.

    Your display name and platform are stamped automatically from your
    registration — register_box first. Recipients see an explicit directive
    line distinguishing ACTION mail from CC copies.
    """
    res, err = do_send(sender_box, to, cc or [], body)
    return res if res else err


@mcp.tool()
async def check_mail(box: str, wait_seconds: int = 25) -> list[dict]:
    """Long-poll your mailbox: returns pending messages and marks them taken
    (they stay visible in mail_history ~14 days). Each message carries kind
    (mail|system), from.{box,display_name,member_no,team,platform},
    delivered_as (to|cc) and a directive line saying whether YOU must act."""
    if not BOX_RE.match(box):
        return [{"error": "bad_box"}]
    return await do_poll(box, wait_seconds)


@mcp.tool()
async def peek_mail(box: str) -> list[dict]:
    """Look at pending messages without taking them."""
    if not BOX_RE.match(box):
        return [{"error": "bad_box"}]
    return fetch_box(box, take=False)


@mcp.tool()
async def list_boxes() -> dict:
    """Directory of all known boxes across teams: display name, platform,
    status, team/member number, pending count, last_seen."""
    return do_boxes()


@mcp.tool()
async def mail_history(box: str, limit: int = 50) -> dict:
    """Audit trail: received (taken_ts null = still pending) and sent
    messages for a box. Taken mail stays ~14 days for cross-checking."""
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return do_history(box, limit)


def _json_route(handler):
    async def route(req: Request):
        try:
            payload = json.loads(await req.body()) if req.method == "POST" else {}
            if req.method == "POST":
                assert isinstance(payload, dict)
        except Exception:
            return JSONResponse({"error": "bad_json"}, status_code=400)
        res = await handler(req, payload)
        code = 200 if not (isinstance(res, dict) and "error" in res) else 400
        return JSONResponse(res, status_code=code)
    return route


async def _r_root(_req, _p):
    return USAGE


async def _r_health(_req, _p):
    return {"ok": True}


async def _r_register(_req, p):
    return do_register(p.get("box", ""), p.get("session_name", ""),
                       p.get("platform", ""), p.get("environment", ""))


async def _r_team_create(_req, p):
    return do_create_team(p.get("code", ""), p.get("coordinator_box", ""))


async def _r_team_join(_req, p):
    return do_join_team(p.get("code", ""), p.get("box", ""))


async def _r_team_name(_req, p):
    return do_set_team_name(p.get("code", ""), p.get("name", ""))


async def _r_team_alias(_req, p):
    try:
        return do_set_member_alias(p.get("code", ""), int(p.get("member_no", 0)),
                                   p.get("alias", ""))
    except (TypeError, ValueError):
        return {"error": "bad_member_no"}


async def _r_team(req, _p):
    code = req.query_params.get("code", "")
    if not CODE_RE.match(code):
        return {"error": "bad_code"}
    return team_roster(code)


async def _r_send(_req, p):
    res, err = do_send(p.get("from", ""), p.get("to"), p.get("cc"),
                       p.get("body", ""), fallback_alias=p.get("alias", ""))
    return res if res else err


async def _r_poll(req, _p):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    try:
        wait = int(req.query_params.get("wait", "25"))
    except ValueError:
        wait = 25
    return {"messages": await do_poll(box, wait)}


async def _r_peek(req, _p):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return {"messages": fetch_box(box, take=False)}


async def _r_boxes(_req, _p):
    return {"boxes": do_boxes()}


async def _r_history(req, _p):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    try:
        limit = int(req.query_params.get("limit", "50"))
    except ValueError:
        limit = 50
    return do_history(box, limit)


init_db()
app = mcp.streamable_http_app()
app.router.routes.extend([
    Route("/", _json_route(_r_root)),
    Route("/health", _json_route(_r_health)),
    Route("/register", _json_route(_r_register), methods=["POST"]),
    Route("/team/create", _json_route(_r_team_create), methods=["POST"]),
    Route("/team/join", _json_route(_r_team_join), methods=["POST"]),
    Route("/team/name", _json_route(_r_team_name), methods=["POST"]),
    Route("/team/alias", _json_route(_r_team_alias), methods=["POST"]),
    Route("/team", _json_route(_r_team)),
    Route("/send", _json_route(_r_send), methods=["POST"]),
    Route("/poll", _json_route(_r_poll)),
    Route("/peek", _json_route(_r_peek)),
    Route("/boxes", _json_route(_r_boxes)),
    Route("/history", _json_route(_r_history)),
])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1" if os.environ.get("PORT") else "0.0.0.0",
                port=PORT, log_level="info")
