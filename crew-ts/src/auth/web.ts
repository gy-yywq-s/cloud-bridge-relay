// Login / registration / GitHub / OAuth consent web routes. When an MCP client
// starts the OAuth flow, provider.authorize() redirects here with ?auth=<pid>.
// After the human authenticates we show an explicit CONSENT screen; only a POST
// carrying a session-bound CSRF token mints the authorization code and bounces
// back to the client. Authorization codes are NEVER minted on a GET — that would
// let a cross-site link silently issue a victim-scoped token (SameSite=Lax sends
// the session cookie on top-level GETs). All account/OAuth state lives on the
// CONTROL database, so this module always runs against the control Ctx.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { generateState } from "arctic";
import type { Ctx } from "../core/context.js";
import { randHex } from "../core/context.js";
import { page, esc } from "../web/theme.js";
import {
  createAccount, verifyAccount, upsertGithubAccount, setSession, getSession,
  deployerPassword, github, clearSession, isAdminEmail,
} from "./accounts.js";
import { inviteValid, consumeInvite } from "./invites.js";
import { mintCode } from "./store.js";

const cookieOpt = (c: Ctx) => ({ httpOnly: true, secure: c.cfg.mode !== "local", sameSite: "Lax" as const, path: "/", maxAge: 600 });

// After authentication: if a client is waiting, send the human to the consent
// screen (a GET that mints nothing); otherwise into the app.
async function afterAuth(c: Ctx, ctx: import("hono").Context, accountId: number, authPid: string, state: string) {
  await setSession(c, ctx, accountId);
  if (authPid) return ctx.redirect(`/login?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}`);
  return ctx.redirect("/app");
}

const errPage = (c: Ctx, title: string, msg: string, back = "/login") =>
  page(c.cfg, title, `<div class="card" style="max-width:420px"><h1>${esc(title)}</h1><p class="err">${esc(msg)}</p><p><a href="${esc(back)}">Back</a></p></div>`);

// Consent screen shown to an already-signed-in human before a code is issued.
function consentPage(c: Ctx, ctx: import("hono").Context, pid: string, state: string): string {
  const p = c.db.prepare("SELECT client_id, redirect_uri FROM oauth_pending WHERE pid=?").get(pid) as { client_id: string; redirect_uri: string } | undefined;
  const cl = p ? c.db.prepare("SELECT name FROM oauth_clients WHERE client_id=?").get(p.client_id) as { name: string } | undefined : undefined;
  const csrf = randHex(16);
  setCookie(ctx, "crew_csrf", csrf, cookieOpt(c));
  const who = cl?.name ? esc(cl.name) : "An application";
  // The client name is attacker-controllable via open DCR, so also surface the
  // real destination host — an unexpected one is the tell for consent phishing.
  let dest = "";
  try { dest = p ? new URL(p.redirect_uri).host : ""; } catch { dest = p?.redirect_uri || ""; }
  return page(c.cfg, "Authorize", `
    <div class="card" style="max-width:420px">
      <h1>Authorize access</h1>
      <p class="muted small">${who} wants to connect to your ${esc(c.cfg.brand.name)} account and act on your behalf.</p>
      ${dest ? `<p class="small">It will send the authorization to <b>${esc(dest)}</b>. Only approve if you recognize this destination.</p>` : ""}
      <form method="post" action="/oauth/consent" style="margin-top:12px">
        <input type="hidden" name="auth" value="${esc(pid)}">
        <input type="hidden" name="state" value="${esc(state)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="row"><button class="btn grow">Approve</button>
        <button class="btn ghost" name="deny" value="1">Deny</button></div>
      </form>
      <p class="small muted" style="margin-top:12px"><a href="/logout">Not you? Sign out</a></p>
    </div>`);
}

// GitHub can withhold email from the profile endpoint; fetch the primary
// verified address explicitly so the admin allow-list can match a proven email.
async function githubPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user/emails", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "crew-relay", Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const list = await res.json() as { email: string; primary: boolean; verified: boolean }[];
    const primary = list.find((e) => e.primary && e.verified) || list.find((e) => e.verified);
    return primary?.email ?? null;
  } catch { return null; }
}

