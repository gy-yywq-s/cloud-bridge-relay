// MCP server: registers every crew tool + prompt. Transport is wired per
// request in the Hono app. Results are returned as JSON text content.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Ctx } from "../core/context.js";
import { OWNER_BOX, resolveViewKey, teamViewKey, rosterText, RELAY_RULE } from "../core/context.js";
import {
  doRegister, doPool, doInitializeTeam, doJoinTeam, doSetTeamName,
  doSetMemberAlias, doSetBoxRole, doBoxes, teamRoster, nameConflict,
} from "../core/teams.js";
import {
  renderTemplate, doSend, mailTaskHook, doPoll, fetchBox, doAck,
  boardReminder, doThread, doHistory,
} from "../core/mail.js";
import { doTaskAdd, doTaskClaim, doTaskProgress, doTaskDone, boardText } from "../core/tasks.js";
import { setupOwner, confirmOwner, setOwnerMode, attachOwner } from "../core/owner.js";
import { wizQuestions, wizAnswersBatch, wizNext, setupGuard } from "../core/wizard.js";

const J = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRi = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function findTeamByPool(c: Ctx, pool: string): string | null {
  const r = c.db.prepare("SELECT code FROM teams WHERE pool_code=? ORDER BY created_ts DESC LIMIT 1").get(String(pool)) as { code: string } | undefined;
  return r?.code ?? null;
}

