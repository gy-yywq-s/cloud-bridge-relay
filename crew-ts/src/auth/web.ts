// Login / signup / GitHub / OAuth consent web routes. Login and signup are
// SEPARATE centered pages that cross-link; each carries any in-progress client
// authorization (?auth=<pid>&state=) through the navigation. "Continue with
// GitHub" appears on both and does double duty (it signs in, or creates the
// account on first use — invite-gated in cloud). An authorization code is only
// ever minted from the explicit consent POST (never on a GET). All account/OAuth
// state lives on the CONTROL database, so this module runs against the control Ctx.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { generateState } from "arctic";
import type { Ctx } from "../core/context.js";
import { randHex } from "../core/context.js";
import { authPage, esc } from "../web/theme.js";
import { githubMark } from "../web/icons.js";
import {
  createAccount, verifyAccount, upsertGithubAccount, setSession, getSession,
  deployerPassword, github, clearSession, isAdminEmail,
} from "./accounts.js";
import { inviteValid, consumeInvite } from "./invites.js";
import { mintCode } from "./store.js";

const cookieOpt = (c: Ctx) => ({ httpOnly: true, secure: c.cfg.mode !== "local", sameSite: "Lax" as const, path: "/", maxAge: 600 });
const qs = (authPid: string, state: string) => (authPid ? `?auth=${encodeURIComponent(authPid)}&state=${encodeURIComponent(state)}` : "");
const hiddenFields = (authPid: string, state: string) => `<input type="hidden" name="auth" value="${esc(authPid)}"><input type="hidden" name="state" value="${esc(state)}">`;

// After authentication: if a client is waiting, go to the consent screen (a GET
// that mints nothing); otherwise into the app.
async function afterAuth(c: Ctx, ctx: import("hono").Context, accountId: number, authPid: string, state: string) {
  await setSession(c, ctx, accountId);
  if (authPid) return ctx.redirect(`/login${qs(authPid, state)}`);
  return ctx.redirect("/app");
}

const errPage = (c: Ctx, title: string, msg: string, back = "/login") =>
  authPage(title, `<div class="card"><h1>${esc(title)}</h1><p class="err">${esc(msg)}</p><p class="altlink"><a href="${esc(back)}">Back</a></p></div>`);

