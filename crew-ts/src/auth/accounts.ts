// Human accounts: argon2 email/password + GitHub (arctic) + private-mode
// deployer password. Web sessions are signed JWT cookies (hono/jwt).
import { hash, verify } from "@node-rs/argon2";
import { GitHub } from "arctic";
import { sign, verify as jwtVerify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Ctx } from "../core/context.js";
import { dropTenant } from "../core/tenancy.js";
import { now } from "../db.js";

interface Account { id: number; email: string; pw_hash: string | null; display: string; is_admin: number }

// The configured admin allow-list is authoritative: an account is an admin iff
// its email is on it. Applied at creation and reconciled at startup. Admins are
// also pre-authorized to register without an invite (bootstrap: the first admin
// must be able to sign in before any invite exists).
export function isAdminEmail(c: Ctx, email: string): boolean {
  return (c.cfg.auth.admin_emails || []).map((e) => e.trim().toLowerCase()).includes(email.trim().toLowerCase());
}

// Admin iff the stored flag is set OR the account's email is on the configured
// allow-list. Checking the allow-list here (not only at startup) makes the answer
// stable across restarts, config edits, and accounts created later — the flaky
// "sometimes I'm not admin" case. A match also heals the stored flag.
export function isAdmin(c: Ctx, accountId: number | null | undefined): boolean {
  if (accountId == null || accountId < 1) return false;
  const r = c.db.prepare("SELECT is_admin, email FROM accounts WHERE id=?").get(accountId) as { is_admin: number; email: string } | undefined;
  if (!r) return false;
  if (r.is_admin) return true;
  if (isAdminEmail(c, r.email)) { c.db.prepare("UPDATE accounts SET is_admin=1 WHERE id=?").run(accountId); return true; }
  return false;
}

// Promote existing accounts whose email is on the admin list — but ONLY GitHub
// accounts, whose email GitHub verified for us. A password account's email is
// self-asserted and unverified, so it is never auto-promoted (that would let an
// attacker claim the admin email by registering it). Operator bootstrap for
// non-GitHub admins is the scripts/bootstrap-admin.mjs tool (direct DB access).
export function reconcileAdmins(c: Ctx): void {
  for (const e of c.cfg.auth.admin_emails || [])
    c.db.prepare("UPDATE accounts SET is_admin=1 WHERE github_id IS NOT NULL AND lower(email)=?").run(e.trim().toLowerCase());
}

