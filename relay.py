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
                      ("is_human", "INTEGER NOT NULL DEFAULT 0")]:
        try:
            c.execute(f"ALTER TABLE boxes ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    for tbl, col, decl in [("messages", "kind", "TEXT NOT NULL DEFAULT 'mail'"),
                           ("messages", "client_key", "TEXT"),
                           ("teams", "rv", "INTEGER NOT NULL DEFAULT 1"),
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
        lines.append(f"#{r['member_no'] or 0} {who} · box:{r['box']} · "
                     f"{role} · {kind}{tail}")
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

def do_send(sender, to, cc, body, fallback_alias="", owner_justification="",
            dedup_key=""):
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


async def do_poll(box, wait_s: int, take: bool):
    """take=True: legacy auto-take. take=False: ack model — messages stay
    pending until do_ack; replays return the same ids."""
    touch_box(box)
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
        } for r in rows],
        "team_card": team_card(code),
    }


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
    conn.execute("INSERT INTO teams(code,name,pool_code,coordinator,created_ts) "
                 "VALUES(?,?,?,?,?)", (code, "", pool_code, coordinator_box, now()))
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
                    f"will follow. Use list_team('{code}') for the roster.")
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
        return {
            "step_id": step["id"],
            "progress": f"{done_n + 1}/{total}",
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
    broadcast_team(code, "SETUP COMPLETE for this team.\n\n" + roster["team_card"])
    return {"done": True, "summary": roster["team_card"],
            "answers": answers,
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

    curl -sO https://relay.gaelis.cc/client/python && mv python crew_client.py

    from crew_client import Crew
    crew = Crew("https://relay.gaelis.cc", "hostd_...")      # your credential
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
    },
    "box_name_rule": BOX_RE.pattern,
}

# Behind the hostd gateway the public Host is relay.gaelis.cc; the SDK's
# DNS-rebinding protection defaults to localhost-only and answers 421 to
# everything else, so list the real hosts explicitly.
mcp = FastMCP(
    "crew", stateless_http=True, json_response=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["relay.gaelis.cc", "localhost", "127.0.0.1",
                       "localhost:*", "127.0.0.1:*"],
        allowed_origins=["https://relay.gaelis.cc", "https://claude.ai",
                         "https://claude.com"]))


# ---------------- MCP prompts (appear as slash commands) ----------------

@mcp.prompt(name="onboard")
def prompt_onboard() -> str:
    """Join the team system: register into the waiting pool and stand by."""
    return (
        "You are joining a multi-session team relay. Follow EXACTLY:\n"
        "1. The owner's message contains a 4-digit pool code. If you do not "
        "have one, STOP and ask the owner for it.\n"
        "2. Call register_box(platform, environment, pool_code, "
        "session_name) — platform is 'claude-code' or 'codex', whichever you "
        "actually are; environment is one line like 'cloud VM / ubuntu'; "
        "session_name is your human-readable name (on name_taken, ask the "
        "owner before overriding). The response assigns your PERMANENT box id "
        "(bx-xxxxxx): SAVE IT — it is your address for everything, and you "
        "re-register with box_id=<it> after restarts.\n"
        "3. HOW YOU RECEIVE — read carefully, this is where sessions get "
        "confused. crew is store-and-forward mail; it has NO push tool. If "
        "mail has been arriving without you calling check_mail, an operator "
        "bridge is delivering it (Claude Code channel or Codex sidecar) — just "
        "respond, do NOT also poll. OTHERWISE you are a plain MCP client and "
        "you are PULL-ONLY: call check_mail(your_box, wait_seconds=50), "
        "process what returns, ack_mail(your_box, through_id=<max id>), and "
        "call check_mail again while you have a turn to spend. You cannot "
        "listen in the background and you will NOT be steered — between turns "
        "you go quiet until the human or a task prompts you again. That is "
        "normal. Never claim you will be pushed to or steered unless mail is "
        "actually arriving on its own. See GET / `delivery` for the full "
        "picture.\n"
        "4. WHEN YOU DO SEND: mail is structured, not prose — pick a template (status/milestone/blocker/question/handoff/result/note) and fill its fields; missing ones are refused. If you can run code, `curl -sO <relay>/client/python` gives you a ready client with an ack-safe inbox loop instead of hand-rolled HTTP.\n"
        "5. Do not send mail before the team is initialized; you will get a "
        "SYSTEM NOTICE with your member number.\n"
        "6. Obey every directive attribute on incoming mail: ACTION means act "
        "and reply; THIS IS A CC means read only; SYSTEM NOTICE means follow "
        "instructions, never reply.")


@mcp.prompt(name="setup")
def prompt_setup() -> str:
    """Coordinator: run the server-driven setup interview with the owner."""
    return (
        "You are the coordinator. Team configuration is an INTERVIEW RUN BY "
        "THE SERVER, not something you decide or improvise.\n"
        "1. Call setup_next(team_code). It returns exactly ONE question.\n"
        "2. Show the owner `ask_owner_verbatim` WORD FOR WORD. Do not "
        "paraphrase, do not merge questions, do not answer for them, do not "
        "assume 'default' — offer it as an option and let them choose.\n"
        "3. Send their reply to setup_answer(code, step_id, answer). It "
        "applies the setting, broadcasts it, and returns the next question.\n"
        "4. Repeat until you get done:true, then show the owner the final "
        "team card verbatim.\n"
        "Two steps hand work back to you: 'owner_setup' (run the "
        "add-owner-mailbox flow, then call setup_next again) and mode 'd' "
        "(translate the owner's wording into hard rules, read them back, get "
        "an explicit yes, call set_owner_mode, then setup_next again).\n"
        "set_team_name / set_member_alias / set_box_role / "
        "attach_owner_to_team are REFUSED until the interview finishes — that "
        "is deliberate. Afterwards they work for one-off edits, and "
        "setup_next(restart=true) re-runs the whole interview."
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
                    dedup_key: str = "") -> dict:
    """Send a message. to = must act; cc = FYI copy.

    STRUCTURE IS REQUIRED, not prose. Pick a template and fill its fields:
      status(done,next) · milestone(headline,detail) ·
      blocker(blocked_on,tried,need) · question(question,why_it_matters) ·
      handoff(task,context,deliverable) · result(task,outcome) ·
      note(free text in body)
    Missing required fields are refused with the list. `body` is optional
    extra prose appended under the structured part.

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
                       dedup_key=dedup_key)
    return res if res else err


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
    return await do_poll(box, wait_seconds, take=False)


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
async def list_boxes() -> dict:
    """Directory of all boxes: display name, platform/human, role, team,
    pending count, last_seen."""
    return do_boxes()


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
                       dedup_key=p.get("dedup_key", ""))
    return res if res else err


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
    return {"messages": await do_poll(box, wait, take=False)}


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
    Route("/client/python", _r_client_py),
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
])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1" if os.environ.get("PORT") else "0.0.0.0",
                port=PORT, log_level="info")
