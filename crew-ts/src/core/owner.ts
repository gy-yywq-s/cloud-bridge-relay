// Owner mailbox: setup/confirm/edit, contact-mode gating, real-email delivery.
import { now } from "../db.js";
import {
  type Ctx, OWNER_BOX, boxRow, senderStamp, teamCard, broadcastTeam,
  systemMail, insertMessage, bumpRv,
} from "./context.js";
import { emailHtml } from "./email_html.js";

export const OWNER_MODES: Record<string, { label: string; allow_senders: string; allow_direct: string; rules: string }> = {
  a: { label: "milestones-only (default)", allow_senders: "manager_only", allow_direct: "justified_only",
       rules: "Only the MANAGER may mail the owner. Normal traffic is CC ONLY, and only concise milestone summaries. A direct `to` is allowed ONLY when the task is hard-blocked without the owner, or for a severe safety/destructive, time-sensitive matter the owner must ACT on — and it requires a justification." },
  b: { label: "manager-open", allow_senders: "manager_only", allow_direct: "free",
       rules: "Only the MANAGER may mail the owner, but both cc and direct `to` are allowed. Keep everything concise." },
  c: { label: "team-open", allow_senders: "any", allow_direct: "justified_only",
       rules: "Any team member may CC the owner. Direct `to` still requires a justification (genuinely important only)." },
  d: { label: "custom", allow_senders: "manager_only", allow_direct: "justified_only", rules: "" },
};

interface OwnerRow {
  id: number; full_name: string; alias: string; email: string; mode: string;
  allow_senders: string; allow_direct: string; custom_rules: string;
  persistent: number; confirmed: number; last_send_error: string;
}

export const ownerRow = (c: Ctx): OwnerRow | undefined =>
  c.db.prepare("SELECT * FROM owner_mailbox WHERE id=1").get() as OwnerRow | undefined;

export async function setupOwner(c: Ctx, fullName: string, alias: string, email: string) {
  if (!fullName || !email || !email.includes("@"))
    return { error: "bad_input", detail: "need full_name and a real email" };
  const prev = ownerRow(c);
  fullName = fullName.slice(0, 100); alias = (alias || fullName).slice(0, 100); email = email.slice(0, 200);
  if (prev && prev.confirmed && prev.email === email) {
    c.db.prepare("UPDATE owner_mailbox SET full_name=?, alias=? WHERE id=1").run(fullName, alias);
    c.db.prepare("UPDATE boxes SET alias=?, session_name=? WHERE box=?").run(alias, fullName, OWNER_BOX);
    const b = boxRow(c, OWNER_BOX);
    if (b?.team_code) { bumpRv(c, b.team_code); broadcastTeam(c, b.team_code, `SETUP CHANGE: owner is now '${alias}' (${fullName}).\n\n${teamCard(c, b.team_code)}`); }
    return { ok: true, updated: "name/alias only", detail: "email unchanged, verification kept" };
  }
  c.db.prepare(
    "INSERT INTO owner_mailbox(id,full_name,alias,email,created_ts) VALUES(1,?,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, alias=excluded.alias, " +
    "email=excluded.email, confirmed=0, last_send_error=''",
  ).run(fullName, alias, email, now());
  const body = `Hello ${fullName},\n\nthis is the verification mail for your owner mailbox on ${c.cfg.brand.name}. If you can read this, tell your session to confirm.`;
  const res = await c.email(email, `Verify your owner mailbox · ${c.cfg.brand.name}`, body,
    emailHtml(c, "VERIFY", "#1668dc", body, [["mailbox", "owner"], ["email", email]], ""), `${c.cfg.brand.name}-setup`);
  if ("ok" in res)
    return { ok: true, verification: "sent",
      directive: `VERIFICATION EMAIL SENT to ${email}. NOW ASK THE OWNER (the human) to check their inbox. ONLY when the owner says they received it, call confirm_owner_mailbox(). If they did not get it, re-run setup_owner_mailbox with a corrected address. DO NOT confirm on your own.` };
  c.db.prepare("UPDATE owner_mailbox SET last_send_error=? WHERE id=1").run(res.error.slice(0, 400));
  return { ok: false, verification: "failed", send_error: res.error,
    directive: `VERIFICATION EMAIL FAILED TO SEND. YOU MUST tell the owner exactly this error: '${res.error}'. The owner may fix the cause, or explicitly say 'override' — only then call confirm_owner_mailbox(override=True).` };
}

