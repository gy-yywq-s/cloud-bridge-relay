// Entry point: load config, open the control db, build the MCP server + Hono app
// (MCP transport + REST mirror + health), start the sweeps, listen.
//
// Tenancy: requireAuth resolves the caller's accountId from their bearer token and
// stores it on the request; T(ctx) then hands every handler a Ctx scoped to that
// account's database (its own file in cloud mode, the shared db otherwise). No
// handler ever touches another tenant's data because it never holds another
// tenant's Ctx.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { mcpAuthRouter } from "@hono/mcp/auth";
import { provider as makeProvider } from "./auth/store.js";
import { authRoutes } from "./auth/web.js";
import { dashboardRoutes } from "./web/app.js";
import { adminRoutes } from "./web/admin.js";
import { settingsRoutes } from "./web/settings.js";
import { boardRoutes } from "./web/board.js";
import { loadBrand } from "./web/brand.js";
import { applyConfigOverrides } from "./web/config-store.js";
import { reconcileAdmins } from "./auth/accounts.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeEmail } from "./core/email.js";
import type { Ctx } from "./core/context.js";
import { resolveViewKey, rosterText } from "./core/context.js";
import { tenantCtx, listTenantIds } from "./core/tenancy.js";
import { startSweeps } from "./core/sweeps.js";
import { buildMcpServer } from "./mcp/server.js";
import {
  doRegister, doPool, doInitializeTeam, doJoinTeam, doSetTeamName,
  doSetMemberAlias, doSetBoxRole, doBoxes, teamRoster, doAddMember,
} from "./core/teams.js";
import { renderTemplate, doSend, mailTaskHook, doPoll, fetchBox, doAck, boardReminder, doThread, doHistory } from "./core/mail.js";
import { doTaskAdd, doTaskClaim, doTaskProgress, doTaskDone, boardText } from "./core/tasks.js";
import { setupOwner, confirmOwner, setOwnerMode, attachOwner } from "./core/owner.js";
import { wizQuestions, wizAnswersBatch, wizNext, setupGuard } from "./core/wizard.js";

const cfg = loadConfig();
const db = openDb(cfg);
const ctrl: Ctx = { db, cfg, email: makeEmail(cfg) };
reconcileAdmins(ctrl);
loadBrand(ctrl);
applyConfigOverrides(ctrl); // web-edited tunables win over crew.toml
startSweeps(ctrl, () => (cfg.mode === "cloud" ? listTenantIds(ctrl).map((id) => tenantCtx(ctrl, id)) : [ctrl]));

// A rejected promise or thrown timer must never take the relay down.
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

if (cfg.mode !== "local" && !cfg.public_url)
  console.warn(`[crew] WARNING: mode='${cfg.mode}' needs public_url set for OAuth callbacks to work.`);
if (cfg.mode === "cloud" && cfg.auth.open_registration && (cfg.auth.admin_emails || []).length === 0)
  console.warn("[crew] WARNING: cloud open_registration is on but no admin_emails set — nobody can mint invite codes, so nobody can register. Set auth.admin_emails / CREW_ADMIN_EMAILS.");

const app = new Hono<{ Variables: { accountId: number | null } }>();
// Cap request bodies before they are buffered/parsed into memory.
app.use("*", bodyLimit({ maxSize: cfg.limits.max_body * 2, onError: (c) => c.json({ error: "body_too_large" }, 413) }));
app.get("/health", (c) => c.json({ ok: true, mode: cfg.mode, brand: cfg.brand.name }));
// Root: send humans to the dashboard (which bounces to /login when needed).
// Local mode has no auth, so the dashboard is the landing page directly.
app.get("/", (c) => c.redirect("/app"));

