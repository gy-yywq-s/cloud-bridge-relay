// Human dashboard inside the sidebar app shell. In cloud mode every query runs
// against the signed-in account's OWN tenant database (tenantCtx), so one user
// never sees another's crew.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { appShell, esc } from "./theme.js";
import { icon } from "./icons.js";
import { navFor } from "./nav.js";
import { rosterText, teamViewKey } from "../core/context.js";
import { doPool, doInitializeTeam, doSetTeamName, doSetBoxRole, fullMembers } from "../core/teams.js";
import { boardText } from "../core/tasks.js";
import { wizPending } from "../core/wizard.js";
import { getSession, isAdmin } from "../auth/accounts.js";
import { tenantCtx } from "../core/tenancy.js";

export function accountEmail(ctrl: Ctx, id: number | null): string {
  if (id == null) return "";
  if (id < 0) return "deployer";
  const r = ctrl.db.prepare("SELECT email FROM accounts WHERE id=?").get(id) as { email: string } | undefined;
  return r?.email || "";
}

export function dashboardRoutes(ctrl: Ctx): Hono {
  const app = new Hono();
  // Tenant-scoped Ctx + the signed-in accountId (null in local mode).
  const scope = async (ctx: import("hono").Context): Promise<{ c: Ctx; id: number | null } | null> => {
    if (ctrl.cfg.mode === "local") return { c: ctrl, id: null };
    const id = await getSession(ctrl, ctx);
    if (id == null) return null;
    return { c: tenantCtx(ctrl, id), id };
  };
  const H = (id: number | null, active: string, title: string, body: string, actions = "") =>
    appShell({ title, nav: navFor(active, isAdmin(ctrl, id)), body, account: accountEmail(ctrl, id), actions });

  app.get("/app", async (ctx) => {
    const s = await scope(ctx);
    if (!s) return ctx.redirect("/login");
    const { c, id } = s;
    const teams = c.db.prepare("SELECT code,name,rv FROM teams ORDER BY created_ts DESC").all() as { code: string; name: string; rv: number }[];
    const pools = c.db.prepare("SELECT DISTINCT pool_code FROM boxes WHERE status='waiting' AND pool_code IS NOT NULL").all() as { pool_code: string }[];
    const boxes = c.db.prepare("SELECT * FROM boxes WHERE box NOT LIKE '__meta%' ORDER BY last_seen DESC").all() as never[];
    const agents = (boxes as { is_human: number }[]).filter((b) => !b.is_human).length;

    const teamRows = teams.map((t) => {
      const n = (c.db.prepare("SELECT count(*) c FROM boxes WHERE team_code=?").get(t.code) as { c: number }).c;
      const setup = wizPending(c, t.code) ? `<span class="chip warn">setup pending</span>` : `<span class="chip good">${icon("check", 12)}ready</span>`;
      return `<tr><td><a href="/app/team/${esc(t.code)}"><b>${esc(t.name || "(unnamed)")}</b></a><div class="small muted">${esc(t.code)}</div></td><td>${n}</td><td>${setup}</td></tr>`;
    }).join("") || `<tr><td colspan="3" class="empty">No teams yet.</td></tr>`;

    const poolRows = pools.map((p) => {
      const d = doPool(c, p.pool_code);
      return `<tr><td><b>${esc(p.pool_code)}</b></td><td>${d.waiting_count}</td>
        <td class="small muted">${(d.waiting || []).map((w) => esc(w.session_name || w.box)).join(", ")}</td>
        <td style="text-align:right"><form method="post" action="/app/pool/${esc(p.pool_code)}/init" onsubmit="return confirm('Initialize a team from pool ${esc(p.pool_code)}?')">
          <input type="hidden" name="coordinator" value="${esc(d.waiting?.[0]?.box || "")}">
          <button class="btn sm ghost">${icon("spark", 14)}Initialize</button></form></td></tr>`;
    }).join("") || `<tr><td colspan="4" class="empty">No sessions waiting.</td></tr>`;

    const boxRows = (boxes as { box: string; session_name: string; platform: string; is_human: number; role: string; status: string; team_code: string | null; stale: number }[]).map((b) => {
      const kind = b.is_human ? "human" : b.platform || "?";
      const st = b.stale ? `<span class="chip bad">stale</span>` : `<span class="chip on">${esc(b.status)}</span>`;
      return `<tr><td>${esc(b.session_name || b.box)}<div class="small muted">${esc(b.box)}</div></td><td>${esc(kind)}</td><td>${esc(b.role || "-")}</td><td>${esc(b.team_code || "-")}</td><td>${st}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="empty">No sessions yet. Connect one from Claude Code, Codex, or claude.ai.</td></tr>`;

    // How to connect — the web half of the plugin's job. Prominent while the
    // crew is empty, collapsed once sessions exist.
    const mcpUrl = `${c.cfg.public_url || `http://${c.cfg.host}:${c.cfg.port}`}/mcp`;
    const empty = boxes.length === 0;
    const connect = `
      <details class="card"${empty ? " open" : ""}>
        <summary style="cursor:pointer;list-style:none"><h2 style="margin:0">${icon("link", 16)} Connect a session${empty ? "" : ` <span class="muted small" style="font-weight:400">— MCP URL and commands</span>`}</h2></summary>
        <p class="hint" style="margin:10px 0">Point Claude Code, Codex or claude.ai at this relay, then run <code>/crew:onboard &lt;pool&gt;</code> in each session. The first connection opens a browser to sign in.</p>
        <div class="row"><code class="grow" style="overflow-x:auto">${esc(mcpUrl)}</code>
          <button type="button" class="copy" data-copy="${esc(mcpUrl)}">${icon("copy", 13)}copy</button></div>
        <div class="row" style="margin-top:12px;gap:8px">
          <button type="button" class="copy" data-copy="/plugin marketplace add gy-yywq-s/cloud-bridge-relay">${icon("copy", 13)}plugin install</button>
          <button type="button" class="copy" data-copy="/crew:onboard 1234">${icon("copy", 13)}/crew:onboard 1234</button>
          <button type="button" class="copy" data-copy="/crew:setup 1234">${icon("copy", 13)}/crew:setup 1234</button>
        </div>
      </details>`;

    const body = `${connect}
      <div class="row" style="gap:14px;margin-bottom:18px">
        <div class="card stat">${icon("teams", 20)}<b>${teams.length}</b><span class="muted small">teams</span></div>
        <div class="card stat">${icon("dashboard", 20)}<b>${agents}</b><span class="muted small">agents</span></div>
        <div class="card stat">${icon("pool", 20)}<b>${pools.length}</b><span class="muted small">waiting pools</span></div>
      </div>
      <div class="card"><h2>${icon("teams", 16)} Teams</h2><table><thead><tr><th>Team</th><th>Members</th><th>Setup</th></tr></thead><tbody>${teamRows}</tbody></table></div>
      <div class="card"><h2>${icon("pool", 16)} Waiting pools</h2><table><thead><tr><th>Pool</th><th>Waiting</th><th>Sessions</th><th></th></tr></thead><tbody>${poolRows}</tbody></table></div>
      <div class="card"><h2>${icon("dashboard", 16)} Sessions</h2><table><thead><tr><th>Session</th><th>Platform</th><th>Role</th><th>Team</th><th>Status</th></tr></thead><tbody>${boxRows}</tbody></table></div>`;
    return ctx.html(H(id, "app", "Dashboard", body));
  });

  app.get("/app/team/:code", async (ctx) => {
    const s = await scope(ctx);
    if (!s) return ctx.redirect("/login");
    const { c, id } = s;
    const code = ctx.req.param("code");
    if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return ctx.notFound();
    const members = fullMembers(c, code);
    const roleForm = members.filter((m) => m.box !== "owner").map((m) =>
      `<tr><td>#${m.member_no} ${esc(m.display_name)}<div class="small muted">${esc(m.platform)} · ${esc(m.environment || "")}</div></td>
       <td>${["manager", "worker"].map((r) => `<button class="btn sm ${m.role === r ? "" : "ghost"}" formaction="/app/team/${esc(code)}/role" name="set" value="${m.member_no}:${r}">${r}</button>`).join(" ")}</td>
       <td>${m.pending_mail ? `<span class="chip">${m.pending_mail} unread</span>` : ""}${m.stale ? `<span class="chip bad">stale</span>` : ""}</td></tr>`).join("");
    const t = c.db.prepare("SELECT name FROM teams WHERE code=?").get(code) as { name: string };
    const key = teamViewKey(c, code);
    const base = c.cfg.public_url || `http://${c.cfg.host}:${c.cfg.port}`;
    const shareUrl = `${base}/b/${key || ""}`;
    const body = `
      <p class="crumb"><a href="/app">Dashboard</a> ${icon("chevron", 13)} ${esc(t.name || code)}</p>
      <div class="card"><h2>${icon("settings", 16)} Team name</h2>
        <form method="post" action="/app/team/${esc(code)}/name" class="row">
          <div class="grow"><input name="name" value="${esc(t.name)}" placeholder="Team name"></div>
          <button class="btn">Rename</button></form></div>
      <div class="card"><h2>${icon("teams", 16)} Members &amp; roles</h2>
        <form method="post"><table><tbody>${roleForm || `<tr><td class="empty">No members yet.</td></tr>`}</tbody></table></form>
        <p class="hint">Workers can never mail the owner; that is enforced server-side.</p></div>
      <div class="card"><h2>${icon("board", 16)} Task board</h2><pre id="board">${esc(boardText(c, code))}</pre></div>
      <div class="card"><h2>${icon("user", 16)} Roster</h2><pre>${esc(rosterText(c, code))}</pre></div>
      <div class="card"><h2>${icon("link", 16)} Share this board</h2>
        <p class="hint" style="margin:0 0 10px">A read-only link to this team's board and roster — no account needed. Safe to give someone who should watch progress.</p>
        <div class="row"><code class="grow" style="overflow-x:auto">${esc(shareUrl)}</code>
          <button type="button" class="copy" data-copy="${esc(shareUrl)}">${icon("copy", 13)}copy</button>
          <a class="btn sm ghost" href="/b/${esc(key || "")}" target="_blank" rel="noopener">open</a></div></div>
      <script>setTimeout(()=>location.reload(), ${c.cfg.team.board_refresh_s * 1000});</script>`;
    return ctx.html(H(id, "app", t.name || "Team", body));
  });

  app.post("/app/pool/:code/init", async (ctx) => {
    const s = await scope(ctx);
    if (!s) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    const r = doInitializeTeam(s.c, ctx.req.param("code"), String(b.coordinator || ""));
    return ctx.redirect("error" in r ? "/app" : `/app/team/${(r as { team_code: string }).team_code}`);
  });
  app.post("/app/team/:code/name", async (ctx) => {
    const s = await scope(ctx);
    if (!s) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    doSetTeamName(s.c, ctx.req.param("code"), String(b.name || ""));
    return ctx.redirect(`/app/team/${ctx.req.param("code")}`);
  });
  app.post("/app/team/:code/role", async (ctx) => {
    const s = await scope(ctx);
    if (!s) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    const [no, role] = String(b.set || "").split(":");
    if (no && role) doSetBoxRole(s.c, ctx.req.param("code"), Number(no), role);
    return ctx.redirect(`/app/team/${ctx.req.param("code")}`);
  });

  return app;
}
