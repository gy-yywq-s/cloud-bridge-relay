// Configuration: three deployment profiles + every previously-hardcoded default,
// loaded from crew.toml (path via CREW_CONFIG) then overlaid with env vars.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const Templates = z.record(
  z.string(),
  z.object({
    fields: z.array(z.string()).default([]),
    optional: z.array(z.string()).default([]),
    use: z.string().default(""),
  }),
);

const ConfigSchema = z.object({
  // ── deployment profile ────────────────────────────────────────────────
  //  local   : 127.0.0.1 only, no auth — sessions on this machine only
  //  private : reachable (tunnel/LAN), OAuth or preset tokens, deployer-gated
  //  cloud   : public, open OAuth registration
  mode: z.enum(["local", "private", "cloud"]).default("local"),

  // ── network ───────────────────────────────────────────────────────────
  host: z.string().default(""), // "" => 127.0.0.1 for local, 0.0.0.0 otherwise
  port: z.coerce.number().default(8790),
  public_url: z.string().default(""), // external https base, required for OAuth
  data_dir: z.string().default(""), // "" => ~/.crew or $CREW_DATA_DIR

  // ── branding / product (all user-editable) ────────────────────────────
  brand: z.object({
    name: z.string().default("crew"),
    board_url: z.string().default(""), // "" => public_url
    accent: z.string().default("#1c4f8f"), // placeholder indigo; owner may recolor
  }).default({}),

  // ── email (owner mailbox delivery) ────────────────────────────────────
  email: z.object({
    provider: z.enum(["resend", "none"]).default("none"),
    from: z.string().default(""), // e.g. crew@verification.example.com
    api_key_env: z.string().default("RESEND_API_KEY"),
  }).default({}),

  // ── tunables (were hardcoded in relay.py) ─────────────────────────────
  limits: z.object({
    max_body: z.coerce.number().default(256 * 1024),
    max_queue: z.coerce.number().default(500),
    max_boxes: z.coerce.number().default(2000),
    prune_days: z.coerce.number().default(14),
    rate_n: z.coerce.number().default(30),
    rate_window_s: z.coerce.number().default(300),
    max_wait_s: z.coerce.number().default(55),
  }).default({}),

  timers: z.object({
    stale_after_s: z.coerce.number().default(600),
    quiet_after_s: z.coerce.number().default(21600),
    task_stall_after_s: z.coerce.number().default(7200),
    watcher_gap_s: z.coerce.number().default(180),
    sweep_interval_s: z.coerce.number().default(60),
  }).default({}),

  team: z.object({
    pool_code_digits: z.coerce.number().default(4),
    default_owner_mode: z.enum(["a", "b", "c", "d"]).default("a"),
    board_refresh_s: z.coerce.number().default(10),
  }).default({}),

  // ── auth ──────────────────────────────────────────────────────────────
  auth: z.object({
    // preset bearer tokens accepted in addition to OAuth (private mode).
    // map of token -> label; empty in cloud mode.
    static_tokens_env: z.string().default("CREW_STATIC_TOKENS"),
    // web session signing secret env
    session_secret_env: z.string().default("CREW_SESSION_SECRET"),
    // cloud: allow open account registration on the web UI
    open_registration: z.boolean().default(false),
  }).default({}),

  templates: Templates.default({
    status: { fields: ["done", "next"], optional: ["blockers", "eta"], use: "routine progress update" },
    milestone: { fields: ["headline", "detail"], optional: ["numbers"], use: "a named checkpoint (owner-worthy)" },
    blocker: { fields: ["blocked_on", "tried", "need"], optional: ["impact"], use: "work stopped, you need something" },
    question: { fields: ["question", "why_it_matters"], optional: ["options", "your_recommendation"], use: "a decision you cannot make alone" },
    handoff: { fields: ["task", "context", "deliverable"], optional: ["deadline", "constraints"], use: "assigning work" },
    result: { fields: ["task", "outcome"], optional: ["evidence", "caveats"], use: "reporting finished work" },
    note: { fields: [], optional: [], use: "anything else; body is free text" },
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const path = process.env.CREW_CONFIG || "crew.toml";
  let raw: unknown = {};
  if (existsSync(path)) raw = parseToml(readFileSync(path, "utf8"));
  const cfg = ConfigSchema.parse(raw);

  // env overlays (env always wins; handy for containers/systemd)
  if (process.env.CREW_MODE) cfg.mode = process.env.CREW_MODE as Config["mode"];
  if (process.env.CREW_PORT) cfg.port = Number(process.env.CREW_PORT);
  if (process.env.PORT) cfg.port = Number(process.env.PORT); // platform-injected
  if (process.env.CREW_PUBLIC_URL) cfg.public_url = process.env.CREW_PUBLIC_URL;
  if (process.env.CREW_DATA_DIR) cfg.data_dir = process.env.CREW_DATA_DIR;

  // derived defaults
  if (!cfg.host) cfg.host = cfg.mode === "local" ? "127.0.0.1" : "0.0.0.0";
  if (!cfg.brand.board_url) cfg.brand.board_url = cfg.public_url;

  return cfg;
}

export function requireOAuth(cfg: Config): boolean {
  return cfg.mode !== "local";
}
