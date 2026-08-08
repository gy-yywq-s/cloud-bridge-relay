#!/usr/bin/env node
// crew-agent — the daemon a human pre-runs on any machine they want to be
// "spawnable". It solves the bootstrapping gap Gary flagged: a session cannot
// spawn a session on a machine it has no access to, and MCP only runs while a
// session runs. So each spawnable host runs THIS long-lived process, which
// authenticates to crew, joins a team, and — on a spawn request delivered as
// crew mail — launches a local claude/codex session that connects back.
//
// Zero dependencies (Node built-ins only). Configure via env:
//   CREW_URL     e.g. https://crew.gaelisus.com   (default)
//   CREW_TOKEN   a crew credential (bearer)         [required in private/cloud]
//   CREW_POOL    4-digit pool code to register into [required first run]
//   CREW_TEAM    team id to add-member into instead of a pool (optional)
//   CREW_PLATFORMS  comma list this host can launch: "claude-code,codex"
//   CREW_NAME    session name for this host box
//   CREW_CWD     working dir for spawned sessions   (default: cwd)
//   CREW_STATE   path to persist this host's box id (default ~/.crew_agent_box)
//
// Spawn protocol: the coordinator sends this host a mail of template "handoff"
// whose `task` begins with "SPAWN <platform>" and whose `context` is the pool
// code + instruction. The agent launches: for claude-code, `claude -p <prompt>`;
// for codex, `codex exec <prompt>`. The launched session is told to
// crew_onboard into the pool and enter the listening loop.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const URL_ = (process.env.CREW_URL || "https://crew.gaelisus.com").replace(/\/$/, "");
const TOKEN = process.env.CREW_TOKEN || "";
const POOL = process.env.CREW_POOL || "";
const TEAM = process.env.CREW_TEAM || "";
const PLATFORMS = (process.env.CREW_PLATFORMS || "claude-code,codex").split(",").map((s) => s.trim());
const NAME = process.env.CREW_NAME || `host-${process.platform}`;
const CWD = process.env.CREW_CWD || process.cwd();
const STATE = process.env.CREW_STATE || `${homedir()}/.crew_agent_box`;

function envDescription() {
  try {
    const os = execSync("uname -srm", { encoding: "utf8" }).trim();
    return `crew-agent host / ${os}`;
  } catch { return `crew-agent host / ${process.platform} ${process.arch}`; }
}

async function api(path, body) {
  const res = await fetch(URL_ + path, {
    method: body ? "POST" : "GET",
    headers: { "User-Agent": "crew-agent/1", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

let BOX = existsSync(STATE) ? readFileSync(STATE, "utf8").trim() : "";

async function register() {
  const env = envDescription();
  let r;
  if (TEAM) r = await api("/api/team/add-member", { code: TEAM, platform: PLATFORMS[0], environment: env, session_name: NAME });
  else r = await api("/api/register", { ...(BOX ? { box_id: BOX } : {}), platform: PLATFORMS[0], environment: env, pool_code: POOL, session_name: NAME });
  if (r.box) { BOX = r.box; writeFileSync(STATE, BOX); }
  console.log(`[crew-agent] registered as ${BOX} (${PLATFORMS.join("/")}); ${r.say_to_owner || ""}`);
}

function launch(platform, prompt) {
  const supported = PLATFORMS.includes(platform);
  if (!supported) { console.warn(`[crew-agent] cannot launch ${platform}; this host does: ${PLATFORMS.join(",")}`); return; }
  const cmd = platform === "codex" ? "codex" : "claude";
  const args = platform === "codex" ? ["exec", prompt] : ["-p", prompt];
  console.log(`[crew-agent] launching ${platform} session…`);
  const child = spawn(cmd, args, { cwd: CWD, stdio: "inherit", env: { ...process.env } });
  child.on("exit", (code) => console.log(`[crew-agent] ${platform} session exited (${code})`));
}

function handleMail(m) {
  if (m.kind !== "mail") return;
  // spawn request: template handoff, task = "SPAWN <platform>"
  const body = String(m.body || "");
  const mm = /SPAWN\s+(claude-code|codex)/i.exec(body);
  if (mm) {
    const platform = mm[1].toLowerCase();
    const pool = (/pool[:\s]+(\d+)/i.exec(body) || [])[1] || POOL;
    const prompt = `Connect the crew MCP server at ${URL_}/mcp. Then run crew_onboard(pool_code="${pool}", platform="${platform}", environment=<gather real facts about this machine>, session_name="spawned"). Save your box id, then enter the check_mail listening loop and follow every directive. ${body.replace(/^\[HANDOFF\]/, "")}`;
    launch(platform, prompt);
  }
}

async function loop() {
  await register();
  console.log(`[crew-agent] listening for spawn requests on ${BOX}…`);
  for (;;) {
    try {
      const out = await api(`/api/checkmail?box=${BOX}&wait=50`);
      const msgs = out.messages || [];
      for (const m of msgs) { if (!m.ephemeral) handleMail(m); }
      const ids = msgs.filter((m) => !m.ephemeral).map((m) => m.id);
      if (ids.length) await api("/api/ack", { box: BOX, through_id: Math.max(...ids) });
    } catch (e) { console.error("[crew-agent]", e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}

if (!POOL && !TEAM && !BOX) { console.error("set CREW_POOL (or CREW_TEAM) on first run"); process.exit(1); }
loop();