export function buildMcpServer(c: Ctx): McpServer {
  const s = new McpServer({ name: c.cfg.brand.name, version: "1.0.0" });

  // ── entry points ──────────────────────────────────────────────────────
  s.registerTool("crew_onboard", { description: "ENTRY POINT for \"crew onboard <code>\". One call: registers this session into that pool and returns the line to show the human plus what to do next. Gather REAL facts first (uname/os/cpu) — never copy an example. platform is 'claude-code' or 'codex'.", inputSchema: { pool_code: z.string(), platform: z.string(), environment: z.string(), session_name: z.string().default("") }, annotations: WRi },
    async ({ pool_code, platform, environment, session_name }) => J(doRegister(c, "", session_name, platform, environment, pool_code)));

  s.registerTool("crew_setup", { description: "ENTRY POINT for \"crew setup <code>\". Forms the team from the pool if needed (you become coordinator), then returns the setup interview. Ask the human the whole batch in one message; submit with setup_answers. Never explain the procedure to the human — it is in the responses.", inputSchema: { pool_or_team: z.string(), my_box: z.string(), restart: z.boolean().default(false) }, annotations: WR },
    async ({ pool_or_team, my_box, restart }) => {
      let code = pool_or_team.trim();
      if (new RegExp(`^\\d{${c.cfg.team.pool_code_digits}}$`).test(code)) {
        const existing = findTeamByPool(c, code);
        if (!existing) {
          const r = doInitializeTeam(c, code, my_box);
          if ("error" in r) {
            if (r.error === "not_in_pool") (r as Record<string, unknown>).directive = "You are not registered in this pool. Call crew_onboard with this pool code NOW and then call crew_setup again yourself — do NOT hand this back to the human.";
            return J(r);
          }
          code = r.team_code as string;
        } else code = existing;
      }
      return J(wizQuestions(c, code, restart));
    });

  // ── setup ─────────────────────────────────────────────────────────────
  s.registerTool("setup_questions", { description: "The remaining team-setup interview as ONE batch. Ask the human all of it in a single message (Claude Code: AskUserQuestion; else one numbered message), then submit setup_answers.", inputSchema: { code: z.string(), restart: z.boolean().default(false) }, annotations: RO },
    async ({ code, restart }) => J(wizQuestions(c, code, restart)));
  s.registerTool("setup_answers", { description: "Submit the human's answers for several interview steps at once: answers={step_id: answer}. Per-item problems come back under `errors`; `next` holds what remains or the completion payload.", inputSchema: { code: z.string(), answers: z.record(z.string(), z.string()) }, annotations: WR },
    async ({ code, answers }) => J(wizAnswersBatch(c, code, answers)));
  s.registerTool("setup_next", { description: "Legacy one-question-at-a-time interview. Prefer setup_questions.", inputSchema: { code: z.string(), restart: z.boolean().default(false) }, annotations: RO },
    async ({ code, restart }) => J(wizNext(c, code, restart)));

  // ── team management ───────────────────────────────────────────────────
  s.registerTool("watch_pool", { description: "See who is waiting in a pool. If told to monitor, call periodically; when the owner says 'initialize', call crew_setup.", inputSchema: { pool_code: z.string() }, annotations: RO },
    async ({ pool_code }) => J(doPool(c, pool_code)));
  s.registerTool("initialize_team", { description: "Turn the waiting pool into a team. Call only on the owner's word 'initialize'.", inputSchema: { pool_code: z.string(), coordinator_box: z.string() }, annotations: WR },
    async ({ pool_code, coordinator_box }) => J(doInitializeTeam(c, pool_code, coordinator_box)));
  s.registerTool("join_team", { description: "Join an existing team late (register_box first). Broadcasts the update.", inputSchema: { code: z.string(), box: z.string() }, annotations: WRi },
    async ({ code, box }) => J(doJoinTeam(c, code, box)));
  s.registerTool("register_box", { description: "Low-level register into a pool. platform 'claude-code'|'codex'; box_id omitted first time (server assigns bx-xxxxxx; SAVE it), passed to re-register.", inputSchema: { platform: z.string(), environment: z.string(), pool_code: z.string(), session_name: z.string().default(""), box_id: z.string().default(""), role: z.string().default(""), override_name: z.boolean().default(false) }, annotations: WRi },
    async ({ platform, environment, pool_code, session_name, box_id, role, override_name }) => J(doRegister(c, box_id, session_name, platform, environment, pool_code, role, override_name)));
  s.registerTool("set_team_name", { description: "Setup center: set the team name (locked until the interview finishes).", inputSchema: { code: z.string(), name: z.string() }, annotations: WRi },
    async ({ code, name }) => J(setupGuard(c, code) ?? doSetTeamName(c, code, name)));
  s.registerTool("set_member_alias", { description: "Setup center: set a member's display name. Duplicate names return name_taken; override_name only on owner approval.", inputSchema: { code: z.string(), member_no: z.number(), alias: z.string(), override_name: z.boolean().default(false) }, annotations: WRi },
    async ({ code, member_no, alias, override_name }) => J(setupGuard(c, code) ?? doSetMemberAlias(c, code, member_no, alias, override_name)));
  s.registerTool("set_box_role", { description: "Setup center: mark a member 'manager' or 'worker'. Workers can never mail the owner. Broadcasts.", inputSchema: { code: z.string(), member_no: z.number(), role: z.string() }, annotations: WRi },
    async ({ code, member_no, role }) => J(setupGuard(c, code) ?? doSetBoxRole(c, code, member_no, role)));
  s.registerTool("list_team", { description: "Team roster. view='brief' (default): one line per member; view='full': every field + team card. Relay say_to_owner verbatim.", inputSchema: { code: z.string(), view: z.string().default("brief") }, annotations: RO },
    async ({ code, view }) => c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(String(code)) ? J(teamRoster(c, String(code), view === "full" ? "full" : "brief")) : J({ error: "no_such_team" }));
  s.registerTool("show_roster", { description: "Show the human the current team roster. Returns say_to_owner (canonical rendering). Relay verbatim.", inputSchema: { code: z.string() }, annotations: RO },
    async ({ code }) => c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(String(code)) ? J({ say_to_owner: rosterText(c, String(code)), relay_rule: RELAY_RULE }) : J({ error: "no_such_team" }));
  s.registerTool("list_boxes", { description: "Directory of all boxes across teams.", inputSchema: {}, annotations: RO }, async () => J(doBoxes(c)));
  s.registerTool("board_key", { description: "The team's read-only view key for the human board site. Give it to the human when they ask to watch the board in a browser.", inputSchema: { code: z.string() }, annotations: RO },
    async ({ code }) => { if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(String(code))) return J({ error: "no_such_team" }); const k = teamViewKey(c, String(code)); return J({ team: String(code), view_key: k, say_to_owner: `Live board: ${c.cfg.brand.board_url || "(board url not configured)"} — enter key ${k}. Read-only, this team only; keep it semi-private.`, relay_rule: RELAY_RULE }); });

  // ── mail ──────────────────────────────────────────────────────────────
  s.registerTool("send_mail", { description: "Send a message. to = must act; cc = FYI. STRUCTURE REQUIRED: pick a template (status/milestone/blocker/question/handoff/result/note) and fill its fields; missing fields refused. Replying? reply_to=<id>. Mailing 'owner' is HARD-GATED by owner mode. Rate-limited; a refusal means NOT sent.", inputSchema: { sender_box: z.string(), to: z.array(z.string()), body: z.string().default(""), template: z.string().default("note"), fields: z.record(z.string(), z.unknown()).default({}), cc: z.array(z.string()).default([]), owner_justification: z.string().default(""), dedup_key: z.string().default(""), reply_to: z.number().nullable().default(null) }, annotations: WR },
    async ({ sender_box, to, body, template, fields, cc, owner_justification, dedup_key, reply_to }) => {
      const [rendered, terr] = renderTemplate(c, template, fields as Record<string, unknown>, body);
      if (terr) return J(terr);
      const [res, err] = doSend(c, sender_box, to, cc, rendered!, { ownerJustification: owner_justification, dedupKey: dedup_key, replyTo: reply_to });
      if (err) return J(err);
      return J({ ...res, ...mailTaskHook(c, sender_box, to, template, fields as Record<string, unknown>) });
    });
  s.registerTool("check_mail", { description: "Pull your mailbox (ACK MODEL). For a plain MCP client THE LOOP IS THE WORKING MODE: while active and holding a turn, call this with wait_seconds=50 repeatedly; leave to act, then return. Ack processed mail. Messages carry directive (OBEY IT), from stamp, delivered_as, team_info.", inputSchema: { box: z.string(), wait_seconds: z.number().default(25), ack_through: z.number().default(0) }, annotations: RO },
    async ({ box, wait_seconds, ack_through }) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box)) return J([{ error: "bad_box" }]);
      if (ack_through) doAck(c, box, ack_through);
      const msgs = await doPoll(c, box, wait_seconds, false);
      const rem = boardReminder(c, box); if (rem) msgs.push(rem);
      return J(msgs);
    });
  s.registerTool("ack_mail", { description: "Acknowledge processed mail: marks everything with id <= through_id done. Idempotent.", inputSchema: { box: z.string(), through_id: z.number() }, annotations: WRi },
    async ({ box, through_id }) => J(doAck(c, box, through_id)));
  s.registerTool("peek_mail", { description: "Look at pending messages without taking them.", inputSchema: { box: z.string() }, annotations: RO },
    async ({ box }) => J(/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box) ? fetchBox(c, box, false) : [{ error: "bad_box" }]));
  s.registerTool("mail_thread", { description: "Follow a conversation: give any message id, get the whole chain (ancestors + replies) in order.", inputSchema: { message_id: z.number() }, annotations: RO },
    async ({ message_id }) => J(doThread(c, message_id)));
  s.registerTool("mail_history", { description: "Audit trail: received (taken_ts null = pending; email_status for owner mail) and sent messages, ~14 days.", inputSchema: { box: z.string(), limit: z.number().default(50) }, annotations: RO },
    async ({ box, limit }) => J(/^[a-z0-9][a-z0-9_-]{0,31}$/.test(box) ? doHistory(c, box, limit) : { error: "bad_box" }));

  // ── task board ────────────────────────────────────────────────────────
  s.registerTool("task_add", { description: "Add a task. One self-contained deliverable; aim for 5-6 open per member. deps = ids that must be DONE first. assign_to reserves it. priority 1=high 2=normal 3=low. Discovered work: task_add(discovered_from=<current task id>) instead of chasing it.", inputSchema: { team: z.string(), title: z.string(), detail: z.string().default(""), created_by: z.string().default(""), deps: z.array(z.number()).nullable().default(null), assign_to: z.string().default(""), priority: z.number().default(2), discovered_from: z.number().nullable().default(null) }, annotations: WR },
    async ({ team, title, detail, created_by, deps, assign_to, priority, discovered_from }) => J(doTaskAdd(c, team, title, detail, created_by, deps, assign_to, priority, discovered_from)));
  s.registerTool("task_claim", { description: "Claim a ready task before working. Atomic: one winner. A refusal means pick another; never work an unclaimed/lost task.", inputSchema: { task_id: z.number(), box: z.string() }, annotations: WR },
    async ({ task_id, box }) => J(doTaskClaim(c, task_id, box)));
  s.registerTool("task_progress", { description: "One-line progress note on your claimed task. At least hourly — silence marks it STALLED and pings the manager.", inputSchema: { task_id: z.number(), box: z.string(), note: z.string() }, annotations: WRi },
    async ({ task_id, box, note }) => J(doTaskProgress(c, task_id, box, note)));
  s.registerTool("task_done", { description: "Close your task with a one-line result THE MOMENT it is finished — a forgotten close jams the team. Response lists what you unblocked and what's ready next: SELF-CLAIM instead of going idle.", inputSchema: { task_id: z.number(), box: z.string(), result: z.string() }, annotations: WRi },
    async ({ task_id, box, result }) => J(doTaskDone(c, task_id, box, result)));
  s.registerTool("task_list", { description: "The team task board: READY / IN PROGRESS / BLOCKED / DONE. Returns say_to_owner; claim from READY only.", inputSchema: { team: z.string() }, annotations: RO },
    async ({ team }) => c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(String(team)) ? J({ say_to_owner: boardText(c, String(team)), relay_rule: RELAY_RULE }) : J({ error: "no_such_team" }));

  // ── owner mailbox ─────────────────────────────────────────────────────
  s.registerTool("setup_owner_mailbox", { description: "Create OR edit the owner mailbox. Same verified email = name/alias update only. New email = verification sent; the OWNER must confirm before confirm_owner_mailbox. A failed send MUST be read to the owner verbatim.", inputSchema: { full_name: z.string(), email: z.string(), alias: z.string().default("") }, annotations: WR },
    async ({ full_name, email, alias }) => J(await setupOwner(c, full_name, alias, email)));
  s.registerTool("confirm_owner_mailbox", { description: "Call ONLY after the owner says the verification email arrived (or says 'override' after a reported failure).", inputSchema: { override: z.boolean().default(false) }, annotations: WRi },
    async ({ override }) => J(confirmOwner(c, override)));
  s.registerTool("set_owner_mode", { description: "Owner receive mode: a=milestones-only(default) b=manager-open c=team-open d=custom. For d, translate wishes into hard rules + allow_senders + allow_direct, read back, get explicit yes.", inputSchema: { mode: z.string(), custom_rules: z.string().default(""), allow_senders: z.string().default(""), allow_direct: z.string().default(""), persistent: z.boolean().nullable().default(null) }, annotations: WRi },
    async ({ mode, custom_rules, allow_senders, allow_direct, persistent }) => J(setOwnerMode(c, mode, custom_rules, allow_senders, allow_direct, persistent)));
  s.registerTool("attach_owner_to_team", { description: "Setup center: attach the confirmed owner mailbox to a team as member #0 (owner + human). Broadcasts contact rules.", inputSchema: { code: z.string() }, annotations: WRi },
    async ({ code }) => J(setupGuard(c, code) ?? attachOwner(c, code)));

  // ── prompts (slash-command entry points) ──────────────────────────────
  s.registerPrompt("onboard", { description: "Join a crew pool and listen. Triggered by \"crew onboard <code>\"." },
    () => ({ messages: [{ role: "user", text: onboardPrompt() }].map((m) => ({ role: m.role as "user", content: { type: "text" as const, text: m.text } })) }));
  s.registerPrompt("setup", { description: "Run the team setup interview. Triggered by \"crew setup <code>\"." },
    () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: setupPrompt() } }] }));

  return s;
}


