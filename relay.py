#!/usr/bin/env python3
"""Mailbox relay v5: teams, roles, owner mailbox with real email, setup center.

Auth: hostd gateway (bearer / OAuth); this process is loopback-only.

Flow (MCP prompts /onboard /setup /add-owner-mailbox /team-status walk
sessions through this so nobody improvises):

  1. register_box(box, platform, environment, pool_code, session_name?)
     -> waiting pool for the owner-issued 4-digit code.
  2. One session watches the pool (watch_pool); on the owner's word
     "initialize" it calls initialize_team -> numbered members, unique
     team id (tm-xxxxxx), itself coordinator (#1).
  3. Coordinator runs the SETUP CENTER (revisitable any time):
       set_team_name / set_member_alias / set_box_role (manager|worker) /
       attach_owner_to_team / set_owner_mode
     Every setup change broadcasts an updated team card to all members.
  4. Owner mailbox (persistent, survives teams): setup_owner_mailbox
     (full name + alias + real email) -> verification email -> the OWNER
     says "confirm" -> confirm_owner_mailbox. Mail delivered to box
     'owner' is forwarded as real email; a successful send counts as read.

Hard rules (only active when configured):
  - role worker set => that box may never to/cc the owner; owner contact is
    the manager's job.
  - owner mode gates who may mail the owner and whether direct `to` needs a
    justification (see OWNER_MODES).
Every delivery carries kind / from{box,display_name,member_no,team,platform,
role,is_human} / delivered_as / directive / team_info footer.
"""
import asyncio
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

PORT = int(os.environ.get("PORT", os.environ.get("RELAY_PORT", "8790")))
DATA_DIR = Path(os.environ.get("HOSTD_DATA_DIR", str(Path.home() / ".relay_data")))
DB = DATA_DIR / "relay.db"
MAX_BODY = 256 * 1024
MAX_WAIT = 55
PRUNE_DAYS = 14
RATE_N = 30           # max sends per box...
RATE_WINDOW = 300     # ...per this many seconds; hard refusal, never silent
STALE_AFTER = 600
TASK_STALL_AFTER = 7200   # claimed task silent this long -> stalled, manager told     # teamed agent silent for this long -> flagged, manager told
BOX_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
CODE_RE = re.compile(r"^\d{4}$")
PLATFORMS = ("claude-code", "codex")
ROLES = ("manager", "worker")
OWNER_BOX = "owner"

DIRECTIVES = {
    "to": ("ACTION: THIS MESSAGE IS ADDRESSED TO YOU. Read it, act on it, "
           "and reply to the sender's box."),
    "cc": ("THIS IS A CC — FOR YOUR INFORMATION ONLY. You are NOT the "
           "primary recipient. Do not act on it and do not reply unless it "
           "explicitly asks you by name."),
    "system": ("SYSTEM NOTICE from the relay itself (not from any session). "
               "It describes a team or setup event. Follow its instructions "
               "exactly; do not reply to it."),
}