// ── auth (private/cloud) ───────────────────────────────────────────────────
const oauth = makeProvider(ctrl);
// Preset bearer tokens are a private-mode convenience (single trust domain).
// They carry no account, so they must NOT be honored in cloud mode where every
// request has to map to an isolated tenant.
const staticTokens = new Map<string, string>();
if (cfg.mode === "private") {
  for (const pair of (process.env[cfg.auth.static_tokens_env] || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [tok, ...lbl] = pair.split(":"); if (tok) staticTokens.set(tok, lbl.join(":") || "static");
  }
}
if (cfg.mode !== "local") {
  app.route("/", mcpAuthRouter({ provider: oauth, issuerUrl: new URL(cfg.public_url || `http://localhost:${cfg.port}`), scopesSupported: ["crew"], resourceName: cfg.brand.name }));
  app.route("/", authRoutes(ctrl));
}

// Require a valid bearer and stash the caller's accountId for tenant scoping.
async function requireAuth(c: import("hono").Context, next: () => Promise<void>): Promise<Response | void> {
  if (cfg.mode === "local") { c.set("accountId", null); return next(); }
  const auth = c.req.header("authorization") || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (tok && staticTokens.has(tok)) { c.set("accountId", null); return next(); }
  try {
    const info = await oauth.verifyAccessToken(tok);
    const acc = (info as { extra?: { accountId?: number } }).extra?.accountId;
    c.set("accountId", acc ?? null);
    return next();
  } catch { return c.json({ error: "unauthorized", detail: "present a valid Bearer token; connect via OAuth or a configured static token" }, 401); }
}

// The tenant-scoped Ctx for the current request.
const T = (c: import("hono").Context): Ctx => tenantCtx(ctrl, c.get("accountId"));

// ── MCP endpoint (stateless per request) ──────────────────────────────────
app.all("/mcp", requireAuth, async (c) => {
  const server = buildMcpServer(T(c));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.use("/api/*", requireAuth);

// ── REST mirror (parity with the MCP tools; used by web UI, watchers, tests) ─
const jz = (c: import("hono").Context, o: unknown) =>
  c.json(o as object, (o as { error?: string })?.error ? 400 : 200);

app.post("/api/register", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doRegister(t, p.box_id ?? p.box ?? "", p.session_name ?? "", p.platform ?? "", p.environment ?? "", p.pool_code ?? "", p.role ?? "", !!p.override_name)); });
app.get("/api/pool", (c) => jz(c, doPool(T(c), c.req.query("code") ?? "")));
app.post("/api/team/create", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doInitializeTeam(t, p.pool_code ?? p.code ?? "", p.coordinator_box ?? "")); });
app.post("/api/team/join", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doJoinTeam(t, p.code ?? "", p.box ?? "")); });
app.post("/api/team/add-member", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doAddMember(t, p.code ?? "", p.session_name ?? "", p.platform ?? "", p.environment ?? "", p.role ?? "", !!p.override_name)); });
app.post("/api/team/name", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(t, p.code ?? "") ?? doSetTeamName(t, p.code ?? "", p.name ?? "")); });
app.post("/api/team/alias", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(t, p.code ?? "") ?? doSetMemberAlias(t, p.code ?? "", Number(p.member_no), p.alias ?? "", !!p.override_name)); });
app.post("/api/team/role", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(t, p.code ?? "") ?? doSetBoxRole(t, p.code ?? "", Number(p.member_no), p.role ?? "")); });
app.post("/api/team/attach-owner", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, setupGuard(t, p.code ?? "") ?? attachOwner(t, p.code ?? "")); });
app.get("/api/team", (c) => jz(c, teamRoster(T(c), c.req.query("code") ?? "", c.req.query("view") === "full" ? "full" : "brief")));
app.post("/api/setup/questions", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, wizQuestions(t, p.code ?? "", !!p.restart)); });
app.post("/api/setup/answers", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, wizAnswersBatch(t, p.code ?? "", p.answers)); });
app.post("/api/setup/next", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, wizNext(t, p.code ?? "", !!p.restart)); });