export function authRoutes(c: Ctx): Hono {
  const app = new Hono();
  const gh = github(c);
  const openReg = c.cfg.auth.open_registration;

  app.get("/login", async (ctx) => {
    const authPid = ctx.req.query("auth") || "";
    const state = ctx.req.query("state") || "";
    const sess = await getSession(c, ctx);
    // Already signed in + a client is waiting → CONSENT screen (mints nothing).
    if (sess != null && authPid) return ctx.html(consentPage(c, ctx, authPid, state));
    if (sess != null) return ctx.redirect("/app");
    const hidden = `<input type="hidden" name="auth" value="${esc(authPid)}"><input type="hidden" name="state" value="${esc(state)}">`;
    const ghBtn = gh ? `<a id="ghlink" class="btn gh" href="/auth/github?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}">Continue with GitHub</a>` : "";
    const dep = deployerPassword(c) ? `<p class="small muted">Deployer? Enter the deployer password as the password with any email.</p>` : "";
    const reg = openReg ? `<div class="sep"></div><form method="post" action="/signup">${hidden}
      <p class="small muted">New here? Registration is invite-only.</p>
      <label>Invite code</label><input name="invite" id="invitefield" placeholder="crew-XXXX-XXXX" required>
      <label>Email</label><input name="email" type="email" required>
      <label>Password (min 8)</label><input name="password" type="password" required>
      <button class="btn ghost" style="margin-top:12px">Create account</button></form>
      ${gh ? `<script>(function(){var g=document.getElementById('ghlink'),f=document.getElementById('invitefield');if(g&&f)g.addEventListener('click',function(){var u=new URL(g.getAttribute('href'),location.origin);if(f.value)u.searchParams.set('invite',f.value.trim());g.setAttribute('href',u.pathname+u.search);});})();</script>` : ""}` : "";
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

  // Explicit consent: the ONLY place an authorization code is minted. Requires a
  // live session AND a matching double-submit CSRF token, so a cross-site request
  // (which under SameSite=Lax carries no session cookie on POST anyway) cannot
  // forge approval on a victim's behalf.
  app.post("/oauth/consent", async (ctx) => {
    const b = await ctx.req.parseBody();
    const authPid = String(b.auth || ""), state = String(b.state || ""), csrf = String(b.csrf || "");
    const sess = await getSession(c, ctx);
    if (sess == null) return ctx.redirect(`/login?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}`);
    const want = getCookie(ctx, "crew_csrf") || "";
    deleteCookie(ctx, "crew_csrf", { path: "/" });
    if (!csrf || csrf !== want) return ctx.html(errPage(c, "Authorize", "Your approval could not be verified. Please try connecting again."), 403);
    if (b.deny) return ctx.redirect("/app");
    const r = mintCode(c, authPid, sess);
    if (!r) return ctx.html(errPage(c, "Authorize", "This authorization request expired. Start the connection again from your client."), 400);
    const u = new URL(r.redirectUri);
    u.searchParams.set("code", r.code);
    if (state) u.searchParams.set("state", state);
    return ctx.redirect(u.toString());
  });

  app.post("/login", async (ctx) => {
    const b = await ctx.req.parseBody();
    const email = String(b.email || ""), password = String(b.password || "");
    const authPid = String(b.auth || ""), state = String(b.state || "");
    const dep = deployerPassword(c);
    if (dep && password === dep) return afterAuth(c, ctx, -1, authPid, state); // deployer (private only)
    const id = await verifyAccount(c, email, password);
    if (id == null) return ctx.html(errPage(c, "Sign in", "Wrong email or password.", `/login?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}`), 401);
    return afterAuth(c, ctx, id, authPid, state);
  });

  app.post("/signup", async (ctx) => {
    if (!openReg) return ctx.text("registration closed", 403);
    const b = await ctx.req.parseBody();
    const email = String(b.email || "");
    const invite = String(b.invite || "").trim();
    // Password registration ALWAYS requires a valid, atomically-consumed invite.
    // Admin status is NOT granted from a self-asserted email here — an email is
    // only trusted for admin once proven (GitHub verified email, or the operator
    // bootstrap script). This prevents claiming the admin email by registering it.
    if (!inviteValid(c, invite)) return ctx.html(errPage(c, "Create account", "That invite code is invalid, expired, or already used."), 400);
    const r = await createAccount(c, email, String(b.password || ""));
    if ("error" in r) return ctx.html(errPage(c, "Create account", r.error), 400);
    if (!consumeInvite(c, invite)) { // lost a race for the last use
      c.db.prepare("DELETE FROM accounts WHERE id=?").run(r.id);
      return ctx.html(errPage(c, "Create account", "That invite was just used up. Ask for another."), 400);
    }
    return afterAuth(c, ctx, r.id, String(b.auth || ""), String(b.state || ""));
  });

  app.get("/auth/github", async (ctx) => {
    if (!gh) return ctx.text("GitHub login not configured", 404);
    const state = generateState();
    setCookie(ctx, "gh_state", state, cookieOpt(c));
    setCookie(ctx, "gh_auth", String(ctx.req.query("auth") || ""), cookieOpt(c));
    setCookie(ctx, "gh_ostate", String(ctx.req.query("state") || ""), cookieOpt(c));
    setCookie(ctx, "gh_invite", String(ctx.req.query("invite") || ""), cookieOpt(c));
    const url = gh.createAuthorizationURL(state, ["read:user", "user:email"]);
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
      const known = c.db.prepare("SELECT id FROM accounts WHERE github_id=?").get(u.id) as { id: number } | undefined;
      const email = await githubPrimaryEmail(tokens.accessToken()); // verified primary only
      // Creating a NEW account via GitHub is invite-gated too (cloud open reg),
      // unless the VERIFIED email is an allow-listed admin (secure bootstrap).
      const invite = getCookie(ctx, "gh_invite") || "";
      if (!known && openReg && !(email && isAdminEmail(c, email))) {
        if (!inviteValid(c, invite)) return ctx.html(errPage(c, "Invite required", "Creating a new account needs a valid invite code. Enter it on the sign-in page, then continue with GitHub."), 400);
        if (!consumeInvite(c, invite)) return ctx.html(errPage(c, "Invite required", "That invite was just used up. Ask for another."), 400);
      }
      const id = upsertGithubAccount(c, u.login, u.id, u.name || u.login, email);
      return afterAuth(c, ctx, id, getCookie(ctx, "gh_auth") || "", getCookie(ctx, "gh_ostate") || "");
    } catch {
      return ctx.text("GitHub authentication failed", 401);
    }
  });

  app.get("/logout", (ctx) => { clearSession(ctx); return ctx.redirect("/login"); });

  return app;
}
