// Mail: templates, send (gating + rate limit + dedup + threads + board weld),
// check/ack (ack model + board reminder), thread view, history.
import { now } from "../db.js";
import {
  type Ctx, type Stamp, OWNER_BOX, DIRECTIVES, BOX_RE, boxRow, senderStamp,
  asBoxList, touchBox, teamCard, insertMessage,
} from "./context.js";
import { ownerGate, emailOwnerDelivery } from "./owner.js";
import { taskDepsDone, doTaskAdd, doTaskDone, taskRow } from "./tasks.js";

// ── templates ──────────────────────────────────────────────────────────
export function renderTemplate(c: Ctx, template: string, fields: Record<string, unknown>, body: string): [string | null, { error: string; [k: string]: unknown } | null] {
  const t = c.cfg.templates[template];
  if (!t) return [null, { error: "unknown_template", templates: Object.fromEntries(Object.entries(c.cfg.templates).map(([k, v]) => [k, v.use])) }];
  fields = fields || {};
  if (template === "note") {
    if (!String(body || "").trim()) return [null, { error: "empty_body" }];
    return [`[NOTE]\n${body.trim()}`, null];
  }
  const missing = t.fields.filter((f) => !String(fields[f] ?? "").trim());
  if (missing.length)
    return [null, { error: "missing_fields", template, missing, optional: t.optional, detail: `template '${template}' (${t.use}) requires: ${t.fields.join(", ")}` }];
  const lines = [`[${template.toUpperCase()}]`];
  for (const f of [...t.fields, ...t.optional]) {
    const v = String(fields[f] ?? "").trim();
    if (!v) continue;
    const label = f.replace(/_/g, " ");
    lines.push(v.includes("\n") ? `${label}:\n` + v.split("\n").map((l) => "  " + l).join("\n") : `${label}: ${v}`);
  }
  if (String(body || "").trim()) { lines.push(""); lines.push(body.trim()); }
  return [lines.join("\n"), null];
}

// ── rate limit (loud, never silent) ──────────────────────────────────────
function rateCheck(c: Ctx, sender: string) {
  const rows = c.db.prepare("SELECT ts FROM messages WHERE sender=? ORDER BY id DESC LIMIT ?")
    .all(sender, c.cfg.limits.rate_n) as { ts: string }[];
  if (rows.length < c.cfg.limits.rate_n) return null;
  const oldest = new Date(rows[rows.length - 1].ts).getTime();
  const age = (Date.now() - oldest) / 1000;
  if (age >= c.cfg.limits.rate_window_s) return null;
  const retry = Math.floor(c.cfg.limits.rate_window_s - age) + 1;
  return { error: "rate_limited", sent: false, retry_after_s: retry,
    directive: `YOUR MESSAGE WAS NOT SENT. You have sent ${c.cfg.limits.rate_n} messages in the last ${c.cfg.limits.rate_window_s}s, which is the limit. Wait ${retry}s and send again — do NOT assume delivery, and consider batching several updates into one templated message.` };
}

export function doSend(
  c: Ctx, sender: string, to: unknown, cc: unknown, body: string,
  opts: { fallbackAlias?: string; ownerJustification?: string; dedupKey?: string; replyTo?: number | null } = {},
): [{ ok: true; id: number; delivered_to: string[]; from: Stamp; duplicate?: true } | null, { error: string; [k: string]: unknown } | null] {
  if (typeof sender !== "string" || !BOX_RE.test(sender)) return [null, { error: "bad_from", detail: BOX_RE.source }];
  const toL = asBoxList(to), ccRaw = asBoxList(cc);
  if (toL == null || ccRaw == null || toL.length === 0)
    return [null, { error: "bad_recipients", detail: "`to` required; `to`/`cc` are a box name or list" }];
  if (typeof body !== "string" || !body.trim()) return [null, { error: "empty_body" }];
  if (body.length > c.cfg.limits.max_body) return [null, { error: "body_too_large" }];
  const cc2 = ccRaw.filter((x) => !toL.includes(x));
  const gate = ownerGate(c, sender, toL, cc2, opts.ownerJustification || "");
  if (gate) return [null, gate];
  const limited = rateCheck(c, sender);
  if (limited) return [null, limited];
  let replyTo = opts.replyTo ?? null;
  if (replyTo != null) {
    replyTo = Number(replyTo);
    if (!Number.isInteger(replyTo) || !c.db.prepare("SELECT 1 FROM messages WHERE id=?").get(replyTo))
      return [null, { error: "bad_reply_to", detail: `no message #${replyTo} (pruned or never existed)` }];
  }
  if (opts.dedupKey) {
    const dup = c.db.prepare("SELECT id FROM messages WHERE sender=? AND client_key=?").get(sender, String(opts.dedupKey).slice(0, 100)) as { id: number } | undefined;
    if (dup) return [{ ok: true, id: dup.id, delivered_to: toL.concat(cc2), from: senderStamp(c, sender), duplicate: true }, null];
  }
  let finalBody = body;
  if (opts.ownerJustification && toL.includes(OWNER_BOX)) finalBody = `[owner-direct justification: ${opts.ownerJustification}]\n\n${body}`;
  const stamp = senderStamp(c, sender, opts.fallbackAlias || "");
  const mid = insertMessage(c, sender, stamp.display_name, "mail", toL, cc2, finalBody);
  if (replyTo != null) c.db.prepare("UPDATE messages SET reply_to=? WHERE id=?").run(replyTo, mid);
  if (opts.dedupKey) c.db.prepare("UPDATE messages SET client_key=? WHERE id=?").run(String(opts.dedupKey).slice(0, 100), mid);
  if (toL.includes(OWNER_BOX) || cc2.includes(OWNER_BOX)) void emailOwnerDelivery(c, mid);
  c.db.prepare("DELETE FROM messages WHERE ts < datetime('now', ?) AND id IN (SELECT msg_id FROM deliveries GROUP BY msg_id HAVING count(*) = count(taken_ts))")
    .run(`-${c.cfg.limits.prune_days} days`);
  touchBox(c, sender);
  return [{ ok: true, id: mid, delivered_to: toL.concat(cc2), from: stamp }, null];
}