export function confirmOwner(c: Ctx, override = false) {
  const o = ownerRow(c);
  if (!o) return { error: "no_owner_mailbox", detail: "run setup_owner_mailbox first" };
  if (o.last_send_error && !override)
    return { error: "send_error_unresolved", detail: `last email failed: ${o.last_send_error} — the owner must say 'override' to force-confirm` };
  c.db.prepare("UPDATE owner_mailbox SET confirmed=1 WHERE id=1").run();
  const b = boxRow(c, OWNER_BOX);
  if (!b)
    c.db.prepare("INSERT INTO boxes(box,alias,session_name,created_ts,last_seen,platform,env,status,role,is_human) VALUES(?,?,?,?,?,?,?,?,?,1)")
      .run(OWNER_BOX, o.alias, o.full_name, now(), now(), "human", "email:" + o.email, "active", "owner");
  else
    c.db.prepare("UPDATE boxes SET alias=?, session_name=?, platform='human', role='owner', is_human=1 WHERE box=?")
      .run(o.alias, o.full_name, OWNER_BOX);
  return { ok: true, confirmed: true, overridden: !!override,
    owner: { full_name: o.full_name, alias: o.alias, email: o.email, mode: o.mode } };
}

export function setOwnerMode(c: Ctx, mode: string, customRules = "", allowSenders = "", allowDirect = "", persistent: boolean | null = null) {
  const o = ownerRow(c);
  if (!o) return { error: "no_owner_mailbox" };
  if (!(mode in OWNER_MODES)) return { error: "bad_mode", detail: `one of ${Object.keys(OWNER_MODES)}` };
  const m = OWNER_MODES[mode];
  const snd = ["manager_only", "any"].includes(allowSenders) ? allowSenders : m.allow_senders;
  const drc = ["justified_only", "free"].includes(allowDirect) ? allowDirect : m.allow_direct;
  const rules = mode === "d" ? String(customRules).slice(0, 2000) : m.rules;
  if (mode === "d" && !rules)
    return { error: "custom_needs_rules", detail: "mode d: translate the owner's natural-language wishes into 1) a short hard rules text, 2) allow_senders (manager_only|any), 3) allow_direct (justified_only|free); READ THEM BACK to the owner and only call again after the owner confirms. Also ASK whether to keep this custom mode permanently (persistent=true)." };
  const keep = persistent == null ? o.persistent : persistent ? 1 : 0;
  c.db.prepare("UPDATE owner_mailbox SET mode=?, allow_senders=?, allow_direct=?, custom_rules=?, persistent=? WHERE id=1")
    .run(mode, snd, drc, mode === "d" ? rules : "", keep);
  const b = boxRow(c, OWNER_BOX);
  if (b?.team_code) broadcastTeam(c, b.team_code, `OWNER CONTACT RULES UPDATED (mode ${mode} — ${m.label}):\n${rules}\n\n${teamCard(c, b.team_code)}`);
  return { ok: true, mode, allow_senders: snd, allow_direct: drc, rules, persistent: !!keep };
}

export function ownerGate(c: Ctx, sender: string, to: string[], cc: string[], justification: string): { error: string; [k: string]: unknown } | null {
  if (!to.includes(OWNER_BOX) && !cc.includes(OWNER_BOX)) return null;
  const o = ownerRow(c);
  if (!o || !o.confirmed)
    return { error: "owner_not_configured", detail: "no confirmed owner mailbox; run /add-owner-mailbox" };
  const sb = boxRow(c, sender);
  const role = sb?.role || "";
  const rules = o.custom_rules || OWNER_MODES[o.mode].rules;
  if (role === "worker")
    return { error: "chain_of_command", directive: `HARD RULE: you are a WORKER. Workers never contact the owner — report to your MANAGER instead and let the manager decide. Owner contact rules in force:\n${rules}` };
  if (o.allow_senders === "manager_only" && role !== "manager")
    return { error: "owner_contact_denied", directive: `HARD RULE: only the MANAGER may mail the owner under the current mode. Rules in force:\n${rules}` };
  if (to.includes(OWNER_BOX) && o.allow_direct === "justified_only" && !String(justification || "").trim())
    return { error: "justification_required", directive: `HARD RULE: a direct \`to\` the owner requires a justification. Ask yourself: is the task hard-blocked without the owner, or is this a severe safety/time-critical matter the owner must ACT on? If yes, resend with owner_justification explaining it in one sentence. If no, send a concise CC instead. Rules in force:\n${rules}` };
  return null;
}