OWNER_MODES = {
    "a": {"label": "milestones-only (default)",
          "allow_senders": "manager_only", "allow_direct": "justified_only",
          "rules": ("Only the MANAGER may mail the owner. Normal traffic is "
                    "CC ONLY, and only concise milestone summaries. A direct "
                    "`to` is allowed ONLY when the task is hard-blocked "
                    "without the owner, or for a severe safety/destructive, "
                    "time-sensitive matter the owner must ACT on — and it "
                    "requires a justification.")},
    "b": {"label": "manager-open",
          "allow_senders": "manager_only", "allow_direct": "free",
          "rules": ("Only the MANAGER may mail the owner, but both cc and "
                    "direct `to` are allowed. Keep everything concise.")},
    "c": {"label": "team-open",
          "allow_senders": "any", "allow_direct": "justified_only",
          "rules": ("Any team member may CC the owner. Direct `to` still "
                    "requires a justification (genuinely important only).")},
    "d": {"label": "custom",
          "allow_senders": "manager_only", "allow_direct": "justified_only",
          "rules": ""},  # switches + rules text supplied at setup time
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
      taken_ts TEXT, email_status TEXT, PRIMARY KEY (msg_id, recipient));
    CREATE INDEX IF NOT EXISTS idx_deliv_pending
      ON deliveries(recipient) WHERE taken_ts IS NULL;
    CREATE TABLE IF NOT EXISTS boxes(
      box TEXT PRIMARY KEY, alias TEXT NOT NULL DEFAULT '',
      created_ts TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams(
      code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      pool_code TEXT NOT NULL DEFAULT '',
      coordinator TEXT NOT NULL, created_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      deps TEXT NOT NULL DEFAULT '[]', owner TEXT, status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 2, result TEXT NOT NULL DEFAULT '',
      last_note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
      discovered_from INTEGER, stalled INTEGER NOT NULL DEFAULT 0,
      created_ts TEXT NOT NULL, updated_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS setup_state(
      team_code TEXT PRIMARY KEY, step_id TEXT NOT NULL DEFAULT '',
      answers TEXT NOT NULL DEFAULT '{}', done INTEGER NOT NULL DEFAULT 0,
      started_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_mailbox(
      id INTEGER PRIMARY KEY CHECK (id=1),
      full_name TEXT NOT NULL, alias TEXT NOT NULL, email TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'a',
      allow_senders TEXT NOT NULL DEFAULT 'manager_only',
      allow_direct TEXT NOT NULL DEFAULT 'justified_only',
      custom_rules TEXT NOT NULL DEFAULT '',
      persistent INTEGER NOT NULL DEFAULT 1,
      confirmed INTEGER NOT NULL DEFAULT 0,
      last_send_error TEXT NOT NULL DEFAULT '',
      created_ts TEXT NOT NULL);
    """)
    for col, decl in [("session_name", "TEXT NOT NULL DEFAULT ''"),
                      ("platform", "TEXT NOT NULL DEFAULT ''"),
                      ("env", "TEXT NOT NULL DEFAULT ''"),
                      ("status", "TEXT NOT NULL DEFAULT 'active'"),
                      ("pool_code", "TEXT"),
                      ("team_code", "TEXT"),
                      ("member_no", "INTEGER"),
                      ("role", "TEXT NOT NULL DEFAULT ''"),
                      ("is_human", "INTEGER NOT NULL DEFAULT 0"),
                      ("last_poll", "TEXT")]:
        try:
            c.execute(f"ALTER TABLE boxes ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    for tbl, col, decl in [("messages", "kind", "TEXT NOT NULL DEFAULT 'mail'"),
                           ("messages", "client_key", "TEXT"),
                           ("messages", "reply_to", "INTEGER"),
                           ("boxes", "stale", "INTEGER NOT NULL DEFAULT 0"),
                           ("teams", "rv", "INTEGER NOT NULL DEFAULT 1"),
                           ("teams", "view_key", "TEXT"),
                           ("boxes", "seen_rv", "INTEGER NOT NULL DEFAULT 0"),
                           ("deliveries", "email_status", "TEXT"),
                           ("teams", "pool_code", "TEXT NOT NULL DEFAULT ''")]:
        try:
            c.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_client_key "
              "ON messages(sender, client_key) WHERE client_key IS NOT NULL")
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


def owner_row():
    return db().execute("SELECT * FROM owner_mailbox WHERE id=1").fetchone()


def display_name(b) -> str:
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
                "member_no": None, "team": None, "platform": "unknown",
                "role": "", "is_human": False}
    return {"box": box, "display_name": display_name(b) or fallback_alias,
            "member_no": b["member_no"], "team": b["team_code"],
            "platform": b["platform"] or "unknown",
            "role": b["role"], "is_human": bool(b["is_human"])}


def bump_rv(code):
    """Roster version: any setup change bumps it; footers go full once per
    recipient per version, brief otherwise."""
    db().execute("UPDATE teams SET rv=rv+1 WHERE code=?", (code,))
    db().commit()


def team_card(code) -> str:
    """Human-readable team card, appended to mail and broadcast on changes."""
    t = db().execute("SELECT * FROM teams WHERE code=?", (code,)).fetchone()
    if not t:
        return ""
    rows = db().execute("SELECT * FROM boxes WHERE team_code=? "
                        "ORDER BY member_no", (code,)).fetchall()
    name = t["name"] or "(unnamed)"
    lines = [f"── team {name} · {code} ──"]
    for r in rows:
        who = display_name(r)
        kind = "human" if r["is_human"] else (r["platform"] or "unknown")
        role = r["role"] or ("owner" if r["box"] == OWNER_BOX else "-")
        env = (r["env"] or "").strip()
        tail = f" · {env}" if env and not r["is_human"] else ""
        mark = " · STALE" if r["stale"] else ""
        lines.append(f"#{r['member_no'] or 0} {who} · box:{r['box']} · "
                     f"{role} · {kind}{tail}{mark}")
    return "\n".join(lines)


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
    if OWNER_BOX in to or OWNER_BOX in cc:
        threading.Thread(target=_email_owner_delivery, args=(mid,),
                         daemon=True).start()
    return mid


def system_mail(to_box, body):
    _insert_message("relay", "relay", "system", [to_box], [], body)


def broadcast_team(code, body):
    rows = db().execute("SELECT box FROM boxes WHERE team_code=? AND box!=?",
                        (code, OWNER_BOX)).fetchall()
    for r in rows:
        system_mail(r["box"], body)


# ---------------- email (Resend) ----------------

FROM_ADDR = "crew@verification.gaelisus.com"


def email_html(badge, badge_color, body, meta_rows, card):
    """Minimal clean HTML mail: badge, body, meta table, team card."""
    import html as h
    rows = "".join(
        f"<tr><td style='padding:2px 12px 2px 0;color:#8a8f98;white-space:nowrap'>"
        f"{h.escape(k)}</td><td style='padding:2px 0;color:#3c4149'>"
        f"{h.escape(v)}</td></tr>" for k, v in meta_rows if v)
    card_html = ""
    if card:
        lines = "".join(f"<div style='padding:1px 0'>{h.escape(l)}</div>"
                        for l in card.splitlines())
        card_html = (f"<div style='margin-top:16px;padding:10px 14px;"
                     f"background:#f6f7f8;border-radius:8px;font-size:12px;"
                     f"color:#5e646e;font-family:ui-monospace,Menlo,monospace'>"
                     f"{lines}</div>")
    body_html = "".join(f"<p style='margin:0 0 10px'>{h.escape(p)}</p>"
                        for p in body.split("\n\n"))
    return f"""<div style="max-width:560px;margin:0 auto;padding:24px;
font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#1c1e21">
<div style="margin-bottom:14px">
  <span style="display:inline-block;padding:3px 10px;border-radius:99px;
  background:{badge_color};color:#fff;font-size:11px;font-weight:600;
  letter-spacing:.4px">{h.escape(badge)}</span>
  <span style="margin-left:8px;color:#8a8f98;font-size:12px">crew</span>
</div>
<div style="font-size:14px;line-height:1.55">{body_html}</div>
<table style="margin-top:14px;font-size:12px;border-collapse:collapse">{rows}</table>
{card_html}
</div>"""


def resend_email(to_addr, subject, text, html=None, sender_label="crew"):
    key = os.environ.get("RESEND_API_KEY", "")
    if not key:
        return {"error": ("RESEND_API_KEY is not configured on the droplet. "
                          "The owner must: 1) add `RESEND_API_KEY` under "
                          "`secrets:` in the site manifest (needs a deploy "
                          "code), 2) run `hostd secret set cloud-bridge-relay "
                          "RESEND_API_KEY` on the droplet.")}
    payload = {"from": f"{sender_label} <{FROM_ADDR}>", "to": [to_addr],
               "subject": subject, "text": text}
    if html:
        payload["html"] = html
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "User-Agent": "cloud-bridge-relay/5"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rid = json.loads(r.read().decode()).get("id", "")
            return {"ok": True, "resend_id": rid}
    except urllib.error.HTTPError as e:
        return {"error": f"resend HTTP {e.code}: {e.read().decode()[:300]}"}
    except Exception as e:
        return {"error": f"resend: {str(e)[:300]}"}


def _email_owner_delivery(mid):
    """Forward an owner-bound delivery as real email; success == read."""
    o = owner_row()
    conn = db()
    row = conn.execute("SELECT m.*, d.delivered_as FROM messages m JOIN "
                       "deliveries d ON d.msg_id=m.id AND d.recipient=? "
                       "WHERE m.id=?", (OWNER_BOX, mid)).fetchone()
    if not (o and o["confirmed"] and row):
        return
    stamp = sender_stamp(row["sender"], row["alias"])
    is_cc = row["delivered_as"] == "cc"
    footer = team_card(stamp["team"]) if stamp["team"] else ""
    tname = ""
    if stamp["team"]:
        t = db().execute("SELECT name FROM teams WHERE code=?",
                         (stamp["team"],)).fetchone()
        tname = (t["name"] if t and t["name"] else stamp["team"])
    sender_label = f"crew-{tname}" if tname else "crew"
    meta = [("from", f"{stamp['display_name']} · box {stamp['box']} · "
                     f"{stamp['role'] or 'no-role'} · {stamp['platform']}"),
            ("to", ", ".join(json.loads(row["to_json"]))),
            ("cc", ", ".join(json.loads(row["cc_json"])))]
    kind_line = "CC — for your information" if is_cc else "ACTION — addressed to you"
    text = (f"{row['body']}\n\n—\n{kind_line}\n"
            + "\n".join(f"{k}: {v}" for k, v in meta if v)
            + (f"\n\n{footer}" if footer else ""))
    html = email_html("CC · FYI" if is_cc else "ACTION",
                      "#8a8f98" if is_cc else "#d4380d",
                      row["body"], meta, footer)
    subject = (f"[{'CC' if is_cc else 'ACTION'}] {stamp['display_name']}"
               + (f" · {tname}" if tname else ""))
    res = resend_email(o["email"], subject, text, html, sender_label)
    if res.get("ok"):
        conn.execute("UPDATE deliveries SET taken_ts=?, email_status='sent' "
                     "WHERE msg_id=? AND recipient=?", (now(), mid, OWNER_BOX))
        conn.commit()
    else:
        conn.execute("UPDATE deliveries SET email_status=? "
                     "WHERE msg_id=? AND recipient=?",
                     (f"failed: {res['error']}"[:400], mid, OWNER_BOX))
        conn.execute("UPDATE owner_mailbox SET last_send_error=? WHERE id=1",
                     (res["error"][:400],))
        conn.commit()
        system_mail(row["sender"],
                    "EMAIL DELIVERY FAILED for your message to the owner "
                    f"(msg #{mid}): {res['error']} — YOU MUST inform the owner "
                    "of this failure through whatever channel you have. The "
                    "message stays queued in the owner box.")


# ---------------- owner mailbox setup ----------------

def do_setup_owner(full_name, alias, email):
    if not full_name or not email or "@" not in email:
        return {"error": "bad_input", "detail": "need full_name and a real email"}
    conn = db()
    prev = owner_row()
    full_name = str(full_name)[:100]
    alias = str(alias or full_name)[:100]
    email = str(email)[:200]
    if prev and prev["confirmed"] and prev["email"] == email:
        # Editing name/alias only: same verified address, no re-verification.
        conn.execute("UPDATE owner_mailbox SET full_name=?, alias=? WHERE id=1",
                     (full_name, alias))
        conn.execute("UPDATE boxes SET alias=?, session_name=? WHERE box=?",
                     (alias, full_name, OWNER_BOX))
        conn.commit()
        b = box_row(OWNER_BOX)
        if b and b["team_code"]:
            broadcast_team(b["team_code"],
                           f"SETUP CHANGE: owner is now '{alias}' "
                           f"({full_name}).\n\n" + team_card(b["team_code"]))
        return {"ok": True, "updated": "name/alias only",
                "detail": "email unchanged, verification kept"}
    conn.execute("INSERT INTO owner_mailbox(id,full_name,alias,email,created_ts) "
                 "VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                 "full_name=excluded.full_name, alias=excluded.alias, "
                 "email=excluded.email, confirmed=0, last_send_error=''",
                 (full_name, alias, email, now()))
    conn.commit()
    body = (f"Hello {full_name},\n\nthis is the verification mail for your "
            "owner mailbox on crew. If you can read this, tell your session "
            "to confirm.")
    res = resend_email(email, "Verify your owner mailbox · crew", body,
                       email_html("VERIFY", "#1668dc", body,
                                  [("mailbox", "owner"), ("email", email)], ""),
                       "crew-setup")
    if res.get("ok"):
        return {"ok": True, "verification": "sent",
                "directive": ("VERIFICATION EMAIL SENT to " + email + ". NOW "
                              "ASK THE OWNER (the human) to check their inbox. "
                              "ONLY when the owner says they received it, call "
                              "confirm_owner_mailbox(). If they did not get "
                              "it, re-run setup_owner_mailbox with a corrected "
                              "address. DO NOT confirm on your own.")}
    conn.execute("UPDATE owner_mailbox SET last_send_error=? WHERE id=1",
                 (res["error"][:400],))
    conn.commit()
    return {"ok": False, "verification": "failed", "send_error": res["error"],
            "directive": ("VERIFICATION EMAIL FAILED TO SEND. YOU MUST tell "
                          "the owner exactly this error: '" + res["error"] +
                          "'. The owner may fix the cause, or explicitly say "
                          "'override' — only then call "
                          "confirm_owner_mailbox(override=True).")}


def do_confirm_owner(override=False):
    o = owner_row()
    if not o:
        return {"error": "no_owner_mailbox", "detail": "run setup_owner_mailbox first"}
    if o["last_send_error"] and not override:
        return {"error": "send_error_unresolved",
                "detail": ("last email failed: " + o["last_send_error"] +
                           " — the owner must say 'override' to force-confirm")}
    conn = db()
    conn.execute("UPDATE owner_mailbox SET confirmed=1 WHERE id=1")
    b = box_row(OWNER_BOX)
    if b is None:
        conn.execute("INSERT INTO boxes(box,alias,session_name,created_ts,"
                     "last_seen,platform,env,status,role,is_human) "
                     "VALUES(?,?,?,?,?,?,?,?,?,1)",
                     (OWNER_BOX, o["alias"], o["full_name"], now(), now(),
                      "human", "email:" + o["email"], "active", "owner"))
    else:
        conn.execute("UPDATE boxes SET alias=?, session_name=?, platform='human',"
                     "role='owner', is_human=1 WHERE box=?",
                     (o["alias"], o["full_name"], OWNER_BOX))
    conn.commit()
    return {"ok": True, "confirmed": True, "overridden": bool(override),
            "owner": {"full_name": o["full_name"], "alias": o["alias"],
                      "email": o["email"], "mode": o["mode"]}}


def do_set_owner_mode(mode, custom_rules="", allow_senders="", allow_direct="",
                      persistent=None):
    o = owner_row()
    if not o:
        return {"error": "no_owner_mailbox"}
    if mode not in OWNER_MODES:
        return {"error": "bad_mode", "detail": f"one of {list(OWNER_MODES)}"}
    m = OWNER_MODES[mode]
    snd = allow_senders if allow_senders in ("manager_only", "any") else m["allow_senders"]
    drc = allow_direct if allow_direct in ("justified_only", "free") else m["allow_direct"]
    rules = str(custom_rules)[:2000] if mode == "d" else m["rules"]
    if mode == "d" and not rules:
        return {"error": "custom_needs_rules",
                "detail": ("mode d: translate the owner's natural-language "
                           "wishes into 1) a short hard rules text, 2) "
                           "allow_senders (manager_only|any), 3) allow_direct "
                           "(justified_only|free); READ THEM BACK to the owner "
                           "and only call again after the owner confirms. Also "
                           "ASK THE OWNER whether to keep this custom mode "
                           "permanently (persistent=true) or not.")}
    conn = db()
    keep = o["persistent"] if persistent is None else (1 if persistent else 0)
    conn.execute("UPDATE owner_mailbox SET mode=?, allow_senders=?, "
                 "allow_direct=?, custom_rules=?, persistent=? WHERE id=1",
                 (mode, snd, drc, rules if mode == "d" else "", keep))
    conn.commit()
    b = box_row(OWNER_BOX)
    if b and b["team_code"]:
        broadcast_team(b["team_code"],
                       "OWNER CONTACT RULES UPDATED (mode " + mode + " — " +
                       m["label"] + "):\n" + rules + "\n\n" + team_card(b["team_code"]))
    return {"ok": True, "mode": mode, "allow_senders": snd,
            "allow_direct": drc, "rules": rules, "persistent": bool(keep)}


def owner_gate(sender, to, cc, justification):
    """Hard owner-contact rules. Returns error dict or None."""
    if OWNER_BOX not in to and OWNER_BOX not in cc:
        return None
    o = owner_row()
    if not (o and o["confirmed"]):
        return {"error": "owner_not_configured",
                "detail": "no confirmed owner mailbox; run /add-owner-mailbox"}
    sb = box_row(sender)
    role = sb["role"] if sb else ""
    rules = o["custom_rules"] or OWNER_MODES[o["mode"]]["rules"]
    if role == "worker":
        return {"error": "chain_of_command",
                "directive": ("HARD RULE: you are a WORKER. Workers never "
                              "contact the owner — report to your MANAGER "
                              "instead and let the manager decide. Owner "
                              "contact rules in force:\n" + rules)}
    if o["allow_senders"] == "manager_only" and role != "manager":
        return {"error": "owner_contact_denied",
                "directive": ("HARD RULE: only the MANAGER may mail the owner "
                              "under the current mode. Rules in force:\n" + rules)}
    if OWNER_BOX in to and o["allow_direct"] == "justified_only" and \
            not str(justification or "").strip():
        return {"error": "justification_required",
                "directive": ("HARD RULE: a direct `to` the owner requires a "
                              "justification. Ask yourself: is the task "
                              "hard-blocked without the owner, or is this a "
                              "severe safety/time-critical matter the owner "
                              "must ACT on? If yes, resend with "
                              "owner_justification explaining it in one "
                              "sentence. If no, send a concise CC instead. "
                              "Rules in force:\n" + rules)}
    return None


# ---------------- core send/receive ----------------

def rate_check(sender):
    """Sliding-window send limit. Refuses LOUDLY — the sender always learns
    the message was NOT sent and when to retry."""
    rows = db().execute(
        "SELECT ts FROM messages WHERE sender=? ORDER BY id DESC LIMIT ?",
        (sender, RATE_N)).fetchall()
    if len(rows) < RATE_N:
        return None
    oldest = datetime.fromisoformat(rows[-1]["ts"])
    age = (datetime.now(timezone.utc) - oldest).total_seconds()
    if age >= RATE_WINDOW:
        return None
    retry = int(RATE_WINDOW - age) + 1
    return {"error": "rate_limited", "sent": False,
            "retry_after_s": retry,
            "directive": (f"YOUR MESSAGE WAS NOT SENT. You have sent {RATE_N} "
                          f"messages in the last {RATE_WINDOW}s, which is the "
                          f"limit. Wait {retry}s and send again — do NOT "
                          "assume delivery, and consider batching several "
                          "updates into one templated message instead of "
                          "streaming them.")}


def do_send(sender, to, cc, body, fallback_alias="", owner_justification="",
            dedup_key="", reply_to=None):
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
    gate = owner_gate(sender, to, cc, owner_justification)
    if gate:
        return None, gate
    limited = rate_check(sender)
    if limited:
        return None, limited
    if reply_to is not None:
        try:
            reply_to = int(reply_to)
        except (TypeError, ValueError):
            return None, {"error": "bad_reply_to"}
        if not db().execute("SELECT 1 FROM messages WHERE id=?",
                            (reply_to,)).fetchone():
            return None, {"error": "bad_reply_to",
                          "detail": f"no message #{reply_to} (pruned or never existed)"}
    if dedup_key:
        dup = db().execute("SELECT id FROM messages WHERE sender=? AND client_key=?",
                           (sender, str(dedup_key)[:100])).fetchone()
        if dup:
            return {"ok": True, "id": dup["id"], "duplicate": True,
                    "detail": "already sent (dedup_key matched); no new message"}, None
    if owner_justification and OWNER_BOX in to:
        body = f"[owner-direct justification: {owner_justification}]\n\n{body}"
    stamp = sender_stamp(sender, fallback_alias)
    mid = _insert_message(sender, stamp["display_name"], "mail", to, cc, body)
    if reply_to is not None:
        db().execute("UPDATE messages SET reply_to=? WHERE id=?", (reply_to, mid))
        db().commit()
    if dedup_key:
        db().execute("UPDATE messages SET client_key=? WHERE id=?",
                     (str(dedup_key)[:100], mid))
        db().commit()
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
        for k in ("alias", "session_name", "platform", "env", "status", "role"):
            if k in fields and fields[k] != "":
                sets.append(f"{k}=?")
                vals.append(fields[k])
        vals.append(box)
        conn.execute(f"UPDATE boxes SET {', '.join(sets)} WHERE box=?", vals)
    conn.commit()


def envelope(row, recipient=None):
    stamp = (sender_stamp(row["sender"], row["alias"])
             if row["sender"] != "relay" else
             {"box": "relay", "display_name": "relay", "member_no": None,
              "team": None, "platform": "relay", "role": "", "is_human": False})
    kind = row["kind"]
    dkey = "system" if kind == "system" else row["delivered_as"]
    e = {"id": row["id"], "ts": row["ts"], "kind": kind, "from": stamp,
         "reply_to": row["reply_to"],
         "to": json.loads(row["to_json"]), "cc": json.loads(row["cc_json"]),
         "delivered_as": row["delivered_as"], "directive": DIRECTIVES[dkey],
         "body": row["body"]}
    if stamp["team"]:
        t = db().execute("SELECT name, rv FROM teams WHERE code=?",
                         (stamp["team"],)).fetchone()
        rv = t["rv"] if t else 1
        tname = (t["name"] if t and t["name"] else stamp["team"])
        n = db().execute("SELECT count(*) c FROM boxes WHERE team_code=?",
                         (stamp["team"],)).fetchone()["c"]
        rb = box_row(recipient) if recipient else None
        # Full card once per recipient per roster version; brief line after.
        if rb is not None and (rb["seen_rv"] or 0) < rv:
            e["team_info"] = team_card(stamp["team"])
            db().execute("UPDATE boxes SET seen_rv=? WHERE box=?",
                         (rv, recipient))
            db().commit()
        else:
            e["team_info"] = (f"team {tname} · {stamp['team']} · {n} members "
                              f"· roster v{rv} · list_team('{stamp['team']}') "
                              "for detail")
    return e


def fetch_box(box, take: bool):
    conn = db()
    rows = conn.execute(
        "SELECT m.*, d.delivered_as FROM deliveries d JOIN messages m ON m.id=d.msg_id "
        "WHERE d.recipient=? AND d.taken_ts IS NULL ORDER BY m.id", (box,)).fetchall()
    out = [envelope(r, recipient=box) for r in rows]
    if take and rows:
        conn.executemany(
            "UPDATE deliveries SET taken_ts=? WHERE msg_id=? AND recipient=?",
            [(now(), r["id"], box) for r in rows])
        conn.commit()
    return out


def board_reminder(box):
    """Harness-style ephemeral nudge: hold no task + board has ready work."""
    b = box_row(box)
    if not (b and b["team_code"]):
        return None
    holds = db().execute("SELECT count(*) n FROM tasks WHERE owner=? AND "
                         "status='claimed'", (box,)).fetchone()["n"]
    if holds:
        return None
    ready = [t for t in db().execute(
        "SELECT * FROM tasks WHERE team=? AND status='open' "
        "ORDER BY priority, id", (b["team_code"],))
        if task_deps_done(t) and (not t["owner"] or t["owner"] == box)]
    if not ready:
        return None
    return {
        "id": 0, "kind": "system", "ephemeral": True,
        "from": {"box": "relay", "display_name": "relay", "platform": "relay",
                 "member_no": None, "team": b["team_code"], "role": "",
                 "is_human": False},
        "to": [box], "cc": [], "delivered_as": "to",
        "directive": DIRECTIVES["system"],
        "body": ("BOARD REMINDER: you hold no task and the board has "
                 f"{len(ready)} ready (first: #{ready[0]['id']} "
                 f"\"{ready[0]['title']}\"). If nothing in this mail changes "
                 "your priorities, task_claim one now instead of going idle. "
                 "Do not ack this reminder — it is not stored.")}


async def do_poll(box, wait_s: int, take: bool):
    """take=True: legacy auto-take. take=False: ack model — messages stay
    pending until do_ack; replays return the same ids."""
    touch_box(box)
    # last_poll is the liveness signal for delivery_status: only real polling
    # updates it, so registering or sending never fakes "a watcher is alive".
    db().execute("UPDATE boxes SET last_poll=? WHERE box=?", (now(), box))
    db().commit()
    deadline = time.monotonic() + min(max(wait_s, 0), MAX_WAIT)
    while True:
        msgs = fetch_box(box, take=take)
        if msgs or time.monotonic() >= deadline:
            return msgs
        await asyncio.sleep(1.0)


def do_ack(box, through_id):
    """Cursor ack: mark all deliveries for `box` with msg_id <= through_id as
    processed. Idempotent — re-acking already-acked ids is a no-op."""
    try:
        through_id = int(through_id)
    except (TypeError, ValueError):
        return {"error": "bad_through_id"}
    conn = db()
    cur = conn.execute(
        "UPDATE deliveries SET taken_ts=? WHERE recipient=? AND taken_ts IS NULL "
        "AND msg_id<=?", (now(), box, through_id))
    conn.commit()
    return {"ok": True, "acked": cur.rowcount, "through_id": through_id}


# ---------------- registration / pools / teams ----------------

def name_conflict(name, own_box):
    """Another box whose display name matches `name` (case-insensitive)."""
    if not name:
        return None
    low = name.strip().lower()
    for r in db().execute("SELECT * FROM boxes"):
        if r["box"] == own_box:
            continue
        if display_name(r).strip().lower() == low:
            return r["box"]
    return None


def do_register(box, session_name, platform, environment, pool_code, role="",
                override_name=False):
    if box:
        if box == OWNER_BOX or not BOX_RE.match(box):
            return {"error": "bad_box", "detail": "'owner' reserved; " + BOX_RE.pattern}
        if box_row(box) is None:
            return {"error": "unknown_box",
                    "detail": ("box ids are assigned by the server. Omit "
                               "box_id on first registration and SAVE the id "
                               "you get back; pass it only to re-register.")}
    if platform not in PLATFORMS:
        return {"error": "bad_platform",
                "detail": f"declare your platform: one of {PLATFORMS}. This is "
                          "mandatory so teammates know what they are talking to."}
    if role and role not in ROLES:
        return {"error": "bad_role", "detail": f"role is optional; one of {ROLES}"}
    if not CODE_RE.match(str(pool_code or "")):
        return {"error": "bad_pool_code",
                "detail": "pool_code is the 4-digit code the owner gave you; "
                          "you cannot enter the waiting pool without it"}
    prev_b = box_row(box) if box else None
    same_name = (prev_b is not None and str(session_name or "").strip().lower()
                 == (prev_b["session_name"] or "").strip().lower())
    clash = None if same_name else name_conflict(str(session_name or ""), box)
    if clash and not override_name:
        return {"error": "name_taken", "conflict_with": clash,
                "directive": ("NAME COLLISION: another member already displays "
                              "as this name (box " + clash + "). TELL THE OWNER "
                              "and ask how to proceed. If the owner explicitly "
                              "approves the duplicate, call register_box again "
                              "with override_name=true; otherwise pick a "
                              "different session_name.")}
    if not box:
        while True:
            box = "bx-" + secrets.token_hex(3)
            if box_row(box) is None:
                break
    b = box_row(box)
    status = "waiting" if not (b and b["team_code"]) else b["status"]
    touch_box(box, session_name=str(session_name or "")[:200], platform=platform,
              env=str(environment or "")[:500], status=status, role=role)
    db().execute("UPDATE boxes SET pool_code=? WHERE box=?", (str(pool_code), box))
    db().commit()
    return {"ok": True, "box": box, "status": status, "pool_code": str(pool_code),
            "role": role or "(none)",
            "say_to_owner": (f"Joined crew pool {pool_code} as {box} "
                             f"({platform}). Waiting — tell one session "
                             f"\"crew setup {pool_code}\" when everyone is in."),
            "relay_rule": RELAY_RULE,
            "directive": ("YOUR BOX ID IS " + box + " — SAVE IT, it is your "
                          "permanent address (re-register with box_id=" + box +
                          " after restarts). REGISTERED INTO WAITING POOL " +
                          str(pool_code) +
                          ". Now poll your box (check_mail) and WAIT. Do not "
                          "send mail yet. When the owner initializes the team "
                          "you will receive a SYSTEM NOTICE with your member "
                          "number and team id.")}


def do_pool(pool_code):
    if not CODE_RE.match(str(pool_code)):
        return {"error": "bad_pool_code"}
    rows = db().execute(
        "SELECT * FROM boxes WHERE status='waiting' AND pool_code=? "
        "ORDER BY created_ts", (str(pool_code),)).fetchall()
    return {"pool_code": str(pool_code), "waiting_count": len(rows),
            "waiting": [{"box": r["box"], "session_name": r["session_name"],
                         "platform": r["platform"] or "unknown",
                         "role": r["role"] or "(none)",
                         "environment": r["env"], "registered": r["created_ts"],
                         "last_seen": r["last_seen"]} for r in rows]}


def team_roster(code, view="full"):
    rows = db().execute(
        "SELECT * FROM boxes WHERE team_code=? ORDER BY member_no", (code,)).fetchall()
    t = db().execute("SELECT * FROM teams WHERE code=?", (code,)).fetchone()
    pending = {r["box"]: db().execute(
        "SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
        (r["box"],)).fetchone()["n"] for r in rows}
    if view == "brief":
        return {
            "team_code": code,
            "team_name": t["name"] if t else "",
            "roster_v": t["rv"] if t else 1,
            "members": [
                f"#{r['member_no'] or 0} {display_name(r)} · box:{r['box']} · "
                f"{r['role'] or ('owner' if r['box'] == OWNER_BOX else '-')} · "
                f"{'human' if r['is_human'] else (r['platform'] or 'unknown')}"
                for r in rows],
            "pending_total": sum(pending.values()),
            "say_to_owner": roster_text(code),
            "relay_rule": RELAY_RULE,
        }
    return {
        "team_code": code,
        "team_name": t["name"] if t else "",
        "coordinator": t["coordinator"] if t else "",
        "members": [{
            "member_no": r["member_no"], "box": r["box"],
            "display_name": display_name(r),
            "alias_explicit": bool(r["alias"]),
            "session_name": r["session_name"],
            "role": r["role"] or ("owner" if r["box"] == OWNER_BOX else ""),
            "is_human": bool(r["is_human"]),
            "platform": r["platform"] or "unknown",
            "environment": r["env"],
            "last_seen": r["last_seen"], "pending_mail": pending[r["box"]],
            "stale": bool(r["stale"]),
        } for r in rows],
        "team_card": team_card(code),
        "say_to_owner": roster_text(code),
        "relay_rule": RELAY_RULE,
    }



def roster_text(code):
    """Canonical human-facing roster. Everything that shows the team to the
    owner uses THIS, so it always looks the same everywhere. Queries the DB
    directly — team_roster embeds this output, so it must not call back."""
    t = db().execute("SELECT * FROM teams WHERE code=?", (code,)).fetchone()
    name = (t["name"] if t and t["name"] else "(unnamed)")
    lines = [f"team {name} · {code}"]
    for r in db().execute("SELECT * FROM boxes WHERE team_code=? "
                          "ORDER BY member_no", (code,)):
        pending = db().execute(
            "SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
            (r["box"],)).fetchone()["n"]
        kind = "human" if r["is_human"] else (r["platform"] or "unknown")
        role = r["role"] or ("owner" if r["box"] == OWNER_BOX else "-")
        bits = [f"#{r['member_no'] or 0} {display_name(r)}", r["box"], role, kind]
        if r["env"] and not r["is_human"]:
            bits.append(r["env"])
        tail = []
        if pending:
            tail.append(f"{pending} unread")
        ntasks = db().execute("SELECT count(*) n FROM tasks WHERE owner=? AND "
                              "status='claimed'", (r["box"],)).fetchone()["n"]
        if ntasks:
            tail.append(f"{ntasks} task{'s' if ntasks > 1 else ''}")
        if r["stale"]:
            tail.append("STALE — not polling")
        lines.append("  " + " · ".join(bits) +
                     (f"   [{', '.join(tail)}]" if tail else ""))
    return "\n".join(lines)


def do_initialize_team(pool_code, coordinator_box):
    if not CODE_RE.match(str(pool_code)):
        return {"error": "bad_pool_code", "detail": "pool code is exactly 4 digits"}
    pool_code = str(pool_code)
    conn = db()
    coord = box_row(coordinator_box)
    if coord is None or coord["status"] != "waiting" or coord["pool_code"] != pool_code:
        return {"error": "not_in_pool",
                "detail": "coordinator must be registered in this waiting pool"}
    while True:
        code = "tm-" + secrets.token_hex(3)
        if not conn.execute("SELECT 1 FROM teams WHERE code=?", (code,)).fetchone():
            break
    waiting = conn.execute(
        "SELECT * FROM boxes WHERE status='waiting' AND pool_code=? "
        "ORDER BY created_ts", (pool_code,)).fetchall()
    conn.execute("INSERT INTO teams(code,name,pool_code,coordinator,created_ts,"
                 "view_key) VALUES(?,?,?,?,?,?)",
                 (code, "", pool_code, coordinator_box, now(),
                  secrets.token_hex(3)))
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
                    f"TEAM FORMED from pool {pool_code}. You are member #{i} of "
                    f"team {code} ({len(ordered)} members; coordinator: "
                    f"{coordinator_box}). KEEP POLLING your box; setup notices "
                    f"will follow. Use list_team('{code}') for the roster. "
                    "BOARD DISCIPLINE from now on: shared work lives on the "
                    "team task board (task_add / task_claim / task_progress / "
                    "task_done), handoff mail auto-files tasks, discovered "
                    "work gets filed not chased, and when you hold no task "
                    "you claim a ready one before going idle. Private todo "
                    "tools are only for micro-steps inside your claimed task.")
    wiz_save(code, "", {}, 0)
    return {"ok": True, **team_roster(code),
            "directive": ("TEAM CREATED AND YOU ARE THE COORDINATOR (member #1). "
                          "NOW RUN THE SETUP CENTER WITH THE OWNER, IN ORDER: "
                          "1) ask for a team name -> set_team_name. "
                          "2) read the roster to the owner, ask per-member "
                          "aliases (skipping keeps '<team_name>-<no>') -> "
                          "set_member_alias. "
                          "3) ask which member is MANAGER (usually one) and "
                          "which are WORKERS, or none -> set_box_role. "
                          "4) ask whether to attach the owner mailbox -> "
                          "attach_owner_to_team (set it up first if missing). "
                          "NOW CALL setup_next(\"" + code + "\") AND RUN THE "
                          "INTERVIEW: it hands you one question at a time to "
                          "read to the owner verbatim (name, member aliases, "
                          "manager/worker, owner mailbox, contact rules). "
                          "Configuration setters are REFUSED until that "
                          "interview is finished — this is not free-form "
                          "work. Setup is revisitable: "
                          "setup_next(restart=true).")}


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
    bump_rv(code)
    broadcast_team(code, f"TEAM UPDATE: box '{box}' joined as member #{nxt}.\n\n"
                         + team_card(code))
    return {"ok": True, "member_no": nxt, **team_roster(code)}


def do_set_team_name(code, name):
    code = str(code)
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (code,)).fetchone():
        return {"error": "no_such_team"}
    db().execute("UPDATE teams SET name=? WHERE code=?", (str(name)[:100], code))
    db().commit()
    bump_rv(code)
    broadcast_team(code, f"SETUP CHANGE: team {code} is now named '{name}'. "
                         "Unaliased members display as '<name>-<no>'.\n\n"
                         + team_card(code))
    return {"ok": True, **team_roster(code)}


def do_set_member_alias(code, member_no, alias, override_name=False):
    code = str(code)
    r = db().execute("SELECT * FROM boxes WHERE team_code=? AND member_no=?",
                     (code, int(member_no))).fetchone()
    if not r:
        return {"error": "no_such_member"}
    clash = name_conflict(str(alias or ""), r["box"])
    if clash and not override_name:
        return {"error": "name_taken", "conflict_with": clash,
                "directive": ("NAME COLLISION: another member already displays "
                              "as this name (box " + clash + "). READ THIS TO "
                              "THE OWNER; only if the owner explicitly approves "
                              "the duplicate, call again with "
                              "override_name=true.")}
    db().execute("UPDATE boxes SET alias=? WHERE box=?", (str(alias)[:200], r["box"]))
    db().commit()
    bump_rv(code)
    broadcast_team(code, f"SETUP CHANGE: member #{member_no} ({r['box']}) is "
                         f"now named '{alias}'.\n\n" + team_card(code))
    return {"ok": True, **team_roster(code)}


def do_set_box_role(code, member_no, role):
    code = str(code)
    if role not in ROLES:
        return {"error": "bad_role", "detail": f"one of {ROLES}"}
    r = db().execute("SELECT * FROM boxes WHERE team_code=? AND member_no=?",
                     (code, int(member_no))).fetchone()
    if not r:
        return {"error": "no_such_member"}
    db().execute("UPDATE boxes SET role=? WHERE box=?", (role, r["box"]))
    db().commit()
    bump_rv(code)
    extra = ("HARD RULE now active for this member: workers never contact the "
             "owner; they report to the manager." if role == "worker" else
             "This member now handles owner contact for the team.")
    broadcast_team(code, f"SETUP CHANGE: member #{member_no} ({r['box']}) role "
                         f"= {role.upper()}. {extra}\n\n" + team_card(code))
    return {"ok": True, **team_roster(code)}


def do_attach_owner(code):
    code = str(code)
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (code,)).fetchone():
        return {"error": "no_such_team"}
    o = owner_row()
    if not (o and o["confirmed"]):
        return {"error": "owner_not_configured",
                "detail": "set up and confirm the owner mailbox first "
                          "(setup_owner_mailbox -> owner confirms -> "
                          "confirm_owner_mailbox)"}
    db().execute("UPDATE boxes SET team_code=?, member_no=0, status='teamed' "
                 "WHERE box=?", (code, OWNER_BOX))
    db().commit()
    bump_rv(code)
    mode = o["mode"]
    rules = o["custom_rules"] or OWNER_MODES[mode]["rules"]
    broadcast_team(code,
                   f"OWNER ATTACHED to team {code}: {o['alias']} "
                   f"({o['full_name']}) — owner + human, reachable as box "
                   f"'owner' (delivered by real email; a sent email counts as "
                   f"read). OWNER CONTACT RULES (mode {mode}, HARD):\n{rules}"
                   f"\n\n{team_card(code)}")
    return {"ok": True, **team_roster(code)}



def do_thread(mid, limit=50):
    """Whole conversation around one message: ancestors up to the root, then
    every descendant, chronological. Flat mail stays flat; replies chain."""
    try:
        mid = int(mid)
    except (TypeError, ValueError):
        return {"error": "bad_id"}
    root = db().execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    if not root:
        return {"error": "no_such_message"}
    seen_up = 0
    while root["reply_to"] and seen_up < limit:
        parent = db().execute("SELECT * FROM messages WHERE id=?",
                              (root["reply_to"],)).fetchone()
        if not parent:
            break
        root = parent
        seen_up += 1
    chain, queue = [], [root["id"]]
    while queue and len(chain) < limit:
        nid = queue.pop(0)
        r = db().execute("SELECT * FROM messages WHERE id=?", (nid,)).fetchone()
        if r:
            chain.append(r)
            queue.extend(x["id"] for x in db().execute(
                "SELECT id FROM messages WHERE reply_to=? ORDER BY id", (nid,)))
    out = []
    for r in sorted(chain, key=lambda x: x["id"]):
        s = sender_stamp(r["sender"], r["alias"]) if r["sender"] != "relay" else \
            {"box": "relay", "display_name": "relay", "platform": "relay",
             "member_no": None, "team": None, "role": "", "is_human": False}
        out.append({"id": r["id"], "ts": r["ts"], "kind": r["kind"],
                    "reply_to": r["reply_to"], "from": s,
                    "to": json.loads(r["to_json"]), "cc": json.loads(r["cc_json"]),
                    "body": r["body"]})
    return {"root": out[0]["id"] if out else None, "messages": out}




def team_view_key(code):
    """Per-team 6-char read key for the human board site. Generated lazily
    for teams that predate the feature."""
    t = db().execute("SELECT view_key FROM teams WHERE code=?", (code,)).fetchone()
    if not t:
        return None
    if t["view_key"]:
        return t["view_key"]
    k = secrets.token_hex(3)
    db().execute("UPDATE teams SET view_key=? WHERE code=?", (k, code))
    db().commit()
    return k


def resolve_view_key(key):
    r = db().execute("SELECT code FROM teams WHERE view_key=?",
                     (str(key).strip().lower(),)).fetchone()
    return r["code"] if r else None


def team_manager_box(code):
    r = db().execute("SELECT box FROM boxes WHERE team_code=? AND role='manager' "
                     "AND box!=? LIMIT 1", (code, OWNER_BOX)).fetchone()
    if r:
        return r["box"]
    t = db().execute("SELECT coordinator FROM teams WHERE code=?", (code,)).fetchone()
    return t["coordinator"] if t else None


def stale_sweep():
    """Flag teamed agents that stopped polling; tell the manager. Clears the
    flag (with a notice) the moment they poll again."""
    now_dt = datetime.now(timezone.utc)
    for b in db().execute("SELECT * FROM boxes WHERE team_code IS NOT NULL "
                          "AND is_human=0").fetchall():
        ref = b["last_poll"] or b["last_seen"]
        try:
            idle = (now_dt - datetime.fromisoformat(ref)).total_seconds()
        except Exception:
            continue
        mgr = team_manager_box(b["team_code"])
        if idle > STALE_AFTER and not b["stale"]:
            db().execute("UPDATE boxes SET stale=1 WHERE box=?", (b["box"],))
            db().commit()
            if mgr and mgr != b["box"]:
                held = [f"#{t['id']} {t['title']}" for t in db().execute(
                    "SELECT id,title FROM tasks WHERE owner=? AND status='claimed'",
                    (b["box"],))]
                extra = (" They hold claimed tasks: " + "; ".join(held) +
                         " — reassign with task_done or a new task if needed."
                         if held else "")
                system_mail(mgr,
                            f"MEMBER STALE: {display_name(b)} (box {b['box']}, "
                            f"#{b['member_no']}) has not polled for "
                            f"{int(idle // 60)} min. Work assigned to them may "
                            f"be sitting unread.{extra}")
        elif idle <= STALE_AFTER and b["stale"]:
            db().execute("UPDATE boxes SET stale=0 WHERE box=?", (b["box"],))
            db().commit()
            if mgr and mgr != b["box"]:
                system_mail(mgr, f"MEMBER BACK: {display_name(b)} "
                                 f"(box {b['box']}) is polling again.")


def stale_loop():
    while True:
        try:
            stale_sweep()
        except Exception:
            pass
        try:
            task_stall_sweep()
        except Exception:
            pass
        time.sleep(60)


def do_boxes():
    conn = db()
    result = {}
    for b in conn.execute("SELECT * FROM boxes ORDER BY box"):
        pending = conn.execute(
            "SELECT count(*) AS n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
            (b["box"],)).fetchone()["n"]
        result[b["box"]] = {
            "display_name": display_name(b) or None,
            "platform": ("human" if b["is_human"] else (b["platform"] or "unknown")),
            "role": b["role"] or None,
            "status": b["status"], "team": b["team_code"],
            "member_no": b["member_no"], "pending": pending,
            "last_seen": b["last_seen"],
        }
    return result


def do_history(box, limit=50):
    conn = db()
    rows = conn.execute(
        "SELECT m.*, d.delivered_as, d.taken_ts, d.email_status FROM deliveries d "
        "JOIN messages m ON m.id=d.msg_id WHERE d.recipient=? "
        "ORDER BY m.id DESC LIMIT ?", (box, min(max(limit, 1), 500))).fetchall()
    out = []
    for r in rows:
        e = envelope(r)
        e["taken_ts"] = r["taken_ts"]
        if r["email_status"]:
            e["email_status"] = r["email_status"]
        out.append(e)
    sent = conn.execute(
        "SELECT * FROM messages WHERE sender=? ORDER BY id DESC LIMIT ?",
        (box, min(max(limit, 1), 500))).fetchall()
    sent_out = [{"id": r["id"], "ts": r["ts"], "kind": r["kind"],
                 "to": json.loads(r["to_json"]), "cc": json.loads(r["cc_json"]),
                 "body": r["body"]} for r in sent]
    return {"received": out, "sent": sent_out}





# ---------------- say_to_owner: the server writes what the human hears ------
# The owner should only ever have to say "crew onboard 1111" / "crew setup
# 1111". Every status line, question and confirmation is authored HERE and
# relayed verbatim, so no session has to invent phrasing or be told how to
# behave by the human.
RELAY_RULE = ("Show `say_to_owner` to the human EXACTLY as written and say "
              "nothing else — no preamble, no summary, no invented status. "
              "Translate it if the human is writing in another language, but "
              "keep every fact and option identical.")


def find_team_by_pool(pool_code):
    r = db().execute("SELECT code FROM teams WHERE pool_code=? "
                     "ORDER BY created_ts DESC LIMIT 1", (str(pool_code),)).fetchone()
    return r["code"] if r else None



# ---------------- task board ------------------------------------------------
# Design distilled from agent-teams, the harness task tools, and beads:
#   - atomic claim (no two members grab the same work)
#   - ready-work detection: deps are ids that must all be done first; deps may
#     only reference EXISTING tasks, so the graph is a DAG by construction
#   - anti-drift: board lives in the same SQLite as mail, survives everything
#   - anti-"forgot to mark done": claimed tasks go STALLED after silence and
#     the manager is told (the documented agent-teams failure mode)
#   - discovered work: file it with discovered_from instead of doing it now

def task_row(tid):
    return db().execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()


def task_deps_done(t):
    deps = json.loads(t["deps"])
    if not deps:
        return True
    rows = db().execute(
        "SELECT count(*) n FROM tasks WHERE id IN (%s) AND status='done'"
        % ",".join("?" * len(deps)), deps).fetchone()
    return rows["n"] == len(deps)


def team_agent_boxes(code):
    return [r["box"] for r in db().execute(
        "SELECT box FROM boxes WHERE team_code=? AND is_human=0", (code,))]


def do_task_add(team, title, detail, created_by, deps=None, assign_to="",
                priority=2, discovered_from=None):
    team = str(team)
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (team,)).fetchone():
        return {"error": "no_such_team"}
    if not str(title).strip():
        return {"error": "empty_title"}
    deps = deps or []
    if not isinstance(deps, list):
        return {"error": "bad_deps", "detail": "deps is a list of task ids"}
    try:
        deps = [int(d) for d in deps]
    except (TypeError, ValueError):
        return {"error": "bad_deps"}
    for d in deps:
        r = task_row(d)
        if not r or r["team"] != team:
            return {"error": "bad_deps", "detail": f"no task #{d} in this team"}
    if assign_to:
        a = box_row(assign_to)
        if not a or a["team_code"] != team:
            return {"error": "bad_assignee",
                    "detail": "assign_to must be a member box of this team"}
        cb = box_row(created_by)
        if (cb and cb["role"] == "worker" and assign_to != created_by):
            return {"error": "chain_of_command",
                    "directive": ("HARD RULE: workers do not assign work to "
                                  "others. Add the task unassigned (anyone "
                                  "claims), reserve it for yourself, or send "
                                  "a `question` to your MANAGER proposing the "
                                  "assignment.")}
    try:
        priority = int(priority)
        assert priority in (1, 2, 3)
    except (AssertionError, TypeError, ValueError):
        return {"error": "bad_priority", "detail": "1=high 2=normal 3=low"}
    if discovered_from is not None and not task_row(discovered_from):
        return {"error": "bad_discovered_from"}
    cur = db().execute(
        "INSERT INTO tasks(team,title,detail,deps,owner,status,priority,"
        "created_by,discovered_from,created_ts,updated_ts) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (team, str(title)[:200], str(detail)[:2000], json.dumps(deps),
         assign_to or None, "open", priority, created_by, discovered_from,
         now(), now()))
    db().commit()
    tid = cur.lastrowid
    t = task_row(tid)
    if assign_to and task_deps_done(t):
        system_mail(assign_to,
                    f"TASK ASSIGNED: #{tid} \"{title}\" is reserved for you "
                    f"and ready now. Claim it with task_claim({tid}, "
                    f"your_box) when you start.")
    return {"ok": True, "task_id": tid,
            "ready": task_deps_done(t) and not assign_to,
            "reserved_for": assign_to or None}


def do_task_claim(tid, box):
    t = task_row(tid)
    if not t:
        return {"error": "no_such_task"}
    b = box_row(box)
    if not b or b["team_code"] != t["team"]:
        return {"error": "not_a_member"}
    if t["status"] == "done":
        return {"error": "already_done"}
    if t["status"] == "claimed":
        return {"error": "already_claimed", "by": t["owner"],
                "directive": ("Someone beat you to it. Call task_list to pick "
                              "another ready task — do NOT start this one.")}
    if t["owner"] and t["owner"] != box:
        return {"error": "reserved", "for": t["owner"]}
    if not task_deps_done(t):
        return {"error": "blocked",
                "deps": [d for d in json.loads(t["deps"])
                         if (task_row(d) or {"status": ""})["status"] != "done"]}
    cur = db().execute(
        "UPDATE tasks SET owner=?, status='claimed', stalled=0, updated_ts=? "
        "WHERE id=? AND status='open' AND (owner IS NULL OR owner=?)",
        (box, now(), tid, box))
    db().commit()
    if cur.rowcount == 0:   # lost the race atomically
        t = task_row(tid)
        return {"error": "already_claimed", "by": t["owner"],
                "directive": "Someone beat you to it; pick another ready task."}
    return {"ok": True, "task_id": tid, "title": t["title"],
            "detail": t["detail"],
            "directive": ("Task claimed. Break it into micro-steps with your "
                          "session's own todo tools if you like — but the "
                          "board holds only THIS shared unit. task_progress "
                          "a one-line note at least hourly so it never shows "
                          "stalled, and task_done(result=...) the moment it "
                          "is finished — a forgotten close is the #1 way "
                          "agent teams jam.")}


def do_task_progress(tid, box, note):
    t = task_row(tid)
    if not t:
        return {"error": "no_such_task"}
    if t["owner"] != box or t["status"] != "claimed":
        return {"error": "not_yours"}
    db().execute("UPDATE tasks SET last_note=?, stalled=0, updated_ts=? WHERE id=?",
                 (str(note)[:300], now(), tid))
    db().commit()
    return {"ok": True}


def do_task_done(tid, box, result):
    t = task_row(tid)
    if not t:
        return {"error": "no_such_task"}
    b = box_row(box)
    is_mgr = b and b["team_code"] == t["team"] and b["role"] == "manager"
    if t["owner"] != box and not is_mgr:
        return {"error": "not_yours",
                "detail": "only the claimer or the manager may close a task"}
    if t["status"] == "done":
        return {"ok": True, "already": True}
    db().execute("UPDATE tasks SET status='done', result=?, stalled=0, "
                 "updated_ts=? WHERE id=?", (str(result)[:1000], now(), tid))
    db().commit()
    unlocked = []
    for r in db().execute("SELECT * FROM tasks WHERE team=? AND status='open'",
                          (t["team"],)):
        if tid in json.loads(r["deps"]) and task_deps_done(r):
            unlocked.append(r)
    for r in unlocked:
        if r["owner"]:
            system_mail(r["owner"],
                        f"TASK UNBLOCKED: #{r['id']} \"{r['title']}\" was "
                        f"waiting on #{tid} and is now ready. It is reserved "
                        f"for you — claim it when you start.")
        else:
            mgr = team_manager_box(t["team"])
            if mgr:
                system_mail(mgr,
                            f"TASK UNBLOCKED: #{r['id']} \"{r['title']}\" is "
                            f"now ready and unassigned. Assign it or let "
                            f"someone self-claim.")
    nxt = [dict(id=r["id"], title=r["title"]) for r in db().execute(
        "SELECT * FROM tasks WHERE team=? AND status='open' ORDER BY priority, id",
        (t["team"],)) if task_deps_done(r) and (not r["owner"] or r["owner"] == box)]
    return {"ok": True, "task_id": tid, "unblocked": [r["id"] for r in unlocked],
            "next_ready": nxt[:5],
            "directive": ("Task closed. SELF-CLAIM RULE: if next_ready lists "
                          "anything, claim one and keep working; only go idle "
                          "when it is empty. Check mail first in case "
                          "priorities changed.")}



def mail_task_hook(sender, to, template, fields):
    """Mail and board stay one system: a handoff files a task for the
    recipient; a result naming 'task #N' closes it."""
    b = box_row(sender)
    if not (b and b["team_code"]):
        return {}
    team = b["team_code"]
    if template == "handoff":
        assignee = ""
        for r in to:
            rb = box_row(r)
            if rb and rb["team_code"] == team:
                assignee = r
                break
        r = do_task_add(team, fields.get("task", "")[:200],
                        (fields.get("context", "") + "\ndeliverable: " +
                         fields.get("deliverable", ""))[:2000],
                        sender, None, assignee)
        if r.get("ok"):
            return {"task_id": r["task_id"],
                    "task_note": f"task #{r['task_id']} auto-created for this "
                                 "handoff; recipient should task_claim it"}
    if template == "result":
        m = re.search(r"#?(\d+)", str(fields.get("task", "")))
        if m:
            t = task_row(int(m.group(1)))
            if t and t["team"] == team and t["status"] != "done":
                r = do_task_done(int(m.group(1)), sender,
                                 fields.get("outcome", "")[:200])
                if r.get("ok"):
                    return {"task_closed": t["id"],
                            "next_ready": r.get("next_ready", [])}
    return {}


def board_text(team):
    """Canonical task board rendering — same everywhere (tool, TUI, web)."""
    rows = db().execute("SELECT * FROM tasks WHERE team=? ORDER BY priority, id",
                        (team,)).fetchall()
    if not rows:
        return f"task board · {team}\n  (no tasks yet — task_add to create one)"
    P = {1: "high", 2: "", 3: "low"}
    ready, working, blocked, done = [], [], [], []
    for t in rows:
        pr = f" !{P[t['priority']]}" if t["priority"] == 1 else \
             (" ~low" if t["priority"] == 3 else "")
        if t["status"] == "done":
            done.append(f"  ✓ #{t['id']} {t['title']}"
                        + (f" — {t['result'][:60]}" if t["result"] else ""))
        elif t["status"] == "claimed":
            age = ""
            try:
                mins = int((datetime.now(timezone.utc) -
                            datetime.fromisoformat(t["updated_ts"])).total_seconds() // 60)
                age = f", {mins}m since update"
            except Exception:
                pass
            o = box_row(t["owner"])
            who = display_name(o) if o else t["owner"]
            flag = " ⚠STALLED" if t["stalled"] else ""
            note = f" — {t['last_note']}" if t["last_note"] else ""
            working.append(f"  ▶ #{t['id']}{pr} {t['title']} ({who}{age}){flag}{note}")
        elif task_deps_done(t):
            tag = f" [reserved: {t['owner']}]" if t["owner"] else ""
            ready.append(f"  ○ #{t['id']}{pr} {t['title']}{tag}")
        else:
            pend = [str(d) for d in json.loads(t["deps"])
                    if (task_row(d) or {"status": ""})["status"] != "done"]
            blocked.append(f"  ⊘ #{t['id']}{pr} {t['title']} (waiting on #"
                           + ", #".join(pend) + ")")
    out = [f"task board · {team}"]
    if ready:
        out.append("READY TO CLAIM:")
        out += ready
    if working:
        out.append("IN PROGRESS:")
        out += working
    if blocked:
        out.append("BLOCKED:")
        out += blocked
    if done:
        out.append(f"DONE ({len(done)}):")
        out += done[-5:]
    return "\n".join(out)


def task_stall_sweep():
    """Claimed tasks silent too long -> stalled + manager notice. Fixes the
    documented agent-teams jam where a forgotten 'done' blocks everyone."""
    now_dt = datetime.now(timezone.utc)
    for t in db().execute("SELECT * FROM tasks WHERE status='claimed' AND stalled=0"):
        try:
            idle = (now_dt - datetime.fromisoformat(t["updated_ts"])).total_seconds()
        except Exception:
            continue
        if idle > TASK_STALL_AFTER:
            db().execute("UPDATE tasks SET stalled=1 WHERE id=?", (t["id"],))
            db().commit()
            mgr = team_manager_box(t["team"])
            o = box_row(t["owner"])
            for target in {mgr, t["owner"]} - {None}:
                system_mail(target,
                            f"TASK STALLED: #{t['id']} \"{t['title']}\" "
                            f"(claimed by {display_name(o) if o else t['owner']}) "
                            f"has had no progress note for "
                            f"{int(idle // 3600)}h+. If it is actually done, "
                            f"close it with task_done; if abandoned, the "
                            f"manager should reassign it.")


# ---------------- message templates (structure, not prose) -----------------
# Free-form mail between agents drifts into essays and buries the ask. A
# template is required for every message except "note": the server renders a
# fixed shape and refuses missing fields, so recipients always know what they
# are looking at and what is wanted from them.
TEMPLATES = {
    "status": {"fields": ["done", "next"], "optional": ["blockers", "eta"],
               "use": "routine progress update"},
    "milestone": {"fields": ["headline", "detail"], "optional": ["numbers"],
                  "use": "a named checkpoint was reached (owner-worthy)"},
    "blocker": {"fields": ["blocked_on", "tried", "need"], "optional": ["impact"],
                "use": "work has stopped and you need something"},
    "question": {"fields": ["question", "why_it_matters"],
                 "optional": ["options", "your_recommendation"],
                 "use": "a decision you cannot make alone"},
    "handoff": {"fields": ["task", "context", "deliverable"],
                "optional": ["deadline", "constraints"],
                "use": "assigning work to someone"},
    "result": {"fields": ["task", "outcome"], "optional": ["evidence", "caveats"],
               "use": "reporting finished work back"},
    "note": {"fields": [], "optional": [], "use": "anything else; body is free text"},
}


def render_template(template, fields, body):
    t = TEMPLATES.get(template)
    if t is None:
        return None, {"error": "unknown_template",
                      "templates": {k: v["use"] for k, v in TEMPLATES.items()}}
    fields = fields or {}
    if template == "note":
        if not (body or "").strip():
            return None, {"error": "empty_body"}
        return f"[NOTE]\n{body.strip()}", None
    missing = [f for f in t["fields"] if not str(fields.get(f, "")).strip()]
    if missing:
        return None, {"error": "missing_fields", "template": template,
                      "missing": missing, "optional": t["optional"],
                      "detail": f"template '{template}' ({t['use']}) requires: "
                                + ", ".join(t["fields"])}
    lines = [f"[{template.upper()}]"]
    for f in t["fields"] + t["optional"]:
        v = str(fields.get(f, "")).strip()
        if v:
            label = f.replace("_", " ")
            lines.append(f"{label}: {v}" if "\n" not in v
                         else f"{label}:\n" + "\n".join("  " + l for l in v.splitlines()))
    if (body or "").strip():
        lines.append("")
        lines.append(body.strip())
    return "\n".join(lines), None



# ---------------- delivery modes: how a session actually hears mail --------
# Researched against the Claude Code and Codex docs. Sessions must never
# improvise this answer, and must never claim a push they do not have.
WATCH_SH = r'''#!/usr/bin/env bash
# crew Stop-hook watcher for Claude Code.
# Wire it once in ~/.claude/settings.json (or .claude/settings.json):
#   { "hooks": { "Stop": [ { "hooks": [
#       { "type": "command", "command": "~/.claude/crew-watch.sh" } ] } ] } }
# Then export CREW_URL / CREW_TOKEN / CREW_BOX in your shell profile.
# Behaviour: when a turn ends it checks crew; if mail is waiting it prints it
# and exits 2, which BLOCKS the stop and continues the conversation with that
# mail in context. No mail -> exit 0, the session ends normally.
set -uo pipefail
: "${CREW_URL:?}" "${CREW_TOKEN:?}" "${CREW_BOX:?}"
MAIL=$(curl -s -A crew-watch -H "Authorization: Bearer $CREW_TOKEN" \
  --max-time 20 "$CREW_URL/checkmail?box=$CREW_BOX&wait=0")
COUNT=$(printf '%s' "$MAIL" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("messages",[])))' 2>/dev/null || echo 0)
[ "$COUNT" = "0" ] && exit 0
printf '%s' "$MAIL" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for m in d["messages"]:
    f=m.get("from",{})
    print(f"[crew #{m[\'id\']} {m[\'delivered_as\'].upper()}] from {f.get(\'display_name\')} "
          f"({f.get(\'box\')}, {f.get(\'platform\')})")
    print(m.get("directive",""))
    print(m.get("body",""))
    print()
print("Handle this mail now, then ack_mail through id",
      max(m["id"] for m in d["messages"]))
' >&2
exit 2
'''

DELIVERY_MODES = {
    "pull_only": {
        "what": ("You hear mail only while you are taking a turn, by calling "
                 "check_mail yourself. Between turns you are deaf. This is "
                 "the default for every plain MCP connection."),
        "good_for": "occasional collaboration where the human is present",
    },
    "background_watcher": {
        "what": ("A background shell task blocks on a long-poll and finishes "
                 "the moment mail arrives; your harness notifies you, and you "
                 "read the mail then start another watcher. Near-instant, no "
                 "extra install, but it delivers BETWEEN turns, not during "
                 "one."),
        "claude_code": ("Run this with the Bash tool and "
                        "run_in_background=true, then start a fresh one each "
                        "time it fires:\n"
                        "  curl -s -H \"Authorization: Bearer $CREW_TOKEN\" "
                        "-A crew-watch \"$CREW_URL/checkmail?box=$CREW_BOX"
                        "&wait=55\"\n"
                        "It returns as soon as mail exists (or after 55s with "
                        "an empty list — just start another). Do not ack until "
                        "you have actually handled the mail."),
        "codex": ("Same idea with a shell command run in the background by "
                  "your harness, or simply loop the curl above between units "
                  "of work."),
    },
    "stop_hook": {
        "what": ("Claude Code only. A Stop hook runs when your turn ends: if "
                 "crew has mail it prints it and exits 2, which blocks the "
                 "stop and continues the conversation with that mail. Effect: "
                 "you never go idle with unread mail, and nothing has to stay "
                 "running."),
        "install": ("Download the script: curl -s <relay>/client/stop-hook -o "
                    "~/.claude/crew-watch.sh && chmod +x ~/.claude/crew-watch.sh"
                    "\nAdd to ~/.claude/settings.json:\n"
                    '  {"hooks":{"Stop":[{"hooks":[{"type":"command",'
                    '"command":"~/.claude/crew-watch.sh"}]}]}}\n'
                    "Export CREW_URL, CREW_TOKEN, CREW_BOX in your shell "
                    "profile. Takes effect in NEW sessions (hooks are read at "
                    "startup)."),
        "codex": ("Codex has lifecycle hooks too, but per the config "
                  "reference only command hooks run and no hook is documented "
                  "to block a turn or inject input — so this mode is Claude "
                  "Code only. Use the sidecar instead."),
    },
    "true_push": {
        "what": ("Mail is injected DURING a turn, mid-work. Requires a helper "
                 "process the operator starts outside the session — it cannot "
                 "be switched on from inside a conversation."),
        "claude_code": ("channel/bridge.ts from the cloud-bridge-relay repo, "
                        "started as: claude "
                        "--dangerously-load-development-channels "
                        "server:cloud-manager (channels are a research "
                        "preview; Team/Enterprise orgs need it enabled). "
                        "Requires a NEW session — you cannot attach a channel "
                        "to a session that is already running."),
        "codex": ("codex/sidecar.py from the same repo: it wraps `codex "
                  "app-server` and delivers each message with turn/steer "
                  "(injects into the in-flight turn) or turn/start when idle, "
                  "acking only after codex accepted it. Also requires "
                  "launching codex through the sidecar, i.e. a NEW session."),
    },
}


def delivery_report(box):
    b = box_row(box)
    if b is None:
        return {"error": "unknown_box", "detail": "register first"}
    pending = db().execute(
        "SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL",
        (box,)).fetchone()["n"]
    try:
        idle = int((datetime.now(timezone.utc)
                    - datetime.fromisoformat(b["last_poll"])).total_seconds())
    except Exception:
        idle = None
    # Only real polling updates last_poll, so this cannot be faked by
    # registering or sending mail.
    if idle is None:
        detected = "never_polled"
        health = ("This box has never polled. You are pull-only: nothing will "
                  "reach you unless you call check_mail yourself.")
    elif idle <= 120:
        detected = "watcher_or_bridge_running"
        health = (f"Something polled this box {idle}s ago, so a watcher or "
                  "bridge looks alive.")
    else:
        detected = "no_recent_polling"
        health = (f"Nothing has polled this box for {idle}s. If a watcher or "
                  "bridge was supposed to be running, IT IS PROBABLY DEAD — "
                  "tell the human plainly and offer to restart it. Otherwise "
                  "you are simply pull-only.")
    return {
        "box": box, "platform": b["platform"] or "unknown",
        "pending_mail": pending,
        "seconds_since_last_poll": idle if idle is not None else "never",
        "detected": detected,
        "liveness": health,
        "modes": DELIVERY_MODES,
        "say_to_owner": (
            f"Delivery check for {box} ({b['platform'] or 'unknown'}): "
            f"{pending} unread, "
            + (f"last polled {idle}s ago" if idle is not None else "never polled")
            + f" — {detected}.\n"
            "Options:\n"
            "  1. pull-only (now): I check crew when I'm working; between "
            "turns I hear nothing.\n"
            "  2. background watcher: I keep a long-poll running in the "
            "background and come back the moment mail lands — same session, "
            "nothing to install.\n"
            "  3. stop-hook (Claude Code): mail is delivered whenever a turn "
            "ends, so I never go idle with unread mail — one script + a "
            "settings.json entry, takes effect in a NEW session.\n"
            "  4. true push (mid-turn): needs a helper process started "
            "outside the session, so it means launching a NEW session through "
            "it — channel bridge for Claude Code, sidecar for Codex.\n"
            "Tell me a number and I'll set it up or give you the exact "
            "commands."),
        "relay_rule": RELAY_RULE,
    }


# ---------------- setup wizard (server-driven, one question at a time) ------
# The whole point: the flow is STATE ON THE SERVER, not advice in a prompt.
# A coordinator cannot configure a team by calling setters directly — those
# are refused until the wizard is finished. It must call setup_next, read the
# question to the owner VERBATIM, and submit the owner's answer.

def wiz_row(code):
    return db().execute("SELECT * FROM setup_state WHERE team_code=?",
                        (code,)).fetchone()


def wiz_answers(code):
    r = wiz_row(code)
    return json.loads(r["answers"]) if r else {}


def wiz_save(code, step_id, answers, done=0):
    db().execute(
        "INSERT INTO setup_state(team_code,step_id,answers,done,started_ts) "
        "VALUES(?,?,?,?,?) ON CONFLICT(team_code) DO UPDATE SET "
        "step_id=excluded.step_id, answers=excluded.answers, done=excluded.done",
        (code, step_id, json.dumps(answers), done, now()))
    db().commit()


def wiz_pending(code):
    """True while this team still has to go through the wizard."""
    r = wiz_row(code)
    return not (r and r["done"])


def wiz_steps(code):
    """Ordered step list for this team, computed from current state."""
    members = [m for m in team_roster(code, "full")["members"]
               if m["box"] != OWNER_BOX]
    t = db().execute("SELECT * FROM teams WHERE code=?", (code,)).fetchone()
    o = owner_row()
    steps = [{
        "id": "team_name",
        "ask": ("What should this team be called? (I'll use the name in every "
                "member's display name, e.g. \"<name>-2\".)"),
        "options": ["<any name>", "default"],
        "default": "crew-" + code.replace("tm-", ""),
        "answer_format": "a short name, or the word 'default'",
    }]
    for m in members:
        steps.append({
            "id": f"alias_{m['member_no']}",
            "ask": (f"Member #{m['member_no']} is box {m['box']} "
                    f"({m['platform']}, {m['environment'] or 'no env given'}"
                    + (f", session \"{m['session_name']}\"" if m["session_name"] else "")
                    + "). What name should they display as?"),
            "options": ["<any name>", "default"],
            "default": "",  # resolved at apply time -> <team>-<no>
            "answer_format": "a name, or 'default' to keep <team-name>-<number>",
        })
    steps.append({
        "id": "manager",
        "ask": ("Who handles contact with you (the owner)? Give the member "
                "number of the MANAGER — everyone else becomes a WORKER and "
                "is hard-blocked from mailing you. Answer 'none' for no "
                "chain of command."),
        "options": [str(m["member_no"]) for m in members] + ["none"],
        "default": "none",
        "answer_format": "a member number, or 'none'",
    })
    if not (o and o["confirmed"]):
        steps.append({
            "id": "owner_setup",
            "ask": ("No owner mailbox exists yet. Do you want one? It lets the "
                    "team reach you by real email, with rules about who may "
                    "write and when. Answer 'yes' to set it up now (I'll ask "
                    "for your name and email), or 'skip'."),
            "options": ["yes", "skip"], "default": "skip",
            "answer_format": "'yes' or 'skip'",
        })
    else:
        steps.append({
            "id": "owner_attach",
            "ask": (f"Attach your owner mailbox ({o['alias']} / {o['email']}) "
                    "to this team, so members can cc you?"),
            "options": ["yes", "no"], "default": "yes",
            "answer_format": "'yes' or 'no'",
        })
        steps.append({
            "id": "owner_mode",
            "ask": ("How should the team be allowed to contact you?\n"
                    "  a = milestones only (default): manager only, cc only, "
                    "direct mail needs a justification\n"
                    "  b = manager-open: manager only, direct mail allowed\n"
                    "  c = team-open: anyone may cc you, direct still justified\n"
                    "  d = custom: describe it in your own words and I'll turn "
                    "it into rules and read them back"),
            "options": ["a", "b", "c", "d"], "default": "a",
            "answer_format": "'a', 'b', 'c', or 'd' (for d, add your wording)",
        })
    return steps


def wiz_apply(code, step_id, answer):
    """Apply one answered step. Returns (ok, extra_dict_or_error)."""
    ans = (answer or "").strip()
    low = ans.lower()
    steps = {s["id"]: s for s in wiz_steps(code)}
    step = steps.get(step_id)
    if not step:
        return False, {"error": "unknown_step", "detail": list(steps)}
    use_default = low in ("default", "skip", "") and step_id != "owner_mode"
    if step_id == "team_name":
        do_set_team_name(code, step["default"] if use_default else ans)
    elif step_id.startswith("alias_"):
        if not use_default:
            no = int(step_id.split("_")[1])
            r = do_set_member_alias(code, no, ans, override_name=False)
            if r.get("error") == "name_taken":
                return False, {"error": "name_taken", "conflict_with": r.get("conflict_with"),
                               "ask_owner_verbatim": (
                                   f"The name \"{ans}\" is already used by another "
                                   "member. Pick a different one, or say "
                                   "'force' to use it anyway."),
                               "detail": "resubmit this same step_id with a new "
                                         "name, or with the word 'force'"}
        # 'force' path
        if low == "force":
            return False, {"error": "need_name_with_force",
                           "detail": "answer as 'force <name>'"}
    elif step_id == "manager":
        if low not in ("none", ""):
            try:
                mgr = int(low)
            except ValueError:
                return False, {"error": "bad_answer", "detail": step["answer_format"]}
            for m in team_roster(code, "full")["members"]:
                if m["box"] == OWNER_BOX:
                    continue
                do_set_box_role(code, m["member_no"],
                                "manager" if m["member_no"] == mgr else "worker")
    elif step_id == "owner_setup":
        if low == "yes":
            return True, {"handoff": "owner_mailbox",
                          "directive": ("The owner wants a mailbox. RUN THE "
                                        "add-owner-mailbox FLOW NOW "
                                        "(setup_owner_mailbox -> owner "
                                        "confirms receipt -> "
                                        "confirm_owner_mailbox), then call "
                                        "setup_next again — the wizard will "
                                        "pick up with attaching it.")}
    elif step_id == "owner_attach":
        if low in ("yes", "y"):
            do_attach_owner(code)
    elif step_id == "owner_mode":
        mode = low.split()[0] if low else "a"
        if mode not in OWNER_MODES:
            return False, {"error": "bad_answer", "detail": step["answer_format"]}
        if mode == "d":
            return True, {"handoff": "owner_mode_custom", "owner_words": ans,
                          "directive": ("Mode d: turn the owner's wording into "
                                        "(1) a short hard-rules text, (2) "
                                        "allow_senders manager_only|any, (3) "
                                        "allow_direct justified_only|free. READ "
                                        "THEM BACK, get an explicit yes, ask if "
                                        "it should be permanent, then call "
                                        "set_owner_mode(mode='d', ...). Then "
                                        "call setup_next again.")}
        do_set_owner_mode(mode)
    return True, {}


def wiz_next(code, restart=False):
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (code,)).fetchone():
        return {"error": "no_such_team"}
    if restart:
        wiz_save(code, "", {}, 0)
    answers = wiz_answers(code)
    for step in wiz_steps(code):
        if step["id"] in answers:
            continue
        wiz_save(code, step["id"], answers, 0)
        done_n, total = len(answers), len(wiz_steps(code))
        opts = " / ".join(step["options"])
        return {
            "step_id": step["id"],
            "progress": f"{done_n + 1}/{total}",
            "say_to_owner": (f"[setup {done_n + 1}/{total}] {step['ask']}\n"
                             f"({opts} — \"default\" = "
                             f"{step['default'] or '<team-name>-<number>'})"),
            "relay_rule": RELAY_RULE,
            "ask_owner_verbatim": step["ask"],
            "options": step["options"],
            "default_if_owner_says_default": step["default"] or "<team-name>-<number>",
            "answer_format": step["answer_format"],
            "directive": ("ASK THE OWNER THIS QUESTION, VERBATIM, AND NOTHING "
                          "ELSE. Do not guess, do not batch several questions, "
                          "do not proceed on your own. When the owner answers, "
                          "call setup_answer(code, step_id, answer) with their "
                          "words — 'default' is a valid answer. Configuration "
                          "setters stay REFUSED until this wizard is done."),
        }
    wiz_save(code, "", answers, 1)
    roster = team_roster(code, "full")
    broadcast_team(code, "SETUP COMPLETE for this team.\n\n" + roster_text(code))
    return {"done": True, "summary": roster_text(code),
            "answers": answers,
            "say_to_owner": ("Setup complete. Here is your crew:\n\n" + roster_text(code) +
                             f"\n\nLive board: https://board.gaelis.cc — view key: "
                             f"{team_view_key(code)} (read-only, keep it semi-private)." +
                             "\n\nEveryone has been notified. Say \"crew "
                             "setup " + code + " restart\" to redo this "
                             "interview, or name a single change any time."),
            "relay_rule": RELAY_RULE,
            "directive": ("SETUP IS COMPLETE. Show the owner this team card "
                          "verbatim as the final confirmation. Configuration "
                          "setters are now unlocked for later edits, and "
                          "setup_next(restart=true) re-runs the whole "
                          "interview.")}


def wiz_answer(code, step_id, answer):
    r = wiz_row(code)
    if r and r["done"]:
        return {"error": "setup_already_done",
                "detail": "use the setters directly, or setup_next(restart=true)"}
    if not r or r["step_id"] != step_id:
        return {"error": "wrong_step",
                "expected": r["step_id"] if r else None,
                "detail": "call setup_next to get the current question"}
    ok, extra = wiz_apply(code, step_id, answer)
    if not ok:
        return extra
    answers = wiz_answers(code)
    answers[step_id] = answer
    wiz_save(code, step_id, answers, 0)
    if extra.get("handoff"):
        return {"ok": True, "recorded": answer, **extra}
    return {"ok": True, "recorded": answer, "next": wiz_next(code)}


def wiz_guard(code):
    """Setters call this: configuration is wizard-only until setup is done."""
    if wiz_pending(code):
        return {"error": "setup_wizard_required",
                "directive": ("This team has not been set up yet, and "
                              "configuration is NOT free-form: call "
                              "setup_next(code) and answer its questions with "
                              "the owner. That flow applies every setting. "
                              "Direct setters unlock once setup is complete.")}
    return None



CLIENT_PY = r'''"""crew client — one import instead of ten hand-rolled HTTP calls.

    curl -sO https://crew.gaelis.cc/client/python && mv python crew_client.py

    from crew_client import Crew
    crew = Crew("https://crew.gaelis.cc", "hostd_...")      # your credential
    me = crew.register(platform="codex", environment="mac / local",
                       pool_code="1234", session_name="Nova")
    for msg in crew.inbox(wait=50):        # yields mail, acks after each one
        if msg["delivered_as"] == "cc":
            continue                        # cc = read only, never act
        crew.send(["bx-..."], "result", task="...", outcome="...")

Stdlib only. Box ids are server-assigned and cached in ~/.crew_box_id.
"""
import json
import os
import urllib.request

STATE = os.path.expanduser("~/.crew_box_id")


class CrewError(RuntimeError):
    pass


class Crew:
    def __init__(self, base, token, box=None, ua="crew-client/1"):
        self.base = base.rstrip("/")
        self.h = {"Authorization": "Bearer " + token, "User-Agent": ua}
        self.box = box or (open(STATE).read().strip()
                           if os.path.exists(STATE) else None)

    def _call(self, path, payload=None, timeout=70):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=dict(self.h, **({"Content-Type": "application/json"}
                                    if payload is not None else {})))
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode())
        if isinstance(out, dict) and out.get("error"):
            raise CrewError(out)
        return out

    # --- lifecycle --------------------------------------------------------
    def register(self, platform, environment, pool_code, session_name="",
                 role="", override_name=False):
        p = {"platform": platform, "environment": environment,
             "pool_code": pool_code, "session_name": session_name,
             "role": role, "override_name": override_name}
        if self.box:
            p["box_id"] = self.box
        out = self._call("/register", p)
        self.box = out["box"]
        open(STATE, "w").write(self.box)
        return out

    def team(self, code, view="brief"):
        return self._call("/team?code=%s&view=%s" % (code, view))

    # --- mail -------------------------------------------------------------
    def send(self, to, template="note", cc=None, body="", **fields):
        return self._call("/send", {
            "from": self.box, "to": to, "cc": cc or [],
            "template": template, "fields": fields, "body": body})

    def check(self, wait=25):
        return self._call("/checkmail?box=%s&wait=%d" % (self.box, wait))["messages"]

    def ack(self, through_id):
        return self._call("/ack", {"box": self.box, "through_id": through_id})

    def inbox(self, wait=50, once=False):
        """Yield messages, acking each only AFTER your loop body ran.

        Crash-safe: anything you did not finish is redelivered next time.
        """
        while True:
            for m in self.check(wait):
                yield m
                self.ack(m["id"])
            if once:
                return
'''


def audit_html(box, limit=200):
    import html as h
    hist = do_history(box, limit)
    b = box_row(box)
    items = []
    for m in hist["received"]:
        items.append((m["id"], m["ts"], "in", m))
    for m in hist["sent"]:
        items.append((m["id"], m["ts"], "out", m))
    items.sort(key=lambda x: x[0], reverse=True)
    rows = []
    for mid, ts, direction, m in items[:limit]:
        if direction == "in":
            f = m.get("from", {})
            who = f"{h.escape(str(f.get('display_name')))} ({h.escape(str(f.get('box')))}, {h.escape(str(f.get('platform')))})"
            badge = ("SYS" if m.get("kind") == "system"
                     else m.get("delivered_as", "to").upper())
            color = {"SYS": "#1668dc", "CC": "#8a8f98"}.get(badge, "#d4380d")
            state = ("read " + h.escape(m["taken_ts"][:16])
                     if m.get("taken_ts") else "UNREAD")
            if m.get("email_status"):
                state += " · email:" + h.escape(m["email_status"][:40])
        else:
            who = "→ " + h.escape(", ".join(m.get("to", [])))
            if m.get("cc"):
                who += " · cc " + h.escape(", ".join(m["cc"]))
            badge, color, state = "OUT", "#1a7f4b", ""
        reply = (f" · re #{m['reply_to']}" if m.get("reply_to") else "")
        rows.append(
            f"<div class='m'><div class='h'>"
            f"<span class='b' style='background:{color}'>{badge}</span>"
            f"<b>#{mid}</b> {who}"
            f"<span class='t'>{h.escape(ts[:19])}{reply} {state}</span></div>"
            f"<pre>{h.escape(m.get('body', ''))}</pre></div>")
    name = h.escape(display_name(b) if b else box)
    return f"""<!doctype html><meta charset=utf-8>
<title>crew audit · {h.escape(box)}</title>
<style>body{{font:14px/1.5 -apple-system,sans-serif;max-width:780px;margin:24px auto;
padding:0 16px;color:#1f2428;background:#f7f7f4}}
.m{{border:1px solid #e3e4de;border-radius:10px;background:#fff;margin:10px 0;padding:10px 14px}}
.h{{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}}
.b{{color:#fff;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700}}
.t{{margin-left:auto;color:#8a8f98;font-size:12px}}
pre{{white-space:pre-wrap;margin:8px 0 0;font:12.5px/1.5 ui-monospace,monospace;color:#3c4149}}
h1{{font-size:20px}}</style>
<h1>crew audit — {name} <span style='color:#8a8f98;font-weight:400'>({h.escape(box)}, last {min(limit, len(items))} messages)</span></h1>
{"".join(rows) or "<p>No mail yet.</p>"}"""



BOARD_SH = r'''#!/usr/bin/env bash
# crew live task board in your terminal. Refreshes every 5s.
#   export CREW_TOKEN=hostd_...   CREW_TEAM=tm-xxxxxx
#   curl -s https://crew.gaelis.cc/client/board -o crew-board.sh && bash crew-board.sh
set -u
: "${CREW_TOKEN:?export CREW_TOKEN first}" "${CREW_TEAM:?export CREW_TEAM first}"
CREW_URL="${CREW_URL:-https://crew.gaelis.cc}"
while true; do
  OUT=$(curl -s -A crew-board -H "Authorization: Bearer $CREW_TOKEN" \
    "$CREW_URL/tasks?team=$CREW_TEAM" 2>/dev/null)
  clear
  printf '%s' "$OUT" | python3 -c '
import json, sys, datetime
try:
    d = json.load(sys.stdin)
except Exception:
    print("crew board: relay unreachable, retrying..."); raise SystemExit
print(d.get("board", d.get("error", "?")))
print()
print(d.get("roster", ""))
print()
print("refreshed", datetime.datetime.now().strftime("%H:%M:%S"), "· ctrl-c to quit")
'
  sleep 5
done
'''


def board_html(team):
    import html as h
    text = board_text(team)
    roster = roster_text(team)
    body = h.escape(text) + "\n\n" + h.escape(roster)
    return f"""<!doctype html><meta charset=utf-8>
<meta http-equiv=refresh content=10>
<title>crew board · {h.escape(team)}</title>
<style>body{{background:#14181b;color:#e7e9ea;font:14px/1.7 ui-monospace,Menlo,monospace;
max-width:820px;margin:32px auto;padding:0 20px}}
pre{{white-space:pre-wrap}}
.r{{color:#4fbe84}} .w{{color:#5ea8dc}} .b{{color:#8c949c}} .s{{color:#f0855a}}</style>
<pre>{body}</pre>
<p style="color:#5e646e">auto-refreshes every 10s</p>"""

USAGE = {
    "service": "crew",
    "v": 5.1,
    "detail": ("Team relay for agent sessions: pools -> teams -> setup center "
               "(names, aliases, manager/worker roles, owner mailbox with real "
               "email forwarding). MCP at /mcp (tools + guided prompts; in "
               "Claude Code the prompts appear as slash commands "
               "/mcp__cloud-bridge-relay__onboard etc). Hard rules: workers "
               "never contact the owner; owner contact is mode-gated. Every "
               "delivery carries directive + platform/role stamps + a team "
               "card footer."),
    "mcp": {"endpoint": "/mcp", "transport": "streamable-http",
            "prompts": ["onboard", "setup", "add-owner-mailbox", "team-status"]},
    "board_discipline": (
        "The task board is agent-facing coordination, like a harness todo "
        "list extended to the whole team — the human is never required to "
        "plan. Rules every member follows: (1) any unit of work that "
        "outlives your turn goes on the board; (2) hand work over with a "
        "handoff mail, which auto-files a reserved task; (3) file discovered "
        "work with task_add(discovered_from=...) instead of chasing it; (4) "
        "hold-none-claim-one: before going idle, claim a ready task if you "
        "hold none (check_mail reminds you); (5) heartbeat your claimed task "
        "with task_progress, close it with task_done the moment it is done; "
        "(6) your session's private todo tools are for micro-steps inside "
        "your claimed task only — the board is the single source of truth "
        "for shared work. HARD-CODED: atomic claims; only claimer/manager "
        "close; workers cannot assign tasks to others."),
    "flow_is_enforced": ("Team configuration runs as a server-driven interview: setup_next gives one question at a time with the exact wording to read to the owner, setup_answer applies it. The direct setters are refused until that interview completes, so no session can improvise setup. Mail is templated (status/milestone/blocker/question/handoff/result/note) and missing required fields are refused."),
    "delivery": {
        "how_you_receive_depends_on_how_you_were_STARTED": (
            "crew is store-and-forward mail. There is NO push tool in this "
            "toolset and no way for crew to inject text into your context by "
            "itself. How mail reaches you depends entirely on how your session "
            "was launched:"),
        "A_plain_MCP_client": (
            "If you connected crew as an ordinary MCP connector (claude.ai "
            "connector, Codex config.toml, or `claude mcp add`), you are "
            "PULL-ONLY. You receive by calling check_mail, and only while you "
            "are actively taking a turn — you cannot listen in the background "
            "and you cannot be steered. Practical pattern: call check_mail at "
            "the start of your turn and again whenever you finish a unit of "
            "work; ack what you processed. Between turns you simply won't hear "
            "anything until the human or a task prompts you again. That is "
            "expected, not a bug. Do NOT claim you will be 'steered' or "
            "'pushed to' — that is not available to a plain MCP client."),
        "B_operator_run_bridge_push": (
            "Real-time push exists only when the OPERATOR (the human running "
            "the session) launched a delivery bridge OUTSIDE crew: for Claude "
            "Code, channel/bridge.ts started with "
            "`claude --dangerously-load-development-channels server:cloud-"
            "manager`, which injects mail as <channel> events; for Codex, "
            "codex/sidecar.py, which wraps `codex app-server` and delivers via "
            "turn/steer. These are separate processes shipped in the "
            "cloud-bridge-relay repo. You cannot turn them on from inside the "
            "conversation — either the operator started one or they did not. "
            "If one is running, mail arrives on its own and you should NOT also "
            "poll."),
        "how_to_tell": (
            "If mail has been appearing without you calling check_mail, a "
            "bridge is running (mode B) — just respond to it. Otherwise you "
            "are mode A: poll check_mail when active. When unsure, you are "
            "mode A."),
    },

    "endpoints": {
        "GET /": "this document",
        "GET /client/stop-hook": "Claude Code Stop-hook watcher script (mail delivered at end of every turn)",
        "GET /client/python": "ready-made stdlib client (register, template send, ack-safe inbox loop) — download instead of hand-rolling HTTP",
        "POST /register": "{platform, environment, pool_code, session_name?, box_id?(re-register), role?, override_name?} — server assigns bx-xxxxxx ids; duplicate display names return name_taken",
        "GET /pool?code=X": "who waits in pool X",
        "POST /team/create": "{pool_code, coordinator_box}",
        "POST /team/join": "{code, box}",
        "POST /team/name": "{code, name}",
        "POST /team/alias": "{code, member_no, alias}",
        "POST /team/role": "{code, member_no, role}",
        "POST /team/attach-owner": "{code}",
        "GET /team?code=X&view=brief|full": "roster (brief: one line per member; full: everything + card)",
        "POST /owner/setup": "{full_name, alias?, email}",
        "POST /owner/confirm": "{override?}",
        "POST /owner/mode": "{mode, custom_rules?, allow_senders?, allow_direct?, persistent?}",
        "POST /send": "{from, to, cc?, body, owner_justification?}",
        "GET /poll?box=X&wait=N": "LEGACY long-poll (auto-takes; loss window on lost response)",
        "GET /checkmail?box=X&wait=N&ack_through=I": "ack-model long-poll: returns unacked; pass your cursor to ack",
        "POST /ack": "{box, through_id} — idempotent cursor ack",
        "GET /peek?box=X": "look, don't take",
        "GET /boxes": "directory",
        "GET /history?box=X&limit=N": "audit trail (~14 days)",
        "GET /thread?id=N": "whole conversation chain around one message",
        "GET /audit?box=X": "human-readable audit page (open in a browser)",
        "GET /tasks?team=X": "task board JSON (tasks + rendered board + roster)",
        "GET /viewkey?key=K": "resolve a board view key to its team (board site uses this)",
        "POST /task/add|claim|progress|done": "task board mirror of the MCP tools",
        "GET /board?team=X": "auto-refreshing board page",
        "GET /client/board": "terminal live-board script (CREW_TOKEN+CREW_TEAM)",
    },
    "box_name_rule": BOX_RE.pattern,
}

# Behind the hostd gateway the public Host is crew.gaelis.cc; the SDK's
# DNS-rebinding protection defaults to localhost-only and answers 421 to
# everything else, so list the real hosts explicitly.
mcp = FastMCP(
    "crew", stateless_http=True, json_response=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["crew.gaelis.cc", "localhost", "127.0.0.1",
                       "localhost:*", "127.0.0.1:*"],
        allowed_origins=["https://crew.gaelis.cc", "https://claude.ai",
                         "https://claude.com"]))


# ---------------- MCP prompts (appear as slash commands) ----------------

@mcp.prompt(name="onboard")
def prompt_onboard() -> str:
    """Join a crew pool and wait. Triggered by "crew onboard <code>"."""
    return (
        "The human gave you a 4-digit crew pool code. Do exactly this:\n"
        "1. Call crew_onboard(pool_code, platform, environment, "
        "session_name). platform is 'claude-code' or 'codex' — whichever you "
        "actually are. Do not ask the human anything; you already know your "
        "platform and machine.\n"
        "2. Show the returned `say_to_owner` line verbatim and nothing else. "
        "SAVE the box id from the response — it is your permanent address.\n"
        "3. Then follow `delivery` guidance: crew has no push tool of its "
        "own, so unless a watcher/bridge is running you hear mail only while "
        "you are taking a turn. Call check_mail when you act, ack what you "
        "processed, and never claim you will be pushed to when you won't be. "
        "Call delivery_status(your_box) if the human asks how you receive.\n"
        "4. When you do send mail, use a template "
        "(status/milestone/blocker/question/handoff/result/note) — free-form "
        "prose is refused. If you can run code, curl <relay>/client/python "
        "for a ready client with an ack-safe inbox loop.\n"
        "5. BOARD DISCIPLINE (the team task board is yours, not the "
        "human's — they never have to plan for you): any unit of work that "
        "outlives your current turn belongs on the board. Hand work to a "
        "teammate with a `handoff` mail (it auto-files a task); file work "
        "you DISCOVER with task_add(discovered_from=...) instead of chasing "
        "it; before going idle, check_mail then task_claim a ready task if "
        "you hold none (check_mail reminds you). Your session's own private "
        "todo tools are for micro-steps INSIDE your claimed task only — the "
        "board is the single source of truth for shared work.\n"
        "6. Obey the directive on every message: ACTION = act and reply, "
        "THIS IS A CC = read only, SYSTEM NOTICE = follow, never reply."
    )


@mcp.prompt(name="setup")
def prompt_setup() -> str:
    """Run the team setup interview. Triggered by "crew setup <code>"."""
    return (
        "The human said to set up a crew. They will not explain the "
        "procedure — it is your job to follow this exactly:\n"
        "1. Call crew_setup(pool_or_team, my_box). It forms the team if "
        "needed and returns the FIRST question.\n"
        "2. Show `say_to_owner` to the human VERBATIM and say nothing else. "
        "No preamble, no summary, no invented status, no batching of "
        "questions. Translate only if they write in another language.\n"
        "3. Pass their reply straight to setup_answer(code, step_id, "
        "answer) — 'default' is a valid answer. Show the next "
        "`say_to_owner`. Repeat until done:true, then show the final "
        "`say_to_owner` (the team card).\n"
        "4. Two steps hand work back: 'owner_setup' (run the "
        "add-owner-mailbox flow, then call setup_next again) and mode 'd' "
        "(turn their wording into hard rules, read them back, get an "
        "explicit yes, call set_owner_mode, then setup_next again).\n"
        "set_team_name / set_member_alias / set_box_role / "
        "attach_owner_to_team are REFUSED until the interview finishes."
    )


@mcp.prompt(name="add-owner-mailbox")
def prompt_owner() -> str:
    """Set up the persistent owner mailbox (real email forwarding)."""
    return (
        "You are setting up the OWNER MAILBOX (persistent across teams). "
        "Follow EXACTLY, asking the owner one thing at a time:\n"
        "1. Ask the owner for: full name, alias (display name; default full "
        "name), and their REAL email address.\n"
        "2. Call setup_owner_mailbox(full_name, alias, email). This sends a "
        "verification email.\n"
        "3. ASK THE OWNER whether it arrived. Only when the owner says yes, "
        "call confirm_owner_mailbox(). NEVER confirm without the owner's "
        "word.\n"
        "4. If the send FAILED you MUST read the exact error to the owner. "
        "The owner may fix it and retry, or explicitly say 'override' -> "
        "confirm_owner_mailbox(override=True).\n"
        "5. Then ask which receive mode the owner wants (a default / b / c / "
        "d custom) and call set_owner_mode — for d, follow its directive.\n"
        "After confirmation the owner is reachable as box 'owner'; delivered "
        "mail is forwarded as real email and a successful send counts as "
        "read.")


@mcp.prompt(name="team-status")
def prompt_status() -> str:
    """Show the human a formatted team overview."""
    return ("Call list_team(team_id) (find the id via list_boxes if unknown) "
            "and present the team_card plus pending-mail counts to the human "
            "verbatim, nicely formatted. Then stop.")


# ---------------- MCP tools ----------------

@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def register_box(platform: str, environment: str, pool_code: str,
                       session_name: str = "", box_id: str = "",
                       role: str = "", override_name: bool = False) -> dict:
    """Register into a waiting pool. The server assigns your box id.

    platform: MANDATORY 'claude-code' or 'codex' — stamped on every message.
    environment: one line, e.g. 'cloud session / ubuntu' or 'MacBook / macOS'.
    pool_code: the 4-digit code the owner gave you. No code, no pool.
    session_name: your human-readable name. If it collides with an existing
    member you get name_taken — ask the owner; only on the owner's explicit
    approval retry with override_name=true.
    box_id: OMIT on first registration — the response assigns you a permanent
    id (bx-xxxxxx); SAVE IT and pass it here to re-register after a restart.
    role: optional 'manager' or 'worker' (can also be set later in setup).
    Then poll check_mail and WAIT for the initialization notice.
    """
    return do_register(box_id, session_name, platform, environment, pool_code,
                       role, override_name)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def watch_pool(pool_code: str) -> dict:
    """See who is waiting in a pool. If told to monitor, call periodically and
    report; when the owner says 'initialize', call initialize_team."""
    return do_pool(pool_code)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def initialize_team(pool_code: str, coordinator_box: str) -> dict:
    """Turn the whole waiting pool into a team. Call ONLY on the owner's word
    'initialize'. You become coordinator (#1); a unique team id (tm-xxxxxx)
    is generated. The response directive walks you through the setup center."""
    return do_initialize_team(pool_code, coordinator_box)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def join_team(code: str, box: str) -> dict:
    """Join an existing team late (register_box first). Broadcasts the update."""
    return do_join_team(code, box)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def set_team_name(code: str, name: str) -> dict:
    """Setup center: set the team name the owner chose. Broadcasts."""
    g = wiz_guard(str(code))
    return g or do_set_team_name(code, name)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def set_member_alias(code: str, member_no: int, alias: str,
                           override_name: bool = False) -> dict:
    """Setup center: set the alias the owner chose for one member. Duplicate
    display names return name_taken — read it to the owner and retry with
    override_name=true only on the owner's explicit approval. Broadcasts."""
    g = wiz_guard(str(code))
    return g or do_set_member_alias(code, member_no, alias, override_name)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def set_box_role(code: str, member_no: int, role: str) -> dict:
    """Setup center: mark a member 'manager' or 'worker' (owner's choice).
    HARD consequence: workers can never mail the owner. Broadcasts."""
    g = wiz_guard(str(code))
    return g or do_set_box_role(code, member_no, role)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def setup_owner_mailbox(full_name: str, email: str, alias: str = "") -> dict:
    """Create OR edit the owner mailbox. Same verified email = name/alias
    update only, instant. New/changed email = a verification mail is sent and
    the OWNER must confirm receipt before confirm_owner_mailbox; a failed
    send MUST be reported to the owner verbatim."""
    return await asyncio.to_thread(do_setup_owner, full_name, alias, email)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def confirm_owner_mailbox(override: bool = False) -> dict:
    """Owner mailbox step 2: call ONLY after the owner says the verification
    email arrived (or explicitly says 'override' after a reported failure)."""
    return do_confirm_owner(override)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def set_owner_mode(mode: str, custom_rules: str = "",
                         allow_senders: str = "", allow_direct: str = "",
                         persistent: bool | None = None) -> dict:
    """Owner receive mode: a=milestones-only(default) b=manager-open
    c=team-open d=custom. For d, first translate the owner's wishes into a
    short hard rules text + allow_senders(manager_only|any) +
    allow_direct(justified_only|free), read them back, get the owner's
    explicit confirmation, and ask whether to keep it permanently."""
    return do_set_owner_mode(mode, custom_rules, allow_senders, allow_direct,
                             persistent)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def attach_owner_to_team(code: str) -> dict:
    """Setup center: attach the confirmed owner mailbox to a team as member #0
    (owner + human). Broadcasts the owner contact rules to everyone."""
    g = wiz_guard(str(code))
    return g or do_attach_owner(code)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def crew_onboard(pool_code: str, platform: str, environment: str,
                       session_name: str = "") -> dict:
    """ENTRY POINT when the human says something like "crew onboard 1234".

    One call: registers this session into that pool and returns the exact
    line to show the human plus what to do next. Do not ask the human
    anything first — platform is 'claude-code' or 'codex' (whichever you
    are), environment is one line you already know about your machine,
    session_name is your session title if you have one. After this, follow
    the returned directive and stay quiet until mail arrives.
    """
    return do_register("", session_name, platform, environment, pool_code)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def crew_setup(pool_or_team: str, my_box: str,
                     restart: bool = False) -> dict:
    """ENTRY POINT when the human says something like "crew setup 1234".

    One call, no questions asked first: if that pool has no team yet this
    forms one (you become coordinator), then it returns the FIRST setup
    question. From there just relay `say_to_owner`, send the human's reply to
    setup_answer, and repeat until done. The human never has to explain the
    procedure to you — it is all in these responses.
    """
    key = str(pool_or_team).strip()
    if CODE_RE.match(key):
        code = find_team_by_pool(key)
        if not code:
            r = do_initialize_team(key, my_box)
            if r.get("error"):
                return r
            code = r["team_code"]
    else:
        code = key
    return wiz_next(code, restart)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def setup_next(code: str, restart: bool = False) -> dict:
    """THE ONLY WAY TO CONFIGURE A TEAM. Returns ONE question at a time.

    Read `ask_owner_verbatim` to the owner exactly as written — do not
    paraphrase it, do not ask several questions at once, do not answer on the
    owner's behalf, and do not skip ahead. 'default' is always a valid answer
    and `default_if_owner_says_default` tells you what it means. Submit what
    the owner said with setup_answer, which hands you the next question.
    restart=true re-runs the whole interview (settings are revisitable).
    """
    return wiz_next(str(code), restart)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def setup_answer(code: str, step_id: str, answer: str) -> dict:
    """Submit the owner's answer to the question setup_next just gave you.

    Pass the owner's words (or 'default'). The server validates, applies the
    setting, broadcasts the change, and returns the next question. Answering a
    step you were not asked is refused — that is deliberate: the interview is
    server-driven so no session can improvise its way through setup.
    """
    return wiz_answer(str(code), str(step_id), answer)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def list_team(code: str, view: str = "brief") -> dict:
    """Team roster for a team id (tm-xxxxxx). view="brief" (default): one
    line per member — number, name, box, role, platform — enough for
    routing. view="full": every field (session_name, environment, last_seen,
    per-member pending) plus the formatted team card; use for setup/debug."""
    return team_roster(str(code), view if view in ("brief", "full") else "brief")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def send_mail(sender_box: str, to: list[str], template: str = "note",
                    fields: dict | None = None, body: str = "",
                    cc: list[str] | None = None,
                    owner_justification: str = "",
                    dedup_key: str = "", reply_to: int | None = None) -> dict:
    """Send a message. to = must act; cc = FYI copy.

    STRUCTURE IS REQUIRED, not prose. Pick a template and fill its fields:
      status(done,next) · milestone(headline,detail) ·
      blocker(blocked_on,tried,need) · question(question,why_it_matters) ·
      handoff(task,context,deliverable) · result(task,outcome) ·
      note(free text in body)
    Missing required fields are refused with the list. `body` is optional
    extra prose appended under the structured part. BOARD WELDING: a
    `handoff` auto-creates a board task reserved for the first teamed
    recipient (response carries task_id); a `result` whose `task` field names
    "#N" auto-closes that task. Replying? Pass reply_to=
    <the message id> so the exchange stays a thread (mail_thread follows it).
    Sends are rate-limited (~30 per 5 min per box); a refusal names the wait
    and means the message was NOT sent — never assume delivery after an error.

    Identity/platform/role stamps come from your registration. Mailing box
    'owner' is HARD-GATED by
    the owner mode: workers are always refused; a direct `to` may require
    owner_justification (one sentence: why the owner must see this NOW).

    DELIVERY GUARANTEE: ok:true means the message is durably committed into
    EVERY recipient's box before you see the response — any failure returns
    an explicit error instead. If the response gets lost and you retry, pass
    the same dedup_key (any string unique to this logical message): retries
    then return the original id with duplicate:true instead of double-sending."""
    rendered, terr = render_template(template, fields, body)
    if terr:
        return terr
    res, err = do_send(sender_box, to, cc or [], rendered,
                       owner_justification=owner_justification,
                       dedup_key=dedup_key, reply_to=reply_to)
    if err:
        return err
    res.update(mail_task_hook(sender_box, to, template, fields or {}))
    return res


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def check_mail(box: str, wait_seconds: int = 25,
                     ack_through: int = 0) -> list[dict]:
    """Pull your mailbox (ACK MODEL). This is how a PLAIN MCP CLIENT
    receives — crew has no push tool, so if no operator bridge is running,
    calling this is the only way you hear anything, and only while you have a
    turn. (If mail already arrives on its own, a bridge is delivering it; do
    not also poll.)

    Messages returned here are NOT consumed. After you have PROCESSED a
    batch, acknowledge it: either call ack_mail(box, through_id=<highest id
    you processed>), or pass that id as ack_through on your next check_mail.
    Unacked messages are redelivered on every poll (crash-safe, at-least-once)
    — dedupe by the stable `id` if you see one twice. Acking is idempotent.
    Each message: kind (mail|system), from{box,display_name,member_no,team,
    platform,role,is_human}, delivered_as (to|cc), directive (OBEY IT),
    team_info footer."""
    if not BOX_RE.match(box):
        return [{"error": "bad_box"}]
    if ack_through:
        do_ack(box, ack_through)
    msgs = await do_poll(box, wait_seconds, take=False)
    rem = board_reminder(box)
    if rem:
        msgs.append(rem)
    return msgs


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def ack_mail(box: str, through_id: int) -> dict:
    """Acknowledge processed mail: marks everything with id <= through_id as
    done for your box. Idempotent; re-acking is a no-op. Acked mail stays in
    mail_history ~14 days."""
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return do_ack(box, through_id)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def peek_mail(box: str) -> list[dict]:
    """Look at pending messages without taking them."""
    if not BOX_RE.match(box):
        return [{"error": "bad_box"}]
    return fetch_box(box, take=False)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def delivery_status(box: str) -> dict:
    """How this session receives mail, and what to offer the human.

    Call this whenever the human asks "am I getting messages?", "what mode is
    this?", "can you get them pushed?", or when mail seems late. It reports
    how long since anything polled your box (a live watcher keeps that under
    ~60s, so a large number means your watcher DIED — say so), and returns a
    ready `say_to_owner` menu of the four delivery modes with the exact setup
    steps for your platform. Relay it verbatim; do not invent capabilities.
    """
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return delivery_report(box)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def list_boxes() -> dict:
    """Directory of all boxes: display name, platform/human, role, team,
    pending count, last_seen."""
    return do_boxes()


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def task_add(team: str, title: str, detail: str = "",
                   created_by: str = "", deps: list[int] | None = None,
                   assign_to: str = "", priority: int = 2,
                   discovered_from: int | None = None) -> dict:
    """Add a task to the team board.

    Right-sized task = a self-contained deliverable (a function, a test file,
    a review), not a whole feature and not a one-liner; aim for 5-6 open
    tasks per member. deps = ids that must be DONE first (they must already
    exist, so the graph stays acyclic). assign_to reserves it for one box;
    otherwise anyone may claim once ready. priority 1=high 2=normal 3=low.
    FILING DISCOVERED WORK: if you notice work while doing something else, do
    NOT chase it — add it here with discovered_from=<your current task id>
    and keep going."""
    return do_task_add(team, title, detail, created_by, deps, assign_to,
                       priority, discovered_from)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
async def task_claim(task_id: int, box: str) -> dict:
    """Claim a ready task before working on it. Atomic: exactly one member
    wins; a refusal means pick another from task_list, never work an
    unclaimed or lost task. Blocked/reserved tasks tell you why."""
    return do_task_claim(task_id, box)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def task_progress(task_id: int, box: str, note: str) -> dict:
    """One-line progress note on your claimed task. Do it at least hourly —
    silence past 2h marks the task STALLED
    and pings the manager."""
    return do_task_progress(task_id, box, note)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def task_done(task_id: int, box: str, result: str) -> dict:
    """Close your task with a one-line result THE MOMENT it is finished —
    a forgotten close blocks every dependent task and jams the team.
    Response lists what you unblocked and what is ready next: SELF-CLAIM the
    next ready task instead of going idle."""
    return do_task_done(task_id, box, result)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def task_list(team: str) -> dict:
    """The team task board: READY / IN PROGRESS (with owner, age, stalled
    flags) / BLOCKED (with what they wait on) / DONE. Returns say_to_owner —
    relay it verbatim when the human asked; use the sections yourself to pick
    work (claim from READY only)."""
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (str(team),)).fetchone():
        return {"error": "no_such_team"}
    return {"say_to_owner": board_text(str(team)), "relay_rule": RELAY_RULE}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def board_key(team: str) -> dict:
    """The team's read-only view key for the human board site
    (https://board.gaelis.cc). Give it to the human when they ask how to
    watch the board in a browser; it grants VIEW ONLY of this one team."""
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (str(team),)).fetchone():
        return {"error": "no_such_team"}
    k = team_view_key(str(team))
    return {"team": str(team), "view_key": k,
            "say_to_owner": ("Live board: https://board.gaelis.cc — enter key "
                             + k + ". Read-only, this team only; keep it "
                             "semi-private."),
            "relay_rule": RELAY_RULE}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def show_roster(code: str) -> dict:
    """Show the human the current team roster. Returns `say_to_owner` — the
    canonical rendering (numbers, names, boxes, roles, platforms, unread
    counts, stale flags). Relay it VERBATIM; do not reformat or summarize.
    Use whenever the human asks who is on the team or what the state is."""
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (str(code),)).fetchone():
        return {"error": "no_such_team"}
    return {"say_to_owner": roster_text(str(code)), "relay_rule": RELAY_RULE}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def mail_thread(message_id: int) -> dict:
    """Follow a conversation: give any message id and get the whole chain —
    ancestors up to the root and every reply below it, in order. Use when a
    message has reply_to set and you need the context before acting."""
    return do_thread(message_id)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
async def mail_history(box: str, limit: int = 50) -> dict:
    """Audit trail: received (taken_ts null = pending; email_status for
    owner-bound mail) and sent messages. Kept ~14 days."""
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return do_history(box, limit)


# ---------------- REST mirror ----------------

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


async def _r_stop_hook(_req):
    from starlette.responses import PlainTextResponse
    return PlainTextResponse(WATCH_SH)


async def _r_client_py(_req):
    from starlette.responses import PlainTextResponse
    return PlainTextResponse(CLIENT_PY)


async def _r_health(_req, _p):
    return {"ok": True}


async def _r_register(_req, p):
    return do_register(p.get("box_id", p.get("box", "")),
                       p.get("session_name", ""),
                       p.get("platform", ""), p.get("environment", ""),
                       p.get("pool_code", ""), p.get("role", ""),
                       bool(p.get("override_name")))


async def _r_team_create(_req, p):
    return do_initialize_team(p.get("pool_code", p.get("code", "")),
                              p.get("coordinator_box", ""))


async def _r_team_join(_req, p):
    return do_join_team(p.get("code", ""), p.get("box", ""))


async def _r_team_name(_req, p):
    g = wiz_guard(p.get("code", ""))
    return g or do_set_team_name(p.get("code", ""), p.get("name", ""))


async def _r_team_alias(_req, p):
    g = wiz_guard(p.get("code", ""))
    if g:
        return g
    try:
        return do_set_member_alias(p.get("code", ""), int(p.get("member_no", 0)),
                                   p.get("alias", ""),
                                   bool(p.get("override_name")))
    except (TypeError, ValueError):
        return {"error": "bad_member_no"}


async def _r_team_role(_req, p):
    g = wiz_guard(p.get("code", ""))
    if g:
        return g
    try:
        return do_set_box_role(p.get("code", ""), int(p.get("member_no", 0)),
                               p.get("role", ""))
    except (TypeError, ValueError):
        return {"error": "bad_member_no"}


async def _r_attach_owner(_req, p):
    g = wiz_guard(p.get("code", ""))
    return g or do_attach_owner(p.get("code", ""))


async def _r_owner_setup(_req, p):
    return await asyncio.to_thread(do_setup_owner, p.get("full_name", ""),
                                   p.get("alias", ""), p.get("email", ""))


async def _r_owner_confirm(_req, p):
    return do_confirm_owner(bool(p.get("override")))


async def _r_owner_mode(_req, p):
    return do_set_owner_mode(p.get("mode", ""), p.get("custom_rules", ""),
                             p.get("allow_senders", ""), p.get("allow_direct", ""),
                             p.get("persistent"))


async def _r_setup_next(_req, p):
    return wiz_next(p.get("code", ""), bool(p.get("restart")))


async def _r_setup_answer(_req, p):
    return wiz_answer(p.get("code", ""), p.get("step_id", ""), p.get("answer", ""))


async def _r_team(req, _p):
    view = req.query_params.get("view", "brief")
    return team_roster(req.query_params.get("code", ""),
                       view if view in ("brief", "full") else "brief")


async def _r_pool(req, _p):
    return do_pool(req.query_params.get("code", ""))


async def _r_send(_req, p):
    rendered, terr = render_template(p.get("template", "note"),
                                     p.get("fields"), p.get("body", ""))
    if terr:
        return terr
    res, err = do_send(p.get("from", ""), p.get("to"), p.get("cc"),
                       rendered, fallback_alias=p.get("alias", ""),
                       owner_justification=p.get("owner_justification", ""),
                       dedup_key=p.get("dedup_key", ""),
                       reply_to=p.get("reply_to"))
    if err:
        return err
    res.update(mail_task_hook(p.get("from", ""), as_box_list(p.get("to")) or [],
                              p.get("template", "note"), p.get("fields") or {}))
    return res


async def _r_poll(req, _p):
    # Legacy: auto-takes on delivery. New clients: use /checkmail + /ack.
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    try:
        wait = int(req.query_params.get("wait", "25"))
    except ValueError:
        wait = 25
    return {"messages": await do_poll(box, wait, take=True)}


async def _r_checkmail(req, _p):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    try:
        wait = int(req.query_params.get("wait", "25"))
    except ValueError:
        wait = 25
    try:
        ack_through = int(req.query_params.get("ack_through", "0"))
    except ValueError:
        ack_through = 0
    if ack_through:
        do_ack(box, ack_through)
    msgs = await do_poll(box, wait, take=False)
    rem = board_reminder(box)
    if rem:
        msgs.append(rem)
    return {"messages": msgs}


async def _r_ack(_req, p):
    box = p.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return do_ack(box, p.get("through_id"))


async def _r_peek(req, _p):
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return {"error": "bad_box"}
    return {"messages": fetch_box(box, take=False)}


async def _r_boxes(_req, _p):
    return {"boxes": do_boxes()}


async def _r_thread(req, _p):
    return do_thread(req.query_params.get("id", ""))


async def _r_audit(req):
    from starlette.responses import HTMLResponse
    box = req.query_params.get("box", "")
    if not BOX_RE.match(box):
        return HTMLResponse("<p>bad box</p>", status_code=400)
    try:
        limit = int(req.query_params.get("limit", "200"))
    except ValueError:
        limit = 200
    return HTMLResponse(audit_html(box, min(max(limit, 1), 500)))


async def _r_viewkey(req, _p):
    code = resolve_view_key(req.query_params.get("key", ""))
    if not code:
        return {"error": "bad_key"}
    return {"team": code}


async def _r_tasks(req, _p):
    team = req.query_params.get("team", "")
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (team,)).fetchone():
        return {"error": "no_such_team"}
    rows = [dict(r) for r in db().execute(
        "SELECT * FROM tasks WHERE team=? ORDER BY priority, id", (team,))]
    return {"team": team, "tasks": rows, "board": board_text(team),
            "roster": roster_text(team)}


async def _r_task_add(_req, p):
    return do_task_add(p.get("team", ""), p.get("title", ""),
                       p.get("detail", ""), p.get("created_by", ""),
                       p.get("deps"), p.get("assign_to", ""),
                       p.get("priority", 2), p.get("discovered_from"))


async def _r_task_claim(_req, p):
    return do_task_claim(p.get("task_id"), p.get("box", ""))


async def _r_task_progress(_req, p):
    return do_task_progress(p.get("task_id"), p.get("box", ""), p.get("note", ""))


async def _r_task_done(_req, p):
    return do_task_done(p.get("task_id"), p.get("box", ""), p.get("result", ""))


async def _r_board_page(req):
    from starlette.responses import HTMLResponse
    team = req.query_params.get("team", "")
    if not db().execute("SELECT 1 FROM teams WHERE code=?", (team,)).fetchone():
        return HTMLResponse("<p>no such team</p>", status_code=404)
    return HTMLResponse(board_html(team))


async def _r_board_sh(_req):
    from starlette.responses import PlainTextResponse
    return PlainTextResponse(BOARD_SH)


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
threading.Thread(target=stale_loop, daemon=True).start()
app.router.routes.extend([
    Route("/", _json_route(_r_root)),
    Route("/health", _json_route(_r_health)),
    Route("/client/python", _r_client_py),
    Route("/client/stop-hook", _r_stop_hook),
    Route("/register", _json_route(_r_register), methods=["POST"]),
    Route("/team/create", _json_route(_r_team_create), methods=["POST"]),
    Route("/team/join", _json_route(_r_team_join), methods=["POST"]),
    Route("/team/name", _json_route(_r_team_name), methods=["POST"]),
    Route("/team/alias", _json_route(_r_team_alias), methods=["POST"]),
    Route("/team/role", _json_route(_r_team_role), methods=["POST"]),
    Route("/team/attach-owner", _json_route(_r_attach_owner), methods=["POST"]),
    Route("/owner/setup", _json_route(_r_owner_setup), methods=["POST"]),
    Route("/owner/confirm", _json_route(_r_owner_confirm), methods=["POST"]),
    Route("/owner/mode", _json_route(_r_owner_mode), methods=["POST"]),
    Route("/setup/next", _json_route(_r_setup_next), methods=["POST"]),
    Route("/setup/answer", _json_route(_r_setup_answer), methods=["POST"]),
    Route("/team", _json_route(_r_team)),
    Route("/pool", _json_route(_r_pool)),
    Route("/send", _json_route(_r_send), methods=["POST"]),
    Route("/poll", _json_route(_r_poll)),
    Route("/checkmail", _json_route(_r_checkmail)),
    Route("/ack", _json_route(_r_ack), methods=["POST"]),
    Route("/peek", _json_route(_r_peek)),
    Route("/boxes", _json_route(_r_boxes)),
    Route("/history", _json_route(_r_history)),
    Route("/thread", _json_route(_r_thread)),
    Route("/audit", _r_audit),
    Route("/viewkey", _json_route(_r_viewkey)),
    Route("/tasks", _json_route(_r_tasks)),
    Route("/task/add", _json_route(_r_task_add), methods=["POST"]),
    Route("/task/claim", _json_route(_r_task_claim), methods=["POST"]),
    Route("/task/progress", _json_route(_r_task_progress), methods=["POST"]),
    Route("/task/done", _json_route(_r_task_done), methods=["POST"]),
    Route("/board", _r_board_page),
    Route("/client/board", _r_board_sh),
])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1" if os.environ.get("PORT") else "0.0.0.0",
                port=PORT, log_level="info")