function consentPage(c: Ctx, ctx: import("hono").Context, pid: string, state: string): string {
  const p = c.db.prepare("SELECT client_id, redirect_uri FROM oauth_pending WHERE pid=?").get(pid) as { client_id: string; redirect_uri: string } | undefined;
  const cl = p ? c.db.prepare("SELECT name FROM oauth_clients WHERE client_id=?").get(p.client_id) as { name: string } | undefined : undefined;
  const csrf = randHex(16);
  setCookie(ctx, "crew_csrf", csrf, cookieOpt(c));
  const who = cl?.name ? esc(cl.name) : "An application";
  let dest = "";
  try { dest = p ? new URL(p.redirect_uri).host : ""; } catch { dest = p?.redirect_uri || ""; }
  return authPage("Authorize", `
    <div class="card">
      <h1>Authorize access</h1>
      <p class="muted small">${who} wants to connect to your ${esc(c.cfg.brand.name)} account and act on your behalf.</p>
      ${dest ? `<p class="small">It will send the authorization to <b>${esc(dest)}</b>. Only approve if you recognize this destination.</p>` : ""}
      <form method="post" action="/oauth/consent" style="margin-top:14px">
        <input type="hidden" name="auth" value="${esc(pid)}">
        <input type="hidden" name="state" value="${esc(state)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="btn">Approve</button>
        <button class="btn ghost" name="deny" value="1" style="margin-top:8px">Deny</button>
      </form>
      <p class="altlink"><a href="/logout">Not you? Sign out</a></p>
    </div>`);
}

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
  const ghAnchor = (authPid: string, state: string, id = "") =>
    `<a ${id ? `id="${id}" ` : ""}class="btn gh block" href="/auth/github${qs(authPid, state)}">${githubMark(17)}Continue with GitHub</a>`;

  // ── Sign in ───────────────────────────────────────────────────────────────
  // The sign-in card, rendered with an optional inline error and the email the
  // human already typed — a failed attempt must never blank the form.
  const loginCard = (authPid: string, state: string, err = "", email = "") => authPage(authPid ? "Authorize a client" : "Sign in", `
      <div class="card">
        <h1>Sign in</h1>
        ${authPid ? `<p class="muted small">An MCP client wants to connect to your ${esc(c.cfg.brand.name)} account.</p>` : `<p class="muted small">Welcome back.</p>`}
        ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ""}
        <form method="post" action="/login">${hiddenFields(authPid, state)}
          <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(email)}">
          <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
          <button class="btn" style="margin-top:16px">Sign in</button>
        </form>
        ${gh ? `<div class="sep"></div>${ghAnchor(authPid, state)}` : ""}
        ${deployerPassword(c) ? `<p class="small muted" style="margin-top:12px">Deployer? Enter the deployer password as the password with any email.</p>` : ""}
        ${openReg ? `<p class="altlink">New here? <a href="/signup${qs(authPid, state)}">Create an account</a></p>` : ""}
      </div>`);

  app.get("/login", async (ctx) => {
    const authPid = ctx.req.query("auth") || "";
    const state = ctx.req.query("state") || "";
    const sess = await getSession(c, ctx);
    if (sess != null && authPid) return ctx.html(consentPage(c, ctx, authPid, state)); // approve waiting client
    if (sess != null) return ctx.redirect("/app");
    return ctx.html(loginCard(authPid, state));
  });

  app.post("/login", async (ctx) => {
    const b = await ctx.req.parseBody();
    const email = String(b.email || ""), password = String(b.password || "");
    const authPid = String(b.auth || ""), state = String(b.state || "");
    const dep = deployerPassword(c);
    if (dep && password === dep) return afterAuth(c, ctx, -1, authPid, state); // deployer (private only)
    const id = await verifyAccount(c, email, password);
    if (id == null) return ctx.html(loginCard(authPid, state, "Wrong email or password.", email), 401);
    return afterAuth(c, ctx, id, authPid, state);
  });

  // ── Create account (separate page) ─────────────────────────────────────────
  // Same contract as the sign-in card: errors render inline and every value the
  // human already typed comes back with them.
  const signupCard = (authPid: string, state: string, err = "", invite = "", email = "") => {
    const ghBlock = gh ? `<div class="sep"></div>${ghAnchor(authPid, state, "ghlink")}
      <p class="small muted" style="margin-top:8px">GitHub sign-up uses the invite code above too.</p>
      <script>(function(){var g=document.getElementById('ghlink'),f=document.getElementById('invitefield');if(g&&f)g.addEventListener('click',function(){var u=new URL(g.getAttribute('href'),location.origin);if(f.value)u.searchParams.set('invite',f.value.trim());g.setAttribute('href',u.pathname+u.search);});})();</script>` : "";
    return authPage("Create account", `
      <div class="card">
        <h1>Create your account</h1>
        <p class="muted small">Registration is invite-only — enter your code to join.</p>
        ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ""}
        <form method="post" action="/signup">${hiddenFields(authPid, state)}
          <label for="invitefield">Invite code</label><input id="invitefield" name="invite" placeholder="crew-XXXX-XXXX" autocomplete="off" required autofocus value="${esc(invite)}">
          <label for="su-email">Email</label><input id="su-email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
          <label for="su-pw">Password (min 8)</label><input id="su-pw" name="password" type="password" autocomplete="new-password" minlength="8" required>
          <button class="btn" style="margin-top:16px">Create account</button>
        </form>
        ${ghBlock}
        <p class="altlink">Already have an account? <a href="/login${qs(authPid, state)}">Sign in</a></p>
      </div>`);
  };

  app.get("/signup", async (ctx) => {
    if (!openReg) return ctx.redirect("/login");
    const authPid = ctx.req.query("auth") || "";
    const state = ctx.req.query("state") || "";
    if ((await getSession(c, ctx)) != null) return ctx.redirect(authPid ? `/login${qs(authPid, state)}` : "/app");
    return ctx.html(signupCard(authPid, state));
  });

  app.post("/signup", async (ctx) => {
    if (!openReg) return ctx.text("registration closed", 403);
    const b = await ctx.req.parseBody();
    const email = String(b.email || "");
    const invite = String(b.invite || "").trim();
    const authPid = String(b.auth || ""), state = String(b.state || "");
    // Admins (allow-listed emails) bootstrap without an invite; everyone else
    // needs a valid one, consumed atomically after the account is created.
    // Admin is NOT granted from this self-asserted email — only proven ones.
    const bypass = isAdminEmail(c, email);
    const fail = (msg: string) => ctx.html(signupCard(authPid, state, msg, invite, email), 400);
    if (!bypass && !inviteValid(c, invite)) return fail("That invite code is invalid, expired, or already used.");
    const r = await createAccount(c, email, String(b.password || ""));
    if ("error" in r) return fail(r.error);
    if (!bypass && !consumeInvite(c, invite)) {
      c.db.prepare("DELETE FROM accounts WHERE id=?").run(r.id);
      return fail("That invite was just used up. Ask for another.");
    }
    return afterAuth(c, ctx, r.id, authPid, state);
  });

  // ── OAuth consent (the ONLY place a code is minted) ────────────────────────
  app.post("/oauth/consent", async (ctx) => {
    const b = await ctx.req.parseBody();
    const authPid = String(b.auth || ""), state = String(b.state || ""), csrf = String(b.csrf || "");
    const sess = await getSession(c, ctx);
    if (sess == null) return ctx.redirect(`/login${qs(authPid, state)}`);
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

  // ── GitHub ─────────────────────────────────────────────────────────────────
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
      const invite = getCookie(ctx, "gh_invite") || "";
      if (!known && openReg && !(email && isAdminEmail(c, email))) {
        if (!inviteValid(c, invite)) return ctx.html(errPage(c, "Invite required", "Creating a new account needs a valid invite code. Enter it on the Create-account page, then continue with GitHub.", "/signup"), 400);
        if (!consumeInvite(c, invite)) return ctx.html(errPage(c, "Invite required", "That invite was just used up. Ask for another.", "/signup"), 400);
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
