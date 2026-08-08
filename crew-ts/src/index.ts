// Entry point: load config, open db, build the MCP server + Hono app
// (MCP transport + REST mirror + health), start the sweeps, listen.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeEmail } from "./core/email.js";
import type { Ctx } from "./core/context.js";
import { resolveViewKey, rosterText } from "./core/context.js";
import { startSweeps } from "./core/sweeps.js";
import { buildMcpServer } from "./mcp/server.js";
import {
  doRegister, doPool, doInitializeTeam, doJoinTeam, doSetTeamName,
  doSetMemberAlias, doSetBoxRole, doBoxes, teamRoster,
} from "./core/teams.js";
import { renderTemplate, doSend, mailTaskHook, doPoll, fetchBox, doAck, boardReminder, doThread, doHistory } from "./core/mail.js";
import { doTaskAdd, doTaskClaim, doTaskProgress, doTaskDone, boardText } from "./core/tasks.js";
import { setupOwner, confirmOwner, setOwnerMode, attachOwner } from "./core/owner.js";
import { wizQuestions, wizAnswersBatch, wizNext, setupGuard } from "./core/wizard.js";

const cfg = loadConfig();
const db = openDb(cfg);
const ctx: Ctx = { db, cfg, email: makeEmail(cfg) };
startSweeps(ctx);

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, mode: cfg.mode, brand: cfg.brand.name }));

// ── MCP endpoint (stateless per request) ──────────────────────────────────
app.all("/mcp", async (c) => {
  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// ── REST mirror (parity with the MCP tools; used by web UI, watchers, tests) ─
const jz = (c: import("hono").Context, o: unknown) =>
  c.json(o as object, (o as { error?: string })?.error ? 400 : 200);

app.post("/register", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doRegister(ctx, p.box_id ?? p.box ?? "", p.session_name ?? "", p.platform ?? "", p.environment ?? "", p.pool_code ?? "", p.role ?? "", !!p.override_name)); });
app.get("/pool", (c) => jz(c, doPool(ctx, c.req.query("code") ?? "")));
app.post("/team/create", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doInitializeTeam(ctx, p.pool_code ?? p.code ?? "", p.coordinator_box ?? "")); });
app.post("/team/join", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doJoinTeam(ctx, p.code ?? "", p.box ?? "")); });
app.post("/team/name", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(ctx, p.code ?? "") ?? doSetTeamName(ctx, p.code ?? "", p.name ?? "")); });
app.post("/team/alias", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(ctx, p.code ?? "") ?? doSetMemberAlias(ctx, p.code ?? "", Number(p.member_no), p.alias ?? "", !!p.override_name)); });
app.post("/team/role", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(ctx, p.code ?? "") ?? doSetBoxRole(ctx, p.code ?? "", Number(p.member_no), p.role ?? "")); });
app.post("/team/attach-owner", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(ctx, p.code ?? "") ?? attachOwner(ctx, p.code ?? "")); });
app.get("/team", (c) => jz(c, teamRoster(ctx, c.req.query("code") ?? "", c.req.query("view") === "full" ? "full" : "brief")));
app.post("/setup/questions", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, wizQuestions(ctx, p.code ?? "", !!p.restart)); });
app.post("/setup/answers", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, wizAnswersBatch(ctx, p.code ?? "", p.answers)); });
app.post("/setup/next", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, wizNext(ctx, p.code ?? "", !!p.restart)); });

app.post("/send", async (c) => {
  const p = await c.req.json().catch(() => ({}));
  const [rendered, terr] = renderTemplate(ctx, p.template ?? "note", p.fields ?? {}, p.body ?? "");
  if (terr) return jz(c, terr);
  const [res, err] = doSend(ctx, p.from ?? "", p.to, p.cc, rendered!, { fallbackAlias: p.alias ?? "", ownerJustification: p.owner_justification ?? "", dedupKey: p.dedup_key ?? "", replyTo: p.reply_to ?? null });
  if (err) return jz(c, err);
  return c.json({ ...res, ...mailTaskHook(ctx, p.from ?? "", (p.to ?? []) as string[], p.template ?? "note", p.fields ?? {}) });
});
app.get("/poll", async (c) => { const box = c.req.query("box") ?? ""; if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box)) return jz(c, { error: "bad_box" }); const msgs = await doPoll(ctx, box, Number(c.req.query("wait") ?? 25), true); return c.json({ messages: msgs }); });
app.get("/checkmail", async (c) => { const box = c.req.query("box") ?? ""; if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box)) return jz(c, { error: "bad_box" }); const at = Number(c.req.query("ack_through") ?? 0); if (at) doAck(ctx, box, at); const msgs = await doPoll(ctx, box, Number(c.req.query("wait") ?? 25), false); const rem = boardReminder(ctx, box); if (rem) msgs.push(rem); return c.json({ messages: msgs }); });
app.post("/ack", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doAck(ctx, p.box ?? "", p.through_id)); });
app.get("/peek", (c) => { const box = c.req.query("box") ?? ""; return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(box) ? c.json({ messages: fetchBox(ctx, box, false) }) : jz(c, { error: "bad_box" }); });
app.get("/thread", (c) => jz(c, doThread(ctx, c.req.query("id") ?? "")));
app.get("/history", (c) => { const box = c.req.query("box") ?? ""; return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(box) ? c.json(doHistory(ctx, box, Number(c.req.query("limit") ?? 50))) : jz(c, { error: "bad_box" }); });
app.get("/boxes", (c) => c.json({ boxes: doBoxes(ctx) }));

app.post("/task/add", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doTaskAdd(ctx, p.team ?? "", p.title ?? "", p.detail ?? "", p.created_by ?? "", p.deps ?? null, p.assign_to ?? "", p.priority ?? 2, p.discovered_from ?? null)); });
app.post("/task/claim", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doTaskClaim(ctx, Number(p.task_id), p.box ?? "")); });
app.post("/task/progress", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doTaskProgress(ctx, Number(p.task_id), p.box ?? "", p.note ?? "")); });
app.post("/task/done", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, doTaskDone(ctx, Number(p.task_id), p.box ?? "", p.result ?? "")); });
app.get("/tasks", (c) => { const team = c.req.query("team") ?? ""; if (!ctx.db.prepare("SELECT 1 FROM teams WHERE code=?").get(team)) return jz(c, { error: "no_such_team" }); return c.json({ team, board: boardText(ctx, team), roster: rosterText(ctx, team) }); });

app.post("/owner/setup", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, await setupOwner(ctx, p.full_name ?? "", p.alias ?? "", p.email ?? "")); });
app.post("/owner/confirm", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, confirmOwner(ctx, !!p.override)); });
app.post("/owner/mode", async (c) => { const p = await c.req.json().catch(() => ({})); return jz(c, setOwnerMode(ctx, p.mode ?? "", p.custom_rules ?? "", p.allow_senders ?? "", p.allow_direct ?? "", p.persistent ?? null)); });

app.get("/viewkey", (c) => { const code = resolveViewKey(ctx, c.req.query("key") ?? ""); return code ? c.json({ team: code }) : jz(c, { error: "bad_key" }); });

const host = cfg.host;
const port = cfg.port;
serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`crew-relay [${cfg.mode}] on ${host}:${info.port}`);
});
