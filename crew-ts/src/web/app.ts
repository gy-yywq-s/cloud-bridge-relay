// Human dashboard: see status (teams, pools, boxes, boards) and run team/pool
// operations (initialize, rename, roles, board view). Everything except
// registration is available here. Session-guarded in private/cloud.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { page, esc } from "./theme.js";
import { rosterText, boxRow } from "../core/context.js";
import { doPool, doInitializeTeam, doSetTeamName, doSetBoxRole, teamRoster, fullMembers } from "../core/teams.js";
import { boardText } from "../core/tasks.js";
import { wizPending } from "../core/wizard.js";
import { getSession } from "../auth/accounts.js";

export function dashboardRoutes(c: Ctx): Hono {
  const app = new Hono();
  const guard = async (ctx: import("hono").Context): Promise<boolean> => {
    if (c.cfg.mode === "local") return true;
    return (await getSession(c, ctx)) != null;
  };

  app.get("/app", async (ctx) => {
    if (!(await guard(ctx))) return ctx.redirect("/login");
    const teams = c.db.prepare("SELECT code,name,rv FROM teams ORDER BY created_ts DESC").all() as { code: string; name: string; rv: number }[];
    const pools = c.db.prepare("SELECT DISTINCT pool_code FROM boxes WHERE status='waiting' AND pool_code IS NOT NULL").all() as { pool_code: string }[];
    const boxes = c.db.prepare("SELECT * FROM boxes WHERE box NOT LIKE '__meta%' ORDER BY last_seen DESC").all() as never[];

    const teamRows = teams.map((t) => {
      const n = (c.db.prepare("SELECT count(*) c FROM boxes WHERE team_code=?").get(t.code) as { c: number }).c;
      const setup = wizPending(c, t.code) ? `<span class="chip warn">setup pending</span>` : `<span class="chip good">ready</span>`;
      return `<tr><td><a href="/app/team/${esc(t.code)}"><b>${esc(t.name || "(unnamed)")}</b></a><div class="small muted">${esc(t.code)}</div></td><td>${n}</td><td>${setup}</td></tr>`;
    }).join("") || `<tr><td colspan="3" class="muted">No teams yet.</td></tr>`;

    const poolRows = pools.map((p) => {
      const d = doPool(c, p.pool_code);
      return `<tr><td><b>${esc(p.pool_code)}</b></td><td>${d.waiting_count}</td>
        <td class="small muted">${(d.waiting || []).map((w) => esc(w.session_name || w.box)).join(", ")}</td>
        <td><form method="post" action="/app/pool/${esc(p.pool_code)}/init" onsubmit="return confirm('Initialize team from pool ${esc(p.pool_code)}?')">
          <input type="hidden" name="coordinator" value="${esc(d.waiting?.[0]?.box || "")}">
          <button class="btn ghost small">Initialize</button></form></td></tr>`;
    }).join("") || `<tr><td colspan="4" class="muted">No one waiting.</td></tr>`;

    const boxRows = (boxes as { box: string; session_name: string; platform: string; is_human: number; role: string; status: string; team_code: string | null; stale: number; last_seen: string }[]).map((b) => {
      const kind = b.is_human ? "human" : b.platform || "?";
      const st = b.stale ? `<span class="chip bad">stale</span>` : `<span class="chip on">${esc(b.status)}</span>`;
      return `<tr><td>${esc(b.session_name || b.box)}<div class="small muted">${esc(b.box)}</div></td><td>${esc(kind)}</td><td>${esc(b.role || "-")}</td><td>${esc(b.team_code || "-")}</td><td>${st}</td></tr>`;
    }).join("") || `<tr><td colspan="5" class="muted">No sessions yet.</td></tr>`;

    return ctx.html(page(c.cfg, "Dashboard", `
      <h1>Dashboard</h1>
      <p class="muted small">Live view of your crew. Registration happens from the sessions themselves; everything else you can drive here.</p>
      <div class="card"><h2 style="margin-top:0">Teams</h2><table><thead><tr><th>Team</th><th>Members</th><th>Setup</th></tr></thead><tbody>${teamRows}</tbody></table></div>
      <div class="card"><h2 style="margin-top:0">Waiting pools</h2><table><thead><tr><th>Pool</th><th>Waiting</th><th>Sessions</th><th></th></tr></thead><tbody>${poolRows}</tbody></table></div>
      <div class="card"><h2 style="margin-top:0">Sessions</h2><table><thead><tr><th>Session</th><th>Platform</th><th>Role</th><th>Team</th><th>Status</th></tr></thead><tbody>${boxRows}</tbody></table></div>
    `));
  });

  app.get("/app/team/:code", async (ctx) => {
    if (!(await guard(ctx))) return ctx.redirect("/login");
    const code = ctx.req.param("code");
    if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return ctx.notFound();
    const members = fullMembers(c, code);
    const roleForm = members.filter((m) => m.box !== "owner").map((m) =>
      `<tr><td>#${m.member_no} ${esc(m.display_name)}<div class="small muted">${esc(m.platform)} · ${esc(m.environment || "")}</div></td>
       <td>${["manager", "worker"].map((r) => `<button class="btn ${m.role === r ? "" : "ghost"} small" formaction="/app/team/${esc(code)}/role" name="set" value="${m.member_no}:${r}">${r}</button>`).join(" ")}</td>
       <td>${m.pending_mail ? `<span class="chip">${m.pending_mail} unread</span>` : ""}${m.stale ? `<span class="chip bad">stale</span>` : ""}</td></tr>`).join("");
    const t = c.db.prepare("SELECT name FROM teams WHERE code=?").get(code) as { name: string };
    return ctx.html(page(c.cfg, "Team", `
      <p><a href="/app">← dashboard</a></p>
      <h1>${esc(t.name || "(unnamed)")}</h1><p class="muted small">${esc(code)}</p>
      <div class="card"><form method="post" action="/app/team/${esc(code)}/name" class="row">
        <div class="grow"><label style="margin-top:0">Team name</label><input name="name" value="${esc(t.name)}"></div>
        <button class="btn" style="margin-top:22px">Rename</button></form></div>
      <div class="card"><h2 style="margin-top:0">Members &amp; roles</h2>
        <form method="post"><table><tbody>${roleForm}</tbody></table></form>
        <p class="small muted">Workers can never mail the owner; that is enforced server-side.</p></div>
      <div class="card"><h2 style="margin-top:0">Task board</h2><pre id="board">${esc(boardText(c, code))}</pre></div>
      <div class="card"><h2 style="margin-top:0">Roster</h2><pre>${esc(rosterText(c, code))}</pre></div>
      <script>setTimeout(()=>location.reload(), ${c.cfg.team.board_refresh_s * 1000});</script>
    `));
  });

  app.post("/app/pool/:code/init", async (ctx) => {
    if (!(await guard(ctx))) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    const r = doInitializeTeam(c, ctx.req.param("code"), String(b.coordinator || ""));
    return ctx.redirect("error" in r ? "/app" : `/app/team/${(r as { team_code: string }).team_code}`);
  });
  app.post("/app/team/:code/name", async (ctx) => {
    if (!(await guard(ctx))) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    doSetTeamName(c, ctx.req.param("code"), String(b.name || ""));
    return ctx.redirect(`/app/team/${ctx.req.param("code")}`);
  });
  app.post("/app/team/:code/role", async (ctx) => {
    if (!(await guard(ctx))) return ctx.redirect("/login");
    const b = await ctx.req.parseBody();
    const [no, role] = String(b.set || "").split(":");
    if (no && role) doSetBoxRole(c, ctx.req.param("code"), Number(no), role);
    return ctx.redirect(`/app/team/${ctx.req.param("code")}`);
  });

  return app;
}
