// Invite codes gate open registration: even in cloud mode, a stranger cannot
// create an account without a valid, unspent invite. Codes are created by admins.
import type { Ctx } from "../core/context.js";
import { now } from "../db.js";
import { randHex } from "../core/context.js";

export interface Invite {
  code: string; note: string; max_uses: number; uses: number;
  created_by: number | null; disabled: number; expires_ts: string | null; created_ts: string;
}

// A friendly, unambiguous code (no 0/O/1/l): e.g. "crew-7K9P-2M4X".
function freshCode(): string {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = (n: number) => Array.from({ length: n }, () => A[Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * A.length)]).join("");
  return `crew-${pick(4)}-${pick(4)}`;
}

export function createInvite(c: Ctx, createdBy: number, opts: { note?: string; max_uses?: number; expires_days?: number } = {}): Invite {
  const code = freshCode();
  const maxUses = Math.max(1, Math.min(10000, Number(opts.max_uses) || 1));
  const expires = opts.expires_days && opts.expires_days > 0
    ? new Date(Date.now() + opts.expires_days * 86400 * 1000).toISOString() : null;
  c.db.prepare("INSERT INTO invite_codes(code,note,max_uses,uses,created_by,expires_ts,created_ts) VALUES(?,?,?,0,?,?,?)")
    .run(code, (opts.note || "").slice(0, 200), maxUses, createdBy, expires, now());
  return c.db.prepare("SELECT * FROM invite_codes WHERE code=?").get(code) as Invite;
}

export function listInvites(c: Ctx): Invite[] {
  return c.db.prepare("SELECT * FROM invite_codes ORDER BY created_ts DESC").all() as Invite[];
}

export function inviteValid(c: Ctx, code: string): boolean {
  const r = c.db.prepare("SELECT * FROM invite_codes WHERE code=?").get(code.trim()) as Invite | undefined;
  if (!r || r.disabled) return false;
  if (r.expires_ts && r.expires_ts < now()) return false;
  if (r.max_uses > 0 && r.uses >= r.max_uses) return false;
  return true;
}

// Atomically spend one use; returns false if the code is invalid/exhausted
// (guards against concurrent redemption of a single-use code).
export function consumeInvite(c: Ctx, code: string): boolean {
  const info = c.db.prepare(
    "UPDATE invite_codes SET uses=uses+1 WHERE code=? AND disabled=0 " +
    "AND (expires_ts IS NULL OR expires_ts>=?) AND (max_uses=0 OR uses<max_uses)",
  ).run(code.trim(), now());
  return info.changes > 0;
}

export function setInviteDisabled(c: Ctx, code: string, disabled: boolean): void {
  c.db.prepare("UPDATE invite_codes SET disabled=? WHERE code=?").run(disabled ? 1 : 0, code.trim());
}

export { freshCode };
