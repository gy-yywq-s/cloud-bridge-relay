// Admin console (cloud). Admins see AGGREGATE activity only — counts + last-active,
// never the content of any tenant's mail/tasks. Admins mint/disable invite codes
// and may delete an account.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { appShell, esc } from "./theme.js";
import { icon } from "./icons.js";
import { navFor } from "./nav.js";
import { getSession, isAdmin, deleteAccount } from "../auth/accounts.js";
import { createInvite, listInvites, setInviteDisabled } from "../auth/invites.js";
import { tenantDb } from "../core/tenancy.js";
import { accountEmail } from "./app.js";

interface AccountRow { id: number; email: string; display: string; is_admin: number; github_id: number | null; created_ts: string }

function tenantMetrics(c: Ctx, accountId: number): { teams: number; agents: number; messages: number; last_active: string | null; active: number } {
  try {
    const db = tenantDb(c, accountId);
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const last = db.prepare("SELECT max(last_seen) m FROM boxes").get() as { m: string | null };
    const dayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    return {
      teams: one("SELECT count(*) n FROM teams"),
      agents: one("SELECT count(*) n FROM boxes WHERE is_human=0"),
      messages: one("SELECT count(*) n FROM messages"),
      last_active: last?.m ?? null,
      active: (db.prepare("SELECT count(*) n FROM boxes WHERE last_seen>?").get(dayAgo) as { n: number }).n,
    };
  } catch { return { teams: 0, agents: 0, messages: 0, last_active: null, active: 0 }; }
}

const ago = (iso: string | null): string => {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function adminRoutes(ctrl: Ctx): Hono {
  const app = new Hono();
  const guard = async (ctx: import("hono").Context): Promise<number | null> => {
    if (ctrl.cfg.mode !== "cloud") return null;
    const id = await getSession(ctrl, ctx);
    if (id == null || !isAdmin(ctrl, id)) return null;
    return id;
  };

  app.get("/admin", async (ctx) => {
    const me = await guard(ctx);
    if (me == null) return ctx.redirect("/app");
    const accounts = ctrl.db.prepare("SELECT id,email,display,is_admin,github_id,created_ts FROM accounts ORDER BY created_ts DESC").all() as AccountRow[];
    const dayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    let activeUsers = 0;
    const rows = accounts.map((a) => {
      const m = tenantMetrics(ctrl, a.id);
      if (m.last_active && m.last_active > dayAgo) activeUsers++;
      const src = a.github_id ? "GitHub" : "email";
      const del = a.id === me ? "" : `<form method="post" action="/admin/user/delete" onsubmit="return confirm('Permanently delete ${esc(a.email)} and all their data? This cannot be undone.')" style="display:inline"><input type="hidden" name="id" value="${a.id}"><button class="iconbtn" title="Delete account">${icon("trash", 15)}</button></form>`;
      return `<tr>
        <td>${esc(a.email)}${a.is_admin ? ` <span class="chip on">admin</span>` : ""}<div class="small muted">#${a.id} · ${src} · joined ${esc(a.created_ts.slice(0, 10))}</div></td>
        <td>${m.teams}</td><td>${m.agents}</td><td>${m.messages}</td>
        <td>${esc(ago(m.last_active))}${m.active ? ` <span class="chip good">${m.active} live</span>` : ""}</td>
        <td style="text-align:right">${del}</td></tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">No accounts yet.</td></tr>`;

    const invites = listInvites(ctrl);
    const live = invites.filter((i) => !i.disabled && !(i.max_uses > 0 && i.uses >= i.max_uses)).length;
    const nowIso = new Date().toISOString();
    const invRows = invites.map((i) => {
      const spent = i.max_uses > 0 && i.uses >= i.max_uses;
      const exp = i.expires_ts && i.expires_ts < nowIso;
      const state = i.disabled ? `<span class="chip bad">disabled</span>` : exp ? `<span class="chip warn">expired</span>` : spent ? `<span class="chip warn">used up</span>` : `<span class="chip good">active</span>`;
      const act = i.disabled
        ? `<button class="btn sm ghost" name="enable" value="${esc(i.code)}">enable</button>`
        : `<button class="btn sm ghost" name="disable" value="${esc(i.code)}">disable</button>`;
      return `<tr><td><code>${esc(i.code)}</code>${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ""}</td>
        <td>${i.uses}/${i.max_uses === 0 ? "∞" : i.max_uses}</td>
        <td>${state}</td><td style="text-align:right">${act}</td></tr>`;
    }).join("") || `<tr><td colspan="4" class="empty">No invite codes yet — generate one to let someone register.</td></tr>`;

    const body = `
      <div class="row" style="gap:14px;margin-bottom:18px">
        <div class="card stat">${icon("user", 20)}<b>${accounts.length}</b><span class="muted small">accounts</span></div>
        <div class="card stat">${icon("activity", 20)}<b>${activeUsers}</b><span class="muted small">active · 24h</span></div>
        <div class="card stat">${icon("invite", 20)}<b>${live}</b><span class="muted small">live invites</span></div>
      </div>
      <div class="card"><h2>${icon("invite", 16)} Invite codes</h2>
        <form method="post" action="/admin/invite" class="row" style="align-items:flex-end">
          <div><label style="margin-top:0">Uses (0 = ∞)</label><input name="max_uses" type="number" value="1" min="0" style="width:104px"></div>
          <div><label style="margin-top:0">Expires (days)</label><input name="expires_days" type="number" min="1" placeholder="never" style="width:130px"></div>
          <div class="grow"><label style="margin-top:0">Note</label><input name="note" placeholder="who / why"></div>
          <button class="btn">${icon("plus", 15)}Generate</button>
        </form>
        <form method="post" action="/admin/invite/toggle"><table style="margin-top:14px"><thead><tr><th>Code</th><th>Uses</th><th>State</th><th></th></tr></thead><tbody>${invRows}</tbody></table></form>
      </div>
      <div class="card"><h2>${icon("activity", 16)} Users &amp; activity</h2>
        <p class="hint" style="margin:0 0 12px">Aggregate counts only — message and task content stays inside each user's isolated database and is never shown here.</p>
        <table><thead><tr><th>Account</th><th>Teams</th><th>Agents</th><th>Messages</th><th>Last active</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    return ctx.html(appShell({ title: "Admin", nav: navFor("admin", true), body, account: accountEmail(ctrl, me) }));
  });

  app.post("/admin/invite", async (ctx) => {
    const me = await guard(ctx);
    if (me == null) return ctx.redirect("/app");
    const b = await ctx.req.parseBody();
    createInvite(ctrl, me, { note: String(b.note || ""), max_uses: Number(b.max_uses) || 1, expires_days: Number(b.expires_days) || 0 });
    return ctx.redirect("/admin");
  });
  app.post("/admin/invite/toggle", async (ctx) => {
    if ((await guard(ctx)) == null) return ctx.redirect("/app");
    const b = await ctx.req.parseBody();
    if (b.disable) setInviteDisabled(ctrl, String(b.disable), true);
    if (b.enable) setInviteDisabled(ctrl, String(b.enable), false);
    return ctx.redirect("/admin");
  });
  app.post("/admin/user/delete", async (ctx) => {
    const me = await guard(ctx);
    if (me == null) return ctx.redirect("/app");
    const b = await ctx.req.parseBody();
    const id = Number(b.id);
    if (id && id !== me) deleteAccount(ctrl, id); // never delete self from here
    return ctx.redirect("/admin");
  });

  return app;
}