app.post("/api/send", async (c) => {
  const t = T(c);
  const p = await c.req.json().catch(() => ({}));
  const [rendered, terr] = renderTemplate(t, p.template ?? "note", p.fields ?? {}, p.body ?? "");
  if (terr) return jz(c, terr);
  const [res, err] = doSend(t, p.from ?? "", p.to, p.cc, rendered!, { fallbackAlias: p.alias ?? "", ownerJustification: p.owner_justification ?? "", dedupKey: p.dedup_key ?? "", replyTo: p.reply_to ?? null });
  if (err) return jz(c, err);
  return c.json({ ...res, ...mailTaskHook(t, p.from ?? "", (p.to ?? []) as string[], p.template ?? "note", p.fields ?? {}) });
});
app.get("/api/poll", async (c) => { const t = T(c); const box = c.req.query("box") ?? ""; if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box)) return jz(c, { error: "bad_box" }); const msgs = await doPoll(t, box, Number(c.req.query("wait") ?? 25), true); return c.json({ messages: msgs }); });
app.get("/api/checkmail", async (c) => { const t = T(c); const box = c.req.query("box") ?? ""; if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box)) return jz(c, { error: "bad_box" }); const at = Number(c.req.query("ack_through") ?? 0); if (at) doAck(t, box, at); const msgs = await doPoll(t, box, Number(c.req.query("wait") ?? 25), false); const rem = boardReminder(t, box); if (rem) msgs.push(rem); return c.json({ messages: msgs }); });
app.post("/api/ack", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doAck(t, p.box ?? "", p.through_id)); });
app.get("/api/peek", (c) => { const t = T(c); const box = c.req.query("box") ?? ""; return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(box) ? c.json({ messages: fetchBox(t, box, false) }) : jz(c, { error: "bad_box" }); });
app.get("/api/thread", (c) => jz(c, doThread(T(c), c.req.query("id") ?? "")));
app.get("/api/history", (c) => { const t = T(c); const box = c.req.query("box") ?? ""; return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(box) ? c.json(doHistory(t, box, Number(c.req.query("limit") ?? 50))) : jz(c, { error: "bad_box" }); });
app.get("/api/boxes", (c) => c.json({ boxes: doBoxes(T(c)) }));

app.post("/api/task/add", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doTaskAdd(t, p.team ?? "", p.title ?? "", p.detail ?? "", p.created_by ?? "", p.deps ?? null, p.assign_to ?? "", p.priority ?? 2, p.discovered_from ?? null)); });
app.post("/api/task/claim", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doTaskClaim(t, Number(p.task_id), p.box ?? "")); });
app.post("/api/task/progress", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doTaskProgress(t, Number(p.task_id), p.box ?? "", p.note ?? "")); });
app.post("/api/task/done", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, doTaskDone(t, Number(p.task_id), p.box ?? "", p.result ?? "")); });
app.get("/api/tasks", (c) => { const t = T(c); const team = c.req.query("team") ?? ""; if (!t.db.prepare("SELECT 1 FROM teams WHERE code=?").get(team)) return jz(c, { error: "no_such_team" }); return c.json({ team, board: boardText(t, team), roster: rosterText(t, team) }); });

app.post("/api/owner/setup", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, await setupOwner(t, p.full_name ?? "", p.alias ?? "", p.email ?? "")); });
app.post("/api/owner/confirm", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, confirmOwner(t, !!p.override)); });
app.post("/api/owner/mode", async (c) => { const t = T(c); const p = await c.req.json().catch(() => ({})); return jz(c, setOwnerMode(t, p.mode ?? "", p.custom_rules ?? "", p.allow_senders ?? "", p.allow_direct ?? "", p.persistent ?? null)); });

app.get("/api/viewkey", (c) => { const code = resolveViewKey(T(c), c.req.query("key") ?? ""); return code ? c.json({ team: code }) : jz(c, { error: "bad_key" }); });

app.route("/", dashboardRoutes(ctrl));
app.route("/", settingsRoutes(ctrl));
app.route("/", boardRoutes(ctrl)); // public read-only board by view key (/b/<key>)
if (cfg.mode === "cloud") app.route("/", adminRoutes(ctrl));

const host = cfg.host;
const port = cfg.port;
serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`crew-relay [${cfg.mode}] on ${host}:${info.port}`);
});