export function attachOwner(c: Ctx, code: string) {
  if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return { error: "no_such_team" };
  const o = ownerRow(c);
  if (!o || !o.confirmed)
    return { error: "owner_not_configured", detail: "set up and confirm the owner mailbox first" };
  c.db.prepare("UPDATE boxes SET team_code=?, member_no=0, status='teamed' WHERE box=?").run(code, OWNER_BOX);
  bumpRv(c, code);
  const rules = o.custom_rules || OWNER_MODES[o.mode].rules;
  broadcastTeam(c, code, `OWNER ATTACHED to team ${code}: ${o.alias} (${o.full_name}) — owner + human, reachable as box 'owner' (delivered by real email; a sent email counts as read). OWNER CONTACT RULES (mode ${o.mode}, HARD):\n${rules}\n\n${teamCard(c, code)}`);
  return { ok: true };
}

// forward an owner-bound delivery as real email; success == read.
export async function emailOwnerDelivery(c: Ctx, mid: number): Promise<void> {
  const o = ownerRow(c);
  if (!o || !o.confirmed) return;
  const row = c.db.prepare(
    "SELECT m.*, d.delivered_as FROM messages m JOIN deliveries d ON d.msg_id=m.id AND d.recipient=? WHERE m.id=?",
  ).get(OWNER_BOX, mid) as { sender: string; alias: string; body: string; to_json: string; cc_json: string; delivered_as: string } | undefined;
  if (!row) return;
  const stamp = senderStamp(c, row.sender, row.alias);
  const isCc = row.delivered_as === "cc";
  let tname = "";
  if (stamp.team) {
    const t = c.db.prepare("SELECT name FROM teams WHERE code=?").get(stamp.team) as { name: string } | undefined;
    tname = t?.name || stamp.team;
  }
  const senderLabel = tname ? `${c.cfg.brand.name}-${tname}` : c.cfg.brand.name;
  const footer = stamp.team ? teamCard(c, stamp.team) : "";
  const meta: [string, string][] = [
    ["from", `${stamp.display_name} · box ${stamp.box} · ${stamp.role || "no-role"} · ${stamp.platform}`],
    ["to", JSON.parse(row.to_json).join(", ")],
    ["cc", JSON.parse(row.cc_json).join(", ")],
  ];
  const kindLine = isCc ? "CC — for your information" : "ACTION — addressed to you";
  const text = `${row.body}\n\n—\n${kindLine}\n` + meta.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n") + (footer ? `\n\n${footer}` : "");
  const html = emailHtml(c, isCc ? "CC · FYI" : "ACTION", isCc ? "#8a8f98" : "#d4380d", row.body, meta, footer);
  const subject = `[${isCc ? "CC" : "ACTION"}] ${stamp.display_name}` + (tname ? ` · ${tname}` : "");
  const res = await c.email(o.email, subject, text, html, senderLabel);
  if ("ok" in res) {
    c.db.prepare("UPDATE deliveries SET taken_ts=?, email_status='sent' WHERE msg_id=? AND recipient=?").run(now(), mid, OWNER_BOX);
  } else {
    c.db.prepare("UPDATE deliveries SET email_status=? WHERE msg_id=? AND recipient=?").run(`failed: ${res.error}`.slice(0, 400), mid, OWNER_BOX);
    c.db.prepare("UPDATE owner_mailbox SET last_send_error=? WHERE id=1").run(res.error.slice(0, 400));
    systemMail(c, row.sender, `EMAIL DELIVERY FAILED for your message to the owner (msg #${mid}): ${res.error} — YOU MUST inform the owner of this failure through whatever channel you have. The message stays queued in the owner box.`);
  }
}
