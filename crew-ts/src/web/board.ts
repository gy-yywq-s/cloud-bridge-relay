// The board, merged in from the separate board site: a read-only view of one
// team's task board + roster, reachable without an account by its 6-char view
// key. The key grants read access to exactly that one team and nothing else, so
// it is safe to share with a human who should watch progress.
import { Hono } from "hono";
import type { Ctx } from "../core/context.js";
import { authPage, esc, liveRefreshScript } from "./theme.js";
import { icon } from "./icons.js";
import { renderBoard, renderRoster } from "./render.js";
import { tenantCtx, listTenantIds } from "../core/tenancy.js";

// A view key belongs to a team inside one tenant's database. In cloud mode we
// look through the tenants for it; elsewhere there is a single database.
function resolve(ctrl: Ctx, key: string): { c: Ctx; code: string } | null {
  const k = String(key).trim().toLowerCase();
  if (!/^[a-f0-9]{4,12}$/.test(k)) return null;
  const find = (c: Ctx) => (c.db.prepare("SELECT code FROM teams WHERE view_key=?").get(k) as { code: string } | undefined)?.code;
  if (ctrl.cfg.mode !== "cloud") {
    const code = find(ctrl);
    return code ? { c: ctrl, code } : null;
  }
  for (const id of listTenantIds(ctrl)) {
    const c = tenantCtx(ctrl, id);
    const code = find(c);
    if (code) return { c, code };
  }
  return null;
}

export function boardRoutes(ctrl: Ctx): Hono {
  const app = new Hono();

  app.get("/b/:key", (ctx) => {
    const hit = resolve(ctrl, ctx.req.param("key"));
    if (!hit) {
      return ctx.html(authPage("Board", `<div class="card"><h1>Board not found</h1>
        <p class="muted small">That view key does not match any team. Ask the team for a fresh one — any session can produce it with <code>board_key</code>.</p></div>`), 404);
    }
    const { c, code } = hit;
    const t = c.db.prepare("SELECT name FROM teams WHERE code=?").get(code) as { name: string } | undefined;
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const body = `
      <div class="board">
        <h1 style="text-align:center">${esc(t?.name || "Team board")}</h1>
        <p class="hint" style="text-align:center;margin:0 0 18px">Read-only · as of <span data-live="stamp">${esc(stamp)}</span></p>
        <div class="card"><h2>${icon("board", 16)} Task board</h2><div data-live="board">${renderBoard(c, code, { readOnly: true })}</div></div>
        <div class="card"><h2>${icon("teams", 16)} Roster</h2><div data-live="roster">${renderRoster(c, code)}</div></div>
      </div>
      ${liveRefreshScript(c.cfg.team.board_refresh_s)}`;
    // A wide, chrome-free reading surface — no nav, nothing to click.
    return ctx.html(authPage(t?.name || "Board", `<style>.authwrap .card{max-width:none}.authwrap{justify-content:flex-start;padding-top:34px}.board{width:100%;max-width:820px}</style>${body}`));
  });

  return app;
}
