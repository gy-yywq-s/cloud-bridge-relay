// Settings: everything an operator would otherwise have to edit crew.toml for, or
// drive through an agent's connector — appearance (name / accent / typeface),
// the owner mailbox and its contact rules, the relay's limits and liveness
// timers, plus account deletion. Tenant-scoped where the data is tenant-scoped.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { appShell, esc } from "./theme.js";
import { icon } from "./icons.js";
import { navFor } from "./nav.js";
import { getBrand, setBrand, FONT_SETS, fontSet } from "./brand.js";
import { TUNABLES, GROUP_LABEL, saveTunables } from "./config-store.js";
import { OWNER_MODES, setupOwner, setOwnerMode, confirmOwner } from "../core/owner.js";
import { getSession, isAdmin, clearSession, deleteAccount } from "../auth/accounts.js";
import { tenantCtx } from "../core/tenancy.js";
import { accountEmail } from "./app.js";

interface OwnerRow {
  full_name: string; alias: string; email: string; mode: string;
  allow_senders: string; allow_direct: string; custom_rules: string;
  persistent: number; confirmed: number; last_send_error: string;
}

export function settingsRoutes(ctrl: Ctx): Hono {
  const app = new Hono();
  const sess = async (ctx: import("hono").Context) => (ctrl.cfg.mode === "local" ? null : await getSession(ctrl, ctx));
  // In local/private the operator IS the single user; in cloud only admins may
  // change instance-wide things (branding, relay tunables).
  const canInstance = (id: number | null) => ctrl.cfg.mode !== "cloud" || isAdmin(ctrl, id);
  const scoped = (id: number | null) => tenantCtx(ctrl, id);

  app.get("/settings", async (ctx) => {
    if (ctrl.cfg.mode !== "local" && (await sess(ctx)) == null) return ctx.redirect("/login");
    const id = await sess(ctx);
    const c = scoped(id);
    const brand = getBrand();
    const email = accountEmail(ctrl, id);
    const toast = ctx.req.query("saved") ? "Saved." : "";

    // ── appearance ─────────────────────────────────────────────────────────
    const swatches = ["#2563eb", "#4f46e5", "#0ea5a4", "#0284c7", "#7c3aed", "#e11d48", "#ea580c", "#059669"];
    const fontCards = FONT_SETS.map((f) => `
      <label><input type="radio" name="font" value="${f.key}"${brand.font === f.key ? " checked" : ""}>
        <span class="fs"><b style="font-family:${f.display || f.sans}">${esc(f.label)}</b><span class="note">${esc(f.note)}</span></span></label>`).join("");
    const appearance = canInstance(id) ? `
      <div class="card"><h2>${icon("spark", 16)} Appearance</h2>
        <p class="hint" style="margin:0 0 4px">Name, accent colour and typeface for this instance. Applies everywhere, immediately.</p>
        <form method="post" action="/settings/brand">
          <label>Instance name</label><input name="brand_name" value="${esc(brand.name)}" maxlength="40">
          <label>Accent colour</label>
          <div class="row">
            <input type="color" name="accent" id="accent" value="${esc(brand.accent)}" style="width:56px;height:42px;padding:4px">
            <input type="text" name="accent_hex" id="accent_hex" value="${esc(brand.accent)}" pattern="#[0-9a-fA-F]{6}" style="width:130px;font-family:var(--mono)">
            <span class="row" id="swatches" style="gap:6px">${swatches.map((h) => `<button type="button" class="sw" data-h="${h}" title="${h}" style="width:24px;height:24px;border-radius:7px;border:1px solid var(--rule);background:${h};cursor:pointer"></button>`).join("")}</span>
          </div>
          <label>Typeface</label><div class="fontpick">${fontCards}</div>
          <button class="btn" style="margin-top:18px">${icon("check", 15)}Save appearance</button>
        </form>
        <script>(function(){var c=document.getElementById('accent'),h=document.getElementById('accent_hex');
          c.addEventListener('input',function(){h.value=c.value;});
          h.addEventListener('input',function(){if(/^#[0-9a-fA-F]{6}$/.test(h.value))c.value=h.value;});
          document.querySelectorAll('#swatches .sw').forEach(function(b){b.addEventListener('click',function(){c.value=b.dataset.h;h.value=b.dataset.h;});});})();</script>
      </div>` : "";

    // ── owner mailbox (the same thing agents configure over the connector) ──
    const o = c.db.prepare("SELECT * FROM owner_mailbox WHERE id=1").get() as OwnerRow | undefined;
    const modeOpts = Object.entries(OWNER_MODES).map(([k, m]) =>
      `<option value="${k}"${o?.mode === k ? " selected" : ""}>${esc(k)} — ${esc(m.label)}</option>`).join("");
    const ownerCard = `
      <div class="card"><h2>${icon("mail", 16)} Owner mailbox</h2>
        <p class="hint" style="margin:0 0 4px">Where team mail addressed to you is delivered as real email, and the rules the relay enforces on who may reach you. Sessions can set this too — this is the same setting.</p>
        ${o?.last_send_error ? `<p class="err">Last delivery failed: ${esc(o.last_send_error)}</p>` : ""}
        <form method="post" action="/settings/owner">
          <div class="row" style="gap:12px">
            <div class="grow"><label>Your name</label><input name="full_name" value="${esc(o?.full_name || "")}" placeholder="Ada Lovelace"></div>
            <div class="grow"><label>Short name</label><input name="alias" value="${esc(o?.alias || "")}" placeholder="Ada"></div>
          </div>
          <label>Email</label><input name="email" type="email" value="${esc(o?.email || "")}" placeholder="you@example.com">
          <label>Contact mode</label><select name="mode">${modeOpts}</select>
          <label>Custom rules <span class="muted small">(mode d)</span></label>
          <textarea name="custom_rules" rows="3" placeholder="Describe exactly who may mail you and when.">${esc(o?.custom_rules || "")}</textarea>
          <div class="row" style="margin-top:14px;gap:10px">
            <button class="btn">${icon("check", 15)}Save owner mailbox</button>
            ${o && !o.confirmed ? `<button class="btn ghost" name="confirm" value="1">I received the test email — confirm</button>` : ""}
            ${o?.confirmed ? `<span class="chip good">${icon("check", 12)}confirmed</span>` : `<span class="chip warn">not confirmed</span>`}
          </div>
        </form>
      </div>`;

    // ── relay behaviour ────────────────────────────────────────────────────
    const groups = ["limits", "timers", "team"] as const;
    const tunableCards = canInstance(id) ? `
      <div class="card"><h2>${icon("settings", 16)} Relay behaviour</h2>
        <p class="hint" style="margin:0 0 4px">Defaults every session is held to. Changes apply immediately — no restart.</p>
        <form method="post" action="/settings/tunables">
          ${groups.map((g) => `
            <h3 style="font:600 12px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin:20px 0 2px">${esc(GROUP_LABEL[g])}</h3>
            ${TUNABLES.filter((t) => t.group === g).map((t) => `
              <div class="row" style="gap:14px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--rule-2)">
                <div class="grow"><div style="font-weight:600;font-size:14px">${esc(t.label)}${t.unit ? ` <span class="muted small">(${esc(t.unit)})</span>` : ""}</div>
                  <div class="small muted">${esc(t.hint)}</div></div>
                <input type="number" name="${esc(t.key)}" value="${t.get(ctrl.cfg)}" min="${t.min}" max="${t.max}" style="width:120px">
              </div>`).join("")}`).join("")}
          <div class="row" style="gap:14px;align-items:flex-start;padding:10px 0">
            <div class="grow"><div style="font-weight:600;font-size:14px">Default owner contact mode</div>
              <div class="small muted">Applied to a new team's owner mailbox.</div></div>
            <select name="team.default_owner_mode" style="width:220px">${Object.entries(OWNER_MODES).map(([k, m]) => `<option value="${k}"${ctrl.cfg.team.default_owner_mode === k ? " selected" : ""}>${esc(k)} — ${esc(m.label)}</option>`).join("")}</select>
          </div>
          <button class="btn" style="margin-top:16px">${icon("check", 15)}Save behaviour</button>
        </form>
      </div>` : "";

    const themeCard = `
      <div class="card"><h2>${icon("sun", 16)} Theme</h2>
        <p class="hint" style="margin:0 0 10px">Light or dark follows your system. Override for this browser:</p>
        <button class="btn ghost" type="button" onclick="__toggleTheme()">${icon("moon", 15)}Toggle light / dark</button></div>`;

    const accountCard = (id != null && id >= 1) ? `
      <div class="card danger-zone"><h2>${icon("trash", 16)} Delete account</h2>
        <p class="hint" style="margin:0 0 10px">Permanently deletes <b>${esc(email)}</b> and ${ctrl.cfg.mode === "cloud" ? "your entire isolated crew (teams, mail, tasks)" : "your account"}. This cannot be undone.</p>
        <form method="post" action="/settings/account/delete" onsubmit="return confirm('Delete your account and all its data? This cannot be undone.')">
          <label>Type your email to confirm</label><input name="confirm" placeholder="${esc(email)}" autocomplete="off" style="max-width:320px">
          <button class="btn danger" style="margin-top:14px">${icon("trash", 15)}Delete my account</button>
        </form></div>` : "";

    const body = appearance + ownerCard + tunableCards + themeCard + accountCard;
    return ctx.html(appShell({ title: "Settings", nav: navFor("settings", isAdmin(ctrl, id)), body, account: email, toast }));
  });

  app.post("/settings/brand", async (ctx) => {
    const id = await sess(ctx);
    if (ctrl.cfg.mode !== "local" && id == null) return ctx.redirect("/login");
    if (!canInstance(id)) return ctx.redirect("/settings");
    const b = await ctx.req.parseBody();
    setBrand(ctrl, { name: String(b.brand_name || ""), accent: String(b.accent_hex || b.accent || "").trim(), font: String(b.font || "") });
    return ctx.redirect("/settings?saved=1");
  });

  app.post("/settings/owner", async (ctx) => {
    const id = await sess(ctx);
    if (ctrl.cfg.mode !== "local" && id == null) return ctx.redirect("/login");
    const c = scoped(id);
    const b = await ctx.req.parseBody();
    if (b.confirm) { confirmOwner(c, true); return ctx.redirect("/settings?saved=1"); }
    const name = String(b.full_name || "").trim(), email = String(b.email || "").trim();
    if (name && email) await setupOwner(c, name, String(b.alias || "").trim(), email);
    const mode = String(b.mode || "a");
    setOwnerMode(c, mode, String(b.custom_rules || ""));
    return ctx.redirect("/settings?saved=1");
  });

  app.post("/settings/tunables", async (ctx) => {
    const id = await sess(ctx);
    if (ctrl.cfg.mode !== "local" && id == null) return ctx.redirect("/login");
    if (!canInstance(id)) return ctx.redirect("/settings");
    const b = await ctx.req.parseBody();
    saveTunables(ctrl, b as Record<string, unknown>);
    return ctx.redirect("/settings?saved=1");
  });

  app.post("/settings/account/delete", async (ctx) => {
    const id = await sess(ctx);
    if (id == null || id < 1) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    const email = accountEmail(ctrl, id);
    if (String(b.confirm || "").trim().toLowerCase() !== email.toLowerCase()) return ctx.redirect("/settings");
    deleteAccount(ctrl, id);
    clearSession(ctx);
    return ctx.redirect("/login");
  });

  return app;
}
