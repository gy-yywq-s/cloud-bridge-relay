// Shared context and box/team helpers used across the core modules.
import type { DB } from "../db.js";
import { now } from "../db.js";
import type { Config } from "../config.js";

export interface Ctx {
  db: DB;
  cfg: Config;
  email: (to: string, subject: string, text: string, html?: string, sender?: string)
    => Promise<{ ok: true; resendId?: string } | { error: string }>;
}

export const BOX_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const OWNER_BOX = "owner";
export const PLATFORMS = ["claude-code", "codex"] as const;
export const ROLES = ["manager", "worker"] as const;

export const DIRECTIVES: Record<string, string> = {
  to: "ACTION: THIS MESSAGE IS ADDRESSED TO YOU. Read it, act on it, and reply to the sender's box.",
  cc: "THIS IS A CC — FOR YOUR INFORMATION ONLY. You are NOT the primary recipient. Do not act on it and do not reply unless it explicitly asks you by name.",
  system: "SYSTEM NOTICE from the relay itself (not from any session). It describes a team or setup event. Follow its instructions exactly; do not reply to it.",
};

export const RELAY_RULE =
  "PRESENTATION RULE: give the human every fact, option and default in this " +
  "response — nothing added, nothing dropped, nothing decided on their behalf. " +
  "The prose is YOURS: use your interface's best formatting (markdown tables " +
  "and lists where they help), speak the human's language, and use the first " +
  "person when an item refers to your own box. Never paste raw separators, ids " +
  "or ASCII layout at the human when a table or sentence is clearer. Facts and " +
  "sequence are fixed; wording and format are not.";

export const codeRe = (cfg: Config) =>
  new RegExp(`^\\d{${cfg.team.pool_code_digits}}$`);

export interface BoxRow {
  box: string; alias: string; session_name: string; platform: string;
  env: string; status: string; pool_code: string | null; team_code: string | null;
  member_no: number | null; role: string; is_human: number; stale: number;
  last_poll: string | null; prev_poll: string | null; account_id: number | null;
  created_ts: string; last_seen: string;
}

export const boxRow = (c: Ctx, box: string): BoxRow | undefined =>
  c.db.prepare("SELECT * FROM boxes WHERE box=?").get(box) as BoxRow | undefined;

export function displayName(c: Ctx, b: BoxRow | undefined): string {
  if (!b) return "";
  if (b.alias) return b.alias;
  if (b.team_code && b.member_no) {
    const t = c.db.prepare("SELECT name FROM teams WHERE code=?").get(b.team_code) as { name: string } | undefined;
    const base = t?.name || `team${b.team_code}`;
    return `${base}-${b.member_no}`;
  }
  return b.session_name || b.box;
}

export interface Stamp {
  box: string; display_name: string; member_no: number | null;
  team: string | null; platform: string; role: string; is_human: boolean;
}

export function senderStamp(c: Ctx, box: string, fallbackAlias = ""): Stamp {
  const b = boxRow(c, box);
  if (!b)
    return { box, display_name: fallbackAlias || box, member_no: null, team: null, platform: "unknown", role: "", is_human: false };
  return {
    box, display_name: displayName(c, b) || fallbackAlias, member_no: b.member_no,
    team: b.team_code, platform: b.platform || "unknown", role: b.role, is_human: !!b.is_human,
  };
}

export function asBoxList(v: unknown): string[] | null {
  if (v == null) return [];
  const arr = typeof v === "string" ? [v] : v;
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) return null;
  if (arr.some((x) => !BOX_RE.test(x))) return null;
  return [...new Set(arr)];
}

export function touchBox(c: Ctx, box: string, fields: Partial<BoxRow> = {}): void {
  const b = boxRow(c, box);
  if (!b) {
    c.db.prepare(
      "INSERT INTO boxes(box,alias,session_name,created_ts,last_seen,platform,env,status) VALUES(?,?,?,?,?,?,?,?)",
    ).run(box, fields.alias ?? "", fields.session_name ?? "", now(), now(),
      fields.platform ?? "", fields.env ?? "", fields.status ?? "active");
    return;
  }
  const sets: string[] = ["last_seen=?"];
  const vals: unknown[] = [now()];
  for (const k of ["alias", "session_name", "platform", "env", "status", "role"] as const) {
    if (k in fields && (fields as Record<string, unknown>)[k] !== "" && (fields as Record<string, unknown>)[k] != null) {
      sets.push(`${k}=?`); vals.push((fields as Record<string, unknown>)[k]);
    }
  }
  vals.push(box);
  c.db.prepare(`UPDATE boxes SET ${sets.join(", ")} WHERE box=?`).run(...vals as never[]);
}

export function bumpRv(c: Ctx, code: string): void {
  c.db.prepare("UPDATE teams SET rv=rv+1 WHERE code=?").run(code);
}