function onboardPrompt(): string {
  return "The human gave you a crew pool code. 1) GATHER REAL FACTS about yourself (uname -a, os version, cpu/ram) — never copy an example; environment is 'where / hardware / OS+version'; 'cloud session' means the vendor's hosted product, a session on a server you SSH into is 'remote session on <host>'; platform is 'claude-code' or 'codex'. 2) crew_onboard(pool_code, platform, environment, session_name); show say_to_owner. 3) SAVE the box id. 4) ENTER THE LISTENING LOOP AND STAY IN IT: check_mail(box, wait_seconds=50) repeatedly while your turn lasts; leave only to act, then return — a member that ends its turn is deaf. 5) Obey each message's directive (ACTION/CC/SYSTEM). 6) BOARD DISCIPLINE: work that outlives your turn goes on the board; file discovered work with discovered_from; hold no task -> claim a ready one; private todo tools only for micro-steps inside your claimed task.";
}
function setupPrompt(): string {
  return "The human asked you to set up the crew. 1) crew_setup(pool_or_team, my_box); if not in the pool, crew_onboard yourself first and call again — never hand it back to the human. 2) It returns ALL questions as one batch — ask the human everything in ONE message (Claude Code: AskUserQuestion with the options/defaults; else one clean message). Present per the relay rule (their language, first person where about you). Never answer for them; 'default' is valid. 3) setup_answers(code, answers); fix per-item errors, run handoffs (owner-mailbox, mode d), call setup_questions again until done. 4) On done: present the team card nicely, remember the team id yourself, enter the check_mail loop.";
}