// mail <-> board welding
export function mailTaskHook(c: Ctx, sender: string, to: string[], template: string, fields: Record<string, unknown>): Record<string, unknown> {
  const b = boxRow(c, sender);
  if (!b?.team_code) return {};
  const team = b.team_code;
  if (template === "handoff") {
    let assignee = "";
    for (const r of to) { const rb = boxRow(c, r); if (rb?.team_code === team) { assignee = r; break; } }
    const r = doTaskAdd(c, team, String(fields.task || "").slice(0, 200),
      (String(fields.context || "") + "\ndeliverable: " + String(fields.deliverable || "")).slice(0, 2000), sender, null, assignee);
    if ("ok" in r && r.ok) return { task_id: r.task_id, task_note: `task #${r.task_id} auto-created for this handoff; recipient should task_claim it` };
  }
  if (template === "result") {
    const m = /#?(\d+)/.exec(String(fields.task || ""));
    if (m) {
      const t = taskRow(c, Number(m[1]));
      if (t && t.team === team && t.status !== "done") {
        const r = doTaskDone(c, Number(m[1]), sender, String(fields.outcome || "").slice(0, 200));
        if ("ok" in r && r.ok) return { task_closed: t.id, next_ready: (r as { next_ready?: unknown }).next_ready ?? [] };
      }
    }
  }
  return {};
}

// ── envelope + fetch/ack ─────────────────────────────────────────────────
interface MsgRow {
  id: number; ts: string; sender: string; alias: string; kind: string;
  reply_to: number | null; to_json: string; cc_json: string; body: string;
  delivered_as?: string; taken_ts?: string | null; email_status?: string | null;
}

export function envelope(c: Ctx, row: MsgRow): Record<string, unknown> {
  const stamp = row.sender !== "relay" ? senderStamp(c, row.sender, row.alias)
    : { box: "relay", display_name: "relay", member_no: null, team: null, platform: "relay", role: "", is_human: false };
  const kind = row.kind;
  const dkey = kind === "system" ? "system" : row.delivered_as || "to";
  const e: Record<string, unknown> = {
    id: row.id, ts: row.ts, kind, from: stamp, reply_to: row.reply_to,
    to: JSON.parse(row.to_json), cc: JSON.parse(row.cc_json),
    delivered_as: row.delivered_as, directive: DIRECTIVES[dkey], body: row.body,
  };
  // team_info is attached by fetchBox/doPoll where the recipient is known.
  return e;
}

function attachTeamInfo(c: Ctx, e: Record<string, unknown>, recipient: string): void {
  const stamp = e.from as Stamp;
  if (!stamp.team) return;
  const t = c.db.prepare("SELECT name, rv FROM teams WHERE code=?").get(stamp.team) as { name: string; rv: number } | undefined;
  const rv = t?.rv ?? 1;
  const tname = t?.name || stamp.team;
  const n = (c.db.prepare("SELECT count(*) c FROM boxes WHERE team_code=?").get(stamp.team) as { c: number }).c;
  // change-aware footer: full card once per roster version per recipient
  const seen = c.db.prepare("SELECT rv FROM roster_seen WHERE box=? AND team=?").get(recipient, stamp.team) as { rv: number } | undefined;
  if ((seen?.rv ?? 0) < rv) {
    e.team_info = teamCard(c, stamp.team);
    c.db.prepare("INSERT INTO roster_seen(box,team,rv) VALUES(?,?,?) ON CONFLICT(box,team) DO UPDATE SET rv=excluded.rv")
      .run(recipient, stamp.team, rv);
  } else {
    e.team_info = `team ${tname} · ${stamp.team} · ${n} members · roster v${rv} · list_team('${stamp.team}') for detail`;
  }
}

