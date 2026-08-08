// Login / registration / GitHub / OAuth-consent web routes. When an MCP client
// starts the OAuth flow, provider.authorize() redirects here with ?auth=<pid>;
// once the human authenticates we mint the code and bounce back to the client.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { generateState } from "arctic";
import type { Ctx } from "../core/context.js";
import { page, esc } from "../web/theme.js";
import {
  createAccount, verifyAccount, upsertGithubAccount, setSession, getSession,
  deployerPassword, github,
} from "./accounts.js";
import { mintCode } from "./store.js";

async function finish(c: Ctx, ctx: import("hono").Context, accountId: number, authPid: string, state: string) {
  await setSession(c, ctx, accountId);
  if (authPid) {
    const r = mintCode(c, authPid, accountId);
    if (r) {
      const u = new URL(r.redirectUri);
      u.searchParams.set("code", r.code);
      if (state) u.searchParams.set("state", state);
      return ctx.redirect(u.toString());
    }
  }
  return ctx.redirect("/app");
}

export function authRoutes(c: Ctx): Hono {
  const app = new Hono();
  const gh = github(c);
  const openReg = c.cfg.auth.open_registration;

  app.get("/login", async (ctx) => {
    const authPid = ctx.req.query("auth") || "";
    const state = ctx.req.query("state") || "";
    // already signed in + an MCP client is waiting → approve straight through
    const sess = await getSession(c, ctx);
    if (sess != null && authPid) return finish(c, ctx, sess, authPid, state);
    const hidden = `<input type="hidden" name="auth" value="${esc(authPid)}"><input type="hidden" name="state" value="${esc(state)}">`;
    const ghBtn = gh ? `<a class="btn gh" href="/auth/github?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}">Continue with GitHub</a>` : "";
    const dep = deployerPassword(c) ? `<p class="small muted">Deployer? Enter the deployer password as the password with any email.</p>` : "";
    const reg = openReg ? `<div class="sep"></div><form method="post" action="/signup">${hidden}
      <label>Create an account — email</label><input name="email" type="email" required>
      <label>Password (min 8)</label><input name="password" type="password" required>
      <button class="btn ghost" style="margin-top:12px">Create account</button></form>` : "";
    return ctx.html(page(c.cfg, authPid ? "Authorize a client" : "Sign in", `
      <div class="card" style="max-width:420px">
        <h1>Sign in</h1>
        ${authPid ? `<p class="muted small">An MCP client wants to connect to your ${esc(c.cfg.brand.name)} account.</p>` : ""}
        <form method="post" action="/login">${hidden}
          <label>Email</label><input name="email" type="email" required autofocus>
          <label>Password</label><input name="password" type="password" required>
          <button class="btn" style="margin-top:14px">Sign in</button>
        </form>
        ${ghBtn ? `<div class="sep"></div>${ghBtn}` : ""}
        ${dep}${reg}
      </div>`));
  });

  app.post("/login", async (ctx) => {
    const b = await ctx.req.parseBody();
    const email = String(b.email || ""), password = String(b.password || "");
    const authPid = String(b.auth || ""), state = String(b.state || "");
    const dep = deployerPassword(c);
    if (dep && password === dep) return finish(c, ctx, -1, authPid, state); // deployer
    const id = await verifyAccount(c, email, password);
    if (id == null) return ctx.html(page(c.cfg, "Sign in", `<div class="card" style="max-width:420px"><h1>Sign in</h1><p class="err">Wrong email or password.</p><p><a href="/login?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}">Try again</a></p></div>`), 401);
    return finish(c, ctx, id, authPid, state);
  });

  app.post("/signup", async (ctx) => {
    if (!openReg) return ctx.text("registration closed", 403);
    const b = await ctx.req.parseBody();
    const r = await createAccount(c, String(b.email || ""), String(b.password || ""));
    if ("error" in r) return ctx.html(page(c.cfg, "Sign in", `<div class="card" style="max-width:420px"><h1>Create account</h1><p class="err">${esc(r.error)}</p><p><a href="/login">Back</a></p></div>`), 400);
    return finish(c, ctx, r.id, String(b.auth || ""), String(b.state || ""));
  });

  app.get("/auth/github", async (ctx) => {
    if (!gh) return ctx.text("GitHub login not configured", 404);
    const state = generateState();
    setCookie(ctx, "gh_state", state, { httpOnly: true, secure: c.cfg.mode !== "local", sameSite: "Lax", path: "/", maxAge: 600 });
    setCookie(ctx, "gh_auth", String(ctx.req.query("auth") || ""), { httpOnly: true, secure: c.cfg.mode !== "local", sameSite: "Lax", path: "/", maxAge: 600 });
    setCookie(ctx, "gh_ostate", String(ctx.req.query("state") || ""), { httpOnly: true, secure: c.cfg.mode !== "local", sameSite: "Lax", path: "/", maxAge: 600 });
    const url = gh.createAuthorizationURL(state, ["read:user"]);
    return ctx.redirect(url.toString());
  });

  app.get("/auth/github/callback", async (ctx) => {
    if (!gh) return ctx.text("GitHub login not configured", 404);
    const code = ctx.req.query("code") || "", state = ctx.req.query("state") || "";
    if (!code || state !== getCookie(ctx, "gh_state")) return ctx.text("bad GitHub state", 400);
    try {
      const tokens = await gh.validateAuthorizationCode(code);
      const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokens.accessToken()}`, "User-Agent": "crew-relay" } });
      const u = await res.json() as { id: number; login: string; name?: string };
      const id = upsertGithubAccount(c, u.login, u.id, u.name || u.login);
      return finish(c, ctx, id, getCookie(ctx, "gh_auth") || "", getCookie(ctx, "gh_ostate") || "");
    } catch {
      return ctx.text("GitHub authentication failed", 401);
    }
  });

  return app;
}
