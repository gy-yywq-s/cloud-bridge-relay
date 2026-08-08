// Settings: UI-driven instance config (brand name + swappable accent colour) and
// account management (delete). Brand editing is for admins (or the private-mode
// operator); account deletion is self-service.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { appShell, esc } from "./theme.js";
import { icon } from "./icons.js";
import { navFor } from "./nav.js";
import { getBrand, setBrand } from "./brand.js";
import { getSession, isAdmin, clearSession, deleteAccount } from "../auth/accounts.js";
import { accountEmail } from "./app.js";

export function settingsRoutes(ctrl: Ctx): Hono {
  const app = new Hono();
  const sess = async (ctx: import("hono").Context) => (ctrl.cfg.mode === "local" ? null : await getSession(ctrl, ctx));
  const canBrand = (id: number | null) => ctrl.cfg.mode === "private" || isAdmin(ctrl, id);

  app.get("/settings", async (ctx) => {
    if (ctrl.cfg.mode !== "local") { if ((await sess(ctx)) == null) return ctx.redirect("/login"); }
    const id = await sess(ctx);
    const brand = getBrand();
    const email = accountEmail(ctrl, id);
    const swatches = ["#2563eb", "#4f46e5", "#0ea5a4", "#0284c7", "#7c3aed", "#e11d48", "#ea580c", "#059669"];
    const brandCard = canBrand(id) ? `
      <div class="card"><h2>${icon("spark", 16)} Appearance</h2>
        <p class="hint" style="margin:0 0 8px">Recolour and rename the whole instance. Applies everywhere, immediately.</p>
        <form method="post" action="/settings/brand">
          <label>Instance name</label><input name="brand_name" value="${esc(brand.name)}" maxlength="40">
          <label>Accent colour</label>
          <div class="row">
            <input type="color" name="accent" id="accent" value="${esc(brand.accent)}" style="width:56px;height:42px;padding:4px">
            <input type="text" name="accent_hex" id="accent_hex" value="${esc(brand.accent)}" pattern="#[0-9a-fA-F]{6}" style="width:130px;font-family:var(--mono)">
            <span class="row" id="swatches" style="gap:6px">${swatches.map((h) => `<button type="button" class="sw" data-h="${h}" title="${h}" style="width:24px;height:24px;border-radius:7px;border:1px solid var(--rule);background:${h};cursor:pointer"></button>`).join("")}</span>
          </div>
          <button class="btn" style="margin-top:16px">Save appearance</button>
        </form>
        <script>(function(){var c=document.getElementById('accent'),h=document.getElementById('accent_hex');
          c.addEventListener('input',function(){h.value=c.value;});
          h.addEventListener('input',function(){if(/^#[0-9a-fA-F]{6}$/.test(h.value))c.value=h.value;});
          document.querySelectorAll('#swatches .sw').forEach(function(b){b.addEventListener('click',function(){c.value=b.dataset.h;h.value=b.dataset.h;});});})();</script>
      </div>` : "";

    const themeCard = `
      <div class="card"><h2>${icon("sun", 16)} Theme</h2>
        <p class="hint" style="margin:0 0 10px">Light or dark follows your system by default. Toggle for this browser:</p>
        <button class="btn ghost" type="button" onclick="__toggleTheme()">${icon("moon", 15)} Toggle light / dark</button></div>`;

    const accountCard = (id != null && id >= 1) ? `
      <div class="card danger-zone"><h2>${icon("trash", 16)} Delete account</h2>
        <p class="hint" style="margin:0 0 10px">Permanently deletes <b>${esc(email)}</b> and ${ctrl.cfg.mode === "cloud" ? "your entire isolated crew (teams, mail, tasks)" : "your account"}. This cannot be undone.</p>
        <form method="post" action="/settings/account/delete" onsubmit="return confirm('Delete your account and all its data? This cannot be undone.')">
          <label>Type your email to confirm</label><input name="confirm" placeholder="${esc(email)}" autocomplete="off" style="max-width:320px">
          <button class="btn danger" style="margin-top:14px">${icon("trash", 15)} Delete my account</button>
        </form></div>` : "";

    const body = brandCard + themeCard + accountCard || `<div class="card"><p class="empty">No settings available in this mode.</p></div>`;
    return ctx.html(appShell({ title: "Settings", nav: navFor("settings", isAdmin(ctrl, id)), body, account: email }));
  });

  app.post("/settings/brand", async (ctx) => {
    const id = await sess(ctx);
    if (ctrl.cfg.mode !== "local" && id == null) return ctx.redirect("/login");
    if (!canBrand(id)) return ctx.redirect("/settings");
    const b = await ctx.req.parseBody();
    const accent = String(b.accent_hex || b.accent || "").trim();
    setBrand(ctrl, { name: String(b.brand_name || ""), accent });
    return ctx.redirect("/settings");
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