export function teamManagerBox(c: Ctx, code: string): string | null {
  const r = c.db.prepare("SELECT box FROM boxes WHERE team_code=? AND role='manager' AND box!=? LIMIT 1")
    .get(code, OWNER_BOX) as { box: string } | undefined;
  if (r) return r.box;
  const t = c.db.prepare("SELECT coordinator FROM teams WHERE code=?").get(code) as { coordinator: string } | undefined;
  return t?.coordinator ?? null;
}

// ── message insertion + broadcast (defined here to avoid import cycles) ──
export function insertMessage(
  c: Ctx, sender: string, alias: string, kind: string,
  to: string[], cc: string[], body: string,
): number {
  const info = c.db.prepare(
    "INSERT INTO messages(ts,sender,alias,kind,to_json,cc_json,body) VALUES(?,?,?,?,?,?,?)",
  ).run(now(), sender, alias, kind, JSON.stringify(to), JSON.stringify(cc), body);
  const mid = Number(info.lastInsertRowid);
  const del = c.db.prepare("INSERT OR REPLACE INTO deliveries(msg_id,recipient,delivered_as) VALUES(?,?,?)");
  for (const r of to) del.run(mid, r, "to");
  for (const r of cc) del.run(mid, r, "cc");
  return mid;
}

export function systemMail(c: Ctx, toBox: string, body: string): void {
  insertMessage(c, "relay", "relay", "system", [toBox], [], body);
}

export function broadcastTeam(c: Ctx, code: string, body: string): void {
  const rows = c.db.prepare("SELECT box FROM boxes WHERE team_code=? AND box!=?")
    .all(code, OWNER_BOX) as { box: string }[];
  for (const r of rows) systemMail(c, r.box, body);
}

// ── canonical renderings (roster + team card + board share one style) ──
export function teamCard(c: Ctx, code: string): string {
  const t = c.db.prepare("SELECT * FROM teams WHERE code=?").get(code) as { name: string } | undefined;
  if (!t) return "";
  const rows = c.db.prepare("SELECT * FROM boxes WHERE team_code=? ORDER BY member_no").all(code) as BoxRow[];
  const name = t.name || "(unnamed)";
  const lines = [`── team ${name} · ${code} ──`];
  for (const r of rows) {
    const who = displayName(c, r);
    const kind = r.is_human ? "human" : r.platform || "unknown";
    const role = r.role || (r.box === OWNER_BOX ? "owner" : "-");
    const env = (r.env || "").trim();
    const tail = env && !r.is_human ? ` · ${env}` : "";
    lines.push(`#${r.member_no || 0} ${who} · box:${r.box} · ${role} · ${kind}${tail}`);
  }
  return lines.join("\n");
}

export function rosterText(c: Ctx, code: string): string {
  const t = c.db.prepare("SELECT * FROM teams WHERE code=?").get(code) as { name: string } | undefined;
  const name = t?.name || "(unnamed)";
  const lines = [`team ${name} · ${code}`];
  const rows = c.db.prepare("SELECT * FROM boxes WHERE team_code=? ORDER BY member_no").all(code) as BoxRow[];
  for (const r of rows) {
    const pending = (c.db.prepare("SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL")
      .get(r.box) as { n: number }).n;
    const kind = r.is_human ? "human" : r.platform || "unknown";
    const role = r.role || (r.box === OWNER_BOX ? "owner" : "-");
    const bits = [`#${r.member_no || 0} ${displayName(c, r)}`, r.box, role, kind];
    if (r.env && !r.is_human) bits.push(r.env);
    const ntasks = (c.db.prepare("SELECT count(*) n FROM tasks WHERE owner=? AND status='claimed'")
      .get(r.box) as { n: number }).n;
    const tail: string[] = [];
    if (pending) tail.push(`${pending} unread`);
    if (ntasks) tail.push(`${ntasks} task${ntasks > 1 ? "s" : ""}`);
    if (r.stale) tail.push("⚠ needs attention — watcher down or quiet holding work");
    lines.push("  " + bits.join(" · ") + (tail.length ? `   [${tail.join(", ")}]` : ""));
  }
  return lines.join("\n");
}

export function teamViewKey(c: Ctx, code: string): string | null {
  const t = c.db.prepare("SELECT view_key FROM teams WHERE code=?").get(code) as { view_key: string | null } | undefined;
  if (!t) return null;
  if (t.view_key) return t.view_key;
  const k = randHex(3);
  c.db.prepare("UPDATE teams SET view_key=? WHERE code=?").run(k, code);
  return k;
}

export function resolveViewKey(c: Ctx, key: string): string | null {
  const r = c.db.prepare("SELECT code FROM teams WHERE view_key=?")
    .get(String(key).trim().toLowerCase()) as { code: string } | undefined;
  return r?.code ?? null;
}

export function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