export function fetchBox(c: Ctx, box: string, take: boolean): Record<string, unknown>[] {
  const rows = c.db.prepare(
    "SELECT m.*, d.delivered_as FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.recipient=? AND d.taken_ts IS NULL ORDER BY m.id",
  ).all(box) as MsgRow[];
  const out = rows.map((r) => { const e = envelope(c, r); attachTeamInfo(c, e, box); return e; });
  if (take && rows.length) {
    const upd = c.db.prepare("UPDATE deliveries SET taken_ts=? WHERE msg_id=? AND recipient=?");
    for (const r of rows) upd.run(now(), r.id, box);
  }
  return out;
}

export function doAck(c: Ctx, box: string, throughId: unknown) {
  const tid = Number(throughId);
  if (!Number.isInteger(tid)) return { error: "bad_through_id" };
  const info = c.db.prepare("UPDATE deliveries SET taken_ts=? WHERE recipient=? AND taken_ts IS NULL AND msg_id<=?").run(now(), box, tid);
  return { ok: true, acked: info.changes, through_id: tid };
}

export function boardReminder(c: Ctx, box: string): Record<string, unknown> | null {
  const b = boxRow(c, box);
  if (!b?.team_code) return null;
  const holds = (c.db.prepare("SELECT count(*) n FROM tasks WHERE owner=? AND status='claimed'").get(box) as { n: number }).n;
  if (holds) return null;
  const openTasks = c.db.prepare("SELECT * FROM tasks WHERE team=? AND status='open' ORDER BY priority, id").all(b.team_code) as { id: number; title: string; deps: string; owner: string | null }[];
  const ready = openTasks.filter((t) => taskDepsDone(c, t) && (!t.owner || t.owner === box));
  if (!ready.length) return null;
  return {
    id: 0, kind: "system", ephemeral: true,
    from: { box: "relay", display_name: "relay", platform: "relay", member_no: null, team: b.team_code, role: "", is_human: false },
    to: [box], cc: [], delivered_as: "to", directive: DIRECTIVES.system,
    body: `BOARD REMINDER: you hold no task and the board has ${ready.length} ready (first: #${ready[0].id} "${ready[0].title}"). If nothing in this mail changes your priorities, task_claim one now instead of going idle. Do not ack this reminder — it is not stored.`,
  };
}

export async function doPoll(c: Ctx, box: string, waitS: number, take: boolean): Promise<Record<string, unknown>[]> {
  touchBox(c, box);
  c.db.prepare("UPDATE boxes SET prev_poll=last_poll, last_poll=? WHERE box=?").run(now(), box);
  const deadline = Date.now() + Math.min(Math.max(waitS, 0), c.cfg.limits.max_wait_s) * 1000;
  for (;;) {
    const msgs = fetchBox(c, box, take);
    if (msgs.length || Date.now() >= deadline) return msgs;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function doThread(c: Ctx, mid: unknown, limit = 50) {
  const id = Number(mid);
  if (!Number.isInteger(id)) return { error: "bad_id" };
  let root = c.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as MsgRow | undefined;
  if (!root) return { error: "no_such_message" };
  let up = 0;
  while (root.reply_to && up < limit) {
    const p = c.db.prepare("SELECT * FROM messages WHERE id=?").get(root.reply_to) as MsgRow | undefined;
    if (!p) break; root = p; up++;
  }
  const chain: MsgRow[] = []; const queue = [root.id];
  while (queue.length && chain.length < limit) {
    const nid = queue.shift()!;
    const r = c.db.prepare("SELECT * FROM messages WHERE id=?").get(nid) as MsgRow | undefined;
    if (r) { chain.push(r); for (const x of c.db.prepare("SELECT id FROM messages WHERE reply_to=? ORDER BY id").all(nid) as { id: number }[]) queue.push(x.id); }
  }
  chain.sort((a, b) => a.id - b.id);
  const out = chain.map((r) => {
    const s = r.sender !== "relay" ? senderStamp(c, r.sender, r.alias) : { box: "relay", display_name: "relay", platform: "relay", member_no: null, team: null, role: "", is_human: false };
    return { id: r.id, ts: r.ts, kind: r.kind, reply_to: r.reply_to, from: s, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), body: r.body };
  });
  return { root: out[0]?.id ?? null, messages: out };
}

export function doHistory(c: Ctx, box: string, limit = 50) {
  const lim = Math.min(Math.max(limit, 1), 500);
  const rows = c.db.prepare(
    "SELECT m.*, d.delivered_as, d.taken_ts, d.email_status FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.recipient=? ORDER BY m.id DESC LIMIT ?",
  ).all(box, lim) as MsgRow[];
  const received = rows.map((r) => { const e = envelope(c, r); e.taken_ts = r.taken_ts; if (r.email_status) e.email_status = r.email_status; return e; });
  const sent = (c.db.prepare("SELECT * FROM messages WHERE sender=? ORDER BY id DESC LIMIT ?").all(box, lim) as MsgRow[])
    .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, to: JSON.parse(r.to_json), cc: JSON.parse(r.cc_json), body: r.body }));
  return { received, sent };
}
