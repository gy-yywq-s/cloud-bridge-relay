// Human accounts: argon2 email/password + GitHub (arctic) + private-mode
// deployer password. Web sessions are signed JWT cookies (hono/jwt).
import { hash, verify } from "@node-rs/argon2";
import { GitHub } from "arctic";
import { sign, verify as jwtVerify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Ctx } from "../core/context.js";
import { now } from "../db.js";

interface Account { id: number; email: string; pw_hash: string | null; display: string }

export async function createAccount(c: Ctx, email: string, password: string, display = ""): Promise<{ ok: true; id: number } | { error: string }> {
  email = email.trim().toLowerCase();
  if (!email.includes("@")) return { error: "a real email is required" };
  if (password.length < 8) return { error: "password must be at least 8 characters" };
  if (c.db.prepare("SELECT 1 FROM accounts WHERE email=?").get(email)) return { error: "an account with that email already exists" };
  const pw = await hash(password);
  const info = c.db.prepare("INSERT INTO accounts(email,pw_hash,display,created_ts) VALUES(?,?,?,?)").run(email, pw, display || email.split("@")[0], now());
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export async function verifyAccount(c: Ctx, email: string, password: string): Promise<number | null> {
  const a = c.db.prepare("SELECT * FROM accounts WHERE email=?").get(email.trim().toLowerCase()) as Account | undefined;
  if (!a || !a.pw_hash) return null; // no password set (e.g. GitHub-only account) → password login impossible
  try { return (await verify(a.pw_hash, password)) ? a.id : null; } catch { return null; }
}

export function upsertGithubAccount(c: Ctx, ghLogin: string, ghId: number, display: string): number {
  const email = `gh_${ghId}@github`;
  const existing = c.db.prepare("SELECT id FROM accounts WHERE email=?").get(email) as { id: number } | undefined;
  if (existing) return existing.id;
  // pw_hash NULL, never a guessable sentinel — password login is impossible for GitHub accounts.
  const info = c.db.prepare("INSERT INTO accounts(email,pw_hash,display,created_ts) VALUES(?,NULL,?,?)")
    .run(email, display || ghLogin, now());
  return Number(info.lastInsertRowid);
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
export function deployerPassword(c: Ctx): string | null { return process.env.CREW_DEPLOYER_PASSWORD || null; }

// ── GitHub (arctic) ───────────────────────────────────────────────────────
export function github(c: Ctx): GitHub | null {
  const id = process.env.GITHUB_CLIENT_ID, secret = process.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) return null;
  const cb = `${c.cfg.public_url}/auth/github/callback`;
  return new GitHub(id, secret, cb);
}