export async function createAccount(c: Ctx, email: string, password: string, display = "", isAdmin = 0): Promise<{ ok: true; id: number } | { error: string }> {
  email = email.trim().toLowerCase();
  if (!email.includes("@")) return { error: "a real email is required" };
  if (password.length < 8) return { error: "password must be at least 8 characters" };
  if (c.db.prepare("SELECT 1 FROM accounts WHERE email=?").get(email)) return { error: "an account with that email already exists" };
  const pw = await hash(password);
  // is_admin is caller-supplied (0 for web signup) — NEVER derived from the
  // unverified submitted email. Only proven paths (GitHub, bootstrap) set it.
  const info = c.db.prepare("INSERT INTO accounts(email,pw_hash,is_admin,display,created_ts) VALUES(?,?,?,?,?)").run(email, pw, isAdmin ? 1 : 0, display || email.split("@")[0], now());
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export async function verifyAccount(c: Ctx, email: string, password: string): Promise<number | null> {
  const a = c.db.prepare("SELECT * FROM accounts WHERE email=?").get(email.trim().toLowerCase()) as Account | undefined;
  if (!a || !a.pw_hash) return null; // no password set (e.g. GitHub-only account) → password login impossible
  try { return (await verify(a.pw_hash, password)) ? a.id : null; } catch { return null; }
}

// GitHub identity is keyed by the immutable numeric id (login/email can change).
// The real verified email is stored when available so the admin allow-list can
// match it; otherwise a non-guessable synthetic address is used. pw_hash stays
// NULL so password login is impossible for GitHub accounts.
export function upsertGithubAccount(c: Ctx, ghLogin: string, ghId: number, display: string, realEmail?: string | null): number {
  // 1) Known GitHub identity → that account.
  const byId = c.db.prepare("SELECT id FROM accounts WHERE github_id=?").get(ghId) as { id: number } | undefined;
  const email = (realEmail && realEmail.includes("@")) ? realEmail.trim().toLowerCase() : null;
  if (byId) {
    if (email && isAdminEmail(c, email)) c.db.prepare("UPDATE accounts SET is_admin=1 WHERE id=?").run(byId.id);
    return byId.id;
  }
  // 2) LINK to an existing account with the same VERIFIED email (e.g. the user
  //    first registered with email+password, now signs in with GitHub) — one
  //    person, one account. No duplicate rows.
  if (email) {
    const byEmail = c.db.prepare("SELECT id FROM accounts WHERE email=?").get(email) as { id: number } | undefined;
    if (byEmail) {
      c.db.prepare("UPDATE accounts SET github_id=COALESCE(github_id,?) WHERE id=?").run(ghId, byEmail.id);
      if (isAdminEmail(c, email)) c.db.prepare("UPDATE accounts SET is_admin=1 WHERE id=?").run(byEmail.id);
      return byEmail.id;
    }
  }
  // 3) New account. Store the verified email (enables admin match); else synthetic.
  const storeEmail = email || `gh_${ghId}@github`;
  const admin = email && isAdminEmail(c, email) ? 1 : 0;
  const info = c.db.prepare("INSERT INTO accounts(email,pw_hash,github_id,is_admin,display,created_ts) VALUES(?,NULL,?,?,?,?)")
    .run(storeEmail, ghId, admin, display || ghLogin, now());
  return Number(info.lastInsertRowid);
}

// Permanently delete an account: its control-plane rows and, in cloud mode, its
// isolated tenant database. Irreversible.
export function deleteAccount(ctrl: Ctx, id: number): void {
  ctrl.db.prepare("DELETE FROM oauth_tokens WHERE account_id=?").run(id);
  ctrl.db.prepare("DELETE FROM oauth_codes WHERE account_id=?").run(id);
  ctrl.db.prepare("DELETE FROM accounts WHERE id=?").run(id);
  dropTenant(ctrl, id);
}

// ── sessions (signed cookie) ──────────────────────────────────────────────
function sessionSecret(c: Ctx): string {
  const env = process.env[c.cfg.auth.session_secret_env];
  if (env) return env;
  // per-boot fallback: sessions do not survive a restart (acceptable, logged once)
  const g = globalThis as { __crewSecret?: string };
  if (!g.__crewSecret) { g.__crewSecret = crypto.randomUUID() + crypto.randomUUID(); console.warn(`[crew] ${c.cfg.auth.session_secret_env} not set — using an ephemeral session secret (logins drop on restart).`); }
  return g.__crewSecret;
}

export async function setSession(c: Ctx, ctx: Context, accountId: number): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const token = await sign({ sub: accountId, iat: nowS, exp: nowS + 60 * 60 * 24 * 30 }, sessionSecret(c));
  setCookie(ctx, "crew_session", token, { httpOnly: true, secure: c.cfg.mode !== "local", sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
}

export async function getSession(c: Ctx, ctx: Context): Promise<number | null> {
  const t = getCookie(ctx, "crew_session");
  if (!t) return null;
  try { const p = await jwtVerify(t, sessionSecret(c), "HS256"); return typeof p.sub === "number" ? p.sub : null; } catch { return null; }
}

export function clearSession(ctx: Context): void { deleteCookie(ctx, "crew_session", { path: "/" }); }

// private-mode deployer: one shared password (env) → synthetic account id -1.
// Meaningless under cloud multi-tenancy (id -1 owns no tenant database), so it
// is disabled there — cloud users authenticate as real, isolated accounts.
export function deployerPassword(c: Ctx): string | null {
  if (c.cfg.mode === "cloud") return null;
  return process.env.CREW_DEPLOYER_PASSWORD || null;
}

// ── GitHub (arctic) ───────────────────────────────────────────────────────
export function github(c: Ctx): GitHub | null {
  const id = process.env.GITHUB_CLIENT_ID, secret = process.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) return null;
  const cb = `${c.cfg.public_url}/auth/github/callback`;
  return new GitHub(id, secret, cb);
}
