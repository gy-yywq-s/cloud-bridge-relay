// Admin console (cloud). Admins see AGGREGATE activity only — how many users,
// who is active, how many teams/boxes/messages each has — never the content of
// any tenant's mail or tasks. Admins also mint and revoke invite codes.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { page, esc } from "./theme.js";
import { getSession, isAdmin } from "../auth/accounts.js";
import { createInvite, listInvites, setInviteDisabled } from "../auth/invites.js";
import { tenantDb } from "../core/tenancy.js";

interface AccountRow { id: number; email: string; display: string; is_admin: number; github_id: number | null; created_ts: string }

// Activity metrics for one tenant, read from its isolated database. Counts only —
// no message bodies, task detail, or roster content ever crosses into admin view.
function tenantMetrics(c: Ctx, accountId: number): { teams: number; boxes: number; messages: number; last_active: string | null; active_boxes: number } {
  try {
    const db = tenantDb(c, accountId);
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const teams = one("SELECT count(*) n FROM teams");
    const boxes = one("SELECT count(*) n FROM boxes WHERE is_human=0");
    const messages = one("SELECT count(*) n FROM messages");
    const last = db.prepare("SELECT max(last_seen) m FROM boxes").get() as { m: string | null };
    const dayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    const active = (db.prepare("SELECT count(*) n FROM boxes WHERE last_seen>?").get(dayAgo) as { n: number }).n;
    return { teams, boxes, messages, last_active: last?.m ?? null, active_boxes: active };
  } catch { return { teams: 0, boxes: 0, messages: 0, last_active: null, active_boxes: 0 }; }
}

const ago = (iso: string | null): string => {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function adminRoutes(c: Ctx): Hono {
  const app = new Hono();

  // Admin-only guard. Cloud mode only; other modes have no per-account admin.
  const guard = async (ctx: import("hono").Context): Promise<number | null> => {
    if (c.cfg.mode !== "cloud") return null;
    const id = await getSession(c, ctx);
    if (id == null || !isAdmin(c, id)) return null;
    return id;
  };

  app.get("/admin", async (ctx) => {
    if ((await guard(ctx)) == null) return ctx.redirect("/app");
    const accounts = c.db.prepare("SELECT id,email,display,is_admin,github_id,created_ts FROM accounts ORDER BY created_ts DESC").all() as AccountRow[];
    const dayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    let activeUsers = 0;
    const rows = accounts.map((a) => {
      const m = tenantMetrics(c, a.id);
      if (m.last_active && m.last_active > dayAgo) activeUsers++;
      const src = a.github_id ? "GitHub" : "email";
      return `<tr>
        <td>${esc(a.email)}${a.is_admin ? ` <span class="chip on">admin</span>` : ""}<div class="small muted">#${a.id} · ${src} · joined ${esc(a.created_ts.slice(0, 10))}</div></td>
        <td>${m.teams}</td><td>${m.boxes}</td><td>${m.messages}</td>
        <td>${esc(ago(m.last_active))}${m.active_boxes ? ` <span class="chip good">${m.active_boxes} live</span>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">No accounts yet.</td></tr>`;

    const invites = listInvites(c);
    const invRows = invites.map((i) => {
      const spent = i.max_uses > 0 && i.uses >= i.max_uses;
      const exp = i.expires_ts && i.expires_ts < new Date().toISOString();
      const state = i.disabled ? `<span class="chip bad">disabled</span>` : exp ? `<span class="chip warn">expired</span>` : spent ? `<span class="chip warn">used up</span>` : `<span class="chip good">active</span>`;
      const act = i.disabled
        ? `<button class="btn ghost small" name="enable" value="${esc(i.code)}">enable</button>`
        : `<button class="btn ghost small" name="disable" value="${esc(i.code)}">disable</button>`;
      return `<tr><td><code>${esc(i.code)}</code>${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ""}</td>
        <td>${i.uses}/${i.max_uses === 0 ? "∞" : i.max_uses}</td>
        <td>${i.expires_ts ? esc(ago(i.expires_ts).replace(" ago", "")) : "—"}</td>
        <td>${state}</td><td>${act}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">No invite codes yet.</td></tr>`;

    return ctx.html(page(c.cfg, "Admin", `
      <div class="row"><h1 class="grow">Admin</h1><a class="btn ghost small" href="/app">dashboard</a> <a class="btn ghost small" href="/logout">sign out</a></div>
      <div class="row" style="gap:14px;margin:8px 0 4px">
        <div class="card" style="flex:1;text-align:center"><div style="font:700 28px/1 var(--mono)">${accounts.length}</div><div class="small muted">accounts</div></div>
        <div class="card" style="flex:1;text-align:center"><div style="font:700 28px/1 var(--mono)">${activeUsers}</div><div class="small muted">active (24h)</div></div>
        <div class="card" style="flex:1;text-align:center"><div style="font:700 28px/1 var(--mono)">${invites.filter((i) => !i.disabled && !(i.max_uses > 0 && i.uses >= i.max_uses)).length}</div><div class="small muted">live invites</div></div>
      </div>
      <div class="card"><h2 style="margin-top:0">Invite codes</h2>
        <form method="post" action="/admin/invite" class="row" style="align-items:flex-end">
          <div><label style="margin-top:0">Uses (0 = ∞)</label><input name="max_uses" type="number" value="1" min="0" style="width:110px"></div>
          <div><label style="margin-top:0">Expires (days, blank = never)</label><input name="expires_days" type="number" min="1" style="width:150px"></div>
          <div class="grow"><label style="margin-top:0">Note</label><input name="note" placeholder="who / why"></div>
          <button class="btn">Generate</button>
        </form>
        <form method="post" action="/admin/invite/toggle"><table style="margin-top:12px"><thead><tr><th>Code</th><th>Uses</th><th>Expires</th><th>State</th><th></th></tr></thead><tbody>${invRows}</tbody></table></form>
      </div>
      <div class="card"><h2 style="margin-top:0">Users &amp; activity</h2>
        <p class="small muted">Aggregate counts only — message and task content stays inside each user's isolated database and is never shown here.</p>
        <table><thead><tr><th>Account</th><th>Teams</th><th>Agents</th><th>Messages</th><th>Last active</th></tr></thead><tbody>${rows}</tbody></table></div>
    `));
  });

  app.post("/admin/invite", async (ctx) => {
    const admin = await guard(ctx);
    if (admin == null) return ctx.redirect("/app");
    const b = await ctx.req.parseBody();
    createInvite(c, admin, { note: String(b.note || ""), max_uses: Number(b.max_uses) || 1, expires_days: Number(b.expires_days) || 0 });
    return ctx.redirect("/admin");
  });

  app.post("/admin/invite/toggle", async (ctx) => {
    if ((await guard(ctx)) == null) return ctx.redirect("/app");
    const b = await ctx.req.parseBody();
    if (b.disable) setInviteDisabled(c, String(b.disable), true);
    if (b.enable) setInviteDisabled(c, String(b.enable), false);
    return ctx.redirect("/admin");
  });

  return app;
}
