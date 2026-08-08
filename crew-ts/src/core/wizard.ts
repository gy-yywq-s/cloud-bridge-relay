// Server-driven setup interview. Configuration is state on the server, not
// advice in a prompt: direct setters are refused until the wizard is done.
import { now } from "../db.js";
import { type Ctx, OWNER_BOX, RELAY_RULE, boxRow, rosterText, teamViewKey, broadcastTeam } from "./context.js";
import { fullMembers, doSetTeamName, doSetMemberAlias, doSetBoxRole } from "./teams.js";
import { ownerRow, setOwnerMode, attachOwner, OWNER_MODES } from "./owner.js";

interface Step { id: string; ask: string; options: string[]; default: string; answer_format: string; }
interface WizRow { team_code: string; step_id: string; answers: string; done: number; }

const wizRow = (c: Ctx, code: string): WizRow | undefined =>
  c.db.prepare("SELECT * FROM setup_state WHERE team_code=?").get(code) as WizRow | undefined;
const wizAnswers = (c: Ctx, code: string): Record<string, string> => { const r = wizRow(c, code); return r ? JSON.parse(r.answers) : {}; };
function wizSave(c: Ctx, code: string, stepId: string, answers: Record<string, string>, done = 0): void {
  c.db.prepare("INSERT INTO setup_state(team_code,step_id,answers,done,started_ts) VALUES(?,?,?,?,?) ON CONFLICT(team_code) DO UPDATE SET step_id=excluded.step_id, answers=excluded.answers, done=excluded.done")
    .run(code, stepId, JSON.stringify(answers), done, now());
}
export const wizPending = (c: Ctx, code: string): boolean => { const r = wizRow(c, code); return !(r && r.done); };

// Configuration setters are wizard-only until setup is done — one guard,
// applied at every entry (MCP tools AND the REST mirror), so no path is free-form.
export function setupGuard(c: Ctx, code: string): Record<string, unknown> | null {
  if (wizPending(c, String(code)))
    return { error: "setup_wizard_required", directive: "This team has not been set up yet, and configuration is NOT free-form: call setup_questions(code) and answer with the owner. That flow applies every setting. Direct setters unlock once setup is complete." };
  return null;
}

function wizSteps(c: Ctx, code: string): Step[] {
  const members = fullMembers(c, code).filter((m) => m.box !== OWNER_BOX);
  const o = ownerRow(c);
  const steps: Step[] = [{ id: "team_name", ask: "What should this team be called? (I'll use the name in every member's display name, e.g. \"<name>-2\".)", options: ["<any name>", "default"], default: "crew-" + code.replace("tm-", ""), answer_format: "a short name, or the word 'default'" }];
  for (const m of members)
    steps.push({ id: `alias_${m.member_no}`, ask: `Member #${m.member_no} is box ${m.box} (${m.platform}, ${m.environment || "no env given"}${m.session_name ? `, session "${m.session_name}"` : ""}). What name should they display as?`, options: ["<any name>", "default"], default: "", answer_format: "a name, or 'default' to keep <team-name>-<number>" });
  steps.push({ id: "manager", ask: "Who handles contact with you (the owner)? Give the member number of the MANAGER — everyone else becomes a WORKER and is hard-blocked from mailing you. Answer 'none' for no chain of command.", options: [...members.map((m) => String(m.member_no)), "none"], default: "none", answer_format: "a member number, or 'none'" });
  if (!(o && o.confirmed))
    steps.push({ id: "owner_setup", ask: "No owner mailbox exists yet. Do you want one? It lets the team reach you by real email, with rules about who may write and when. Answer 'yes' to set it up now (I'll ask for your name and email), or 'skip'.", options: ["yes", "skip"], default: "skip", answer_format: "'yes' or 'skip'" });
  else {
    steps.push({ id: "owner_attach", ask: `Attach your owner mailbox (${o.alias} / ${o.email}) to this team, so members can cc you?`, options: ["yes", "no"], default: "yes", answer_format: "'yes' or 'no'" });
    steps.push({ id: "owner_mode", ask: "How should the team be allowed to contact you?\n  a = milestones only (default): manager only, cc only, direct mail needs a justification\n  b = manager-open: manager only, direct mail allowed\n  c = team-open: anyone may cc you, direct still justified\n  d = custom: describe it in your own words and I'll turn it into rules and read them back", options: ["a", "b", "c", "d"], default: "a", answer_format: "'a', 'b', 'c', or 'd' (for d, add your wording)" });
  }
  return steps;
}

const wizPendingSteps = (c: Ctx, code: string): Step[] => { const a = wizAnswers(c, code); return wizSteps(c, code).filter((s) => !(s.id in a)); };

function wizApply(c: Ctx, code: string, stepId: string, answer: string): [boolean, Record<string, unknown>] {
  const ans = (answer || "").trim(); const low = ans.toLowerCase();
  const steps = Object.fromEntries(wizSteps(c, code).map((s) => [s.id, s]));
  const step = steps[stepId];
  if (!step) return [false, { error: "unknown_step", detail: Object.keys(steps) }];
  const useDefault = ["default", "skip", ""].includes(low) && stepId !== "owner_mode";
  if (stepId === "team_name") doSetTeamName(c, code, useDefault ? step.default : ans);
  else if (stepId.startsWith("alias_")) {
    if (!useDefault) {
      const no = Number(stepId.split("_")[1]);
      const force = low.startsWith("force");
      const nm = force ? ans.replace(/^force\s+/i, "") : ans;
      const r = doSetMemberAlias(c, code, no, nm, force) as { error?: string; conflict_with?: string };
      if (r.error === "name_taken") return [false, { error: "name_taken", conflict_with: r.conflict_with, ask_owner_verbatim: `The name "${ans}" is already used by another member. Pick a different one, or say 'force <name>' to use it anyway.`, detail: "resubmit this same step_id with a new name, or 'force <name>'" }];
    }
  } else if (stepId === "manager") {
    if (!["none", ""].includes(low)) {
      const mgr = Number(low);
      const members = fullMembers(c, code).filter((m) => m.box !== OWNER_BOX);
      if (!Number.isInteger(mgr) || !members.some((m) => m.member_no === mgr))
        return [false, { error: "bad_answer", detail: `${step.answer_format}; valid member numbers: ${members.map((m) => m.member_no).join(", ")}` }];
      for (const m of members) doSetBoxRole(c, code, m.member_no, m.member_no === mgr ? "manager" : "worker");
    }
  } else if (stepId === "owner_setup") {
    if (low === "yes") return [true, { handoff: "owner_mailbox", directive: "The owner wants a mailbox. RUN THE add-owner-mailbox FLOW NOW (setup_owner_mailbox -> owner confirms receipt -> confirm_owner_mailbox), then call setup_next/setup_questions again — the wizard will pick up with attaching it." }];
  } else if (stepId === "owner_attach") {
    if (["yes", "y"].includes(low)) attachOwner(c, code);
  } else if (stepId === "owner_mode") {
    let mode = low ? low.split(/\s+/)[0] : "a";
    if (["default", ""].includes(mode)) mode = step.default;
    if (!(mode in OWNER_MODES)) return [false, { error: "bad_answer", detail: step.answer_format }];
    if (mode === "d") return [true, { handoff: "owner_mode_custom", owner_words: ans, directive: "Mode d: turn the owner's wording into (1) a short hard-rules text, (2) allow_senders manager_only|any, (3) allow_direct justified_only|free. READ THEM BACK, get an explicit yes, ask if it should be permanent, then call set_owner_mode(mode='d', ...). Then call setup_questions again." }];
    setOwnerMode(c, mode);
  }
  return [true, {}];
}

export function wizNext(c: Ctx, code: string, restart = false): Record<string, unknown> {
  if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return { error: "no_such_team" };
  if (restart) wizSave(c, code, "", {}, 0);
  const answers = wizAnswers(c, code);
  for (const step of wizSteps(c, code)) {
    if (step.id in answers) continue;
    wizSave(c, code, step.id, answers, 0);
    const total = wizSteps(c, code).length;
    return { step_id: step.id, progress: `${Object.keys(answers).length + 1}/${total}`, say_to_owner: `[setup ${Object.keys(answers).length + 1}/${total}] ${step.ask}\n(${step.options.join(" / ")} — "default" = ${step.default || "<team-name>-<number>"})`, relay_rule: RELAY_RULE, ask_owner_verbatim: step.ask, options: step.options, default_if_owner_says_default: step.default || "<team-name>-<number>", answer_format: step.answer_format, directive: "ASK THE OWNER THIS QUESTION, VERBATIM, AND NOTHING ELSE. When the owner answers, call setup_answers(code, { \"" + step.id + "\": \"<their answer>\" }). 'default' is a valid answer. Prefer setup_questions to ask the whole batch at once. Configuration setters stay REFUSED until this wizard is done." };
  }
  return wizDone(c, code, answers);
}

function wizDone(c: Ctx, code: string, answers: Record<string, string>): Record<string, unknown> {
  const already = wizRow(c, code)?.done;
  wizSave(c, code, "", answers, 1);
  // Idempotent: only broadcast SETUP COMPLETE on the transition, never on
  // repeat calls (re-running the entry point would otherwise spam the team).
  if (!already) broadcastTeam(c, code, "SETUP COMPLETE for this team.\n\n" + rosterText(c, code));
  return { done: true, summary: rosterText(c, code), answers,
    say_to_owner: `Setup complete. Here is your crew:\n\n${rosterText(c, code)}\n\nLive board: ${c.cfg.brand.board_url || "(configure public_url)"} — view key: ${teamViewKey(c, code)} (read-only, keep it semi-private). To change anything later — a name, a role, the whole setup — just say so in plain words; no ids to remember, your sessions know the team.`,
    relay_rule: RELAY_RULE,
    directive: "SETUP IS COMPLETE. Present the team to the owner per the relay rule (nice formatting, their language), REMEMBER the team id yourself — the human never repeats ids — then ENTER THE LISTENING LOOP: check_mail(your_box, wait_seconds=50) repeatedly for as long as this turn lasts. Setters are unlocked for later edits; a plain-language request from the human is enough to change or rerun anything." };
}

export function wizQuestions(c: Ctx, code: string, restart = false): Record<string, unknown> {
  if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return { error: "no_such_team" };
  if (restart) wizSave(c, code, "", {}, 0);
  const steps = wizPendingSteps(c, code);
  if (!steps.length) return wizNext(c, code);
  return { team: code, questions: steps.map((s) => ({ step_id: s.id, question: s.ask, options: s.options, default: s.default || "<team-name>-<number>" })), directive: "Ask the human ALL of these questions in ONE message — one round-trip, not one question per turn. If your host has a structured question tool (Claude Code: AskUserQuestion; Codex/others: your platform's form UI), present them through it with the options and defaults; otherwise a single numbered message. 'default' is always a valid answer. Then call setup_answers(code, answers={step_id: answer, ...}) with everything they said.", relay_rule: RELAY_RULE };
}

export function wizAnswersBatch(c: Ctx, code: string, answers: unknown): Record<string, unknown> {
  const r = wizRow(c, code);
  if (r && r.done) return { error: "setup_already_done", detail: "setters are unlocked; or setup_questions(restart=true)" };
  if (typeof answers !== "object" || answers == null || Array.isArray(answers)) return { error: "bad_answers", detail: "answers is {step_id: answer}" };
  const a = answers as Record<string, unknown>;
  const applied: string[] = []; const errors: Record<string, unknown> = {}; const handoffs: Record<string, unknown>[] = [];
  for (const step of wizSteps(c, code)) {
    const sid = step.id;
    if (!(sid in a) || sid in wizAnswers(c, code)) continue;
    const [ok, extra] = wizApply(c, code, sid, String(a[sid]));
    if (!ok) { errors[sid] = extra; continue; }
    const done = wizAnswers(c, code); done[sid] = String(a[sid]); wizSave(c, code, sid, done, 0);
    applied.push(sid);
    if (extra.handoff) handoffs.push(extra);
  }
  const out: Record<string, unknown> = { applied };
  if (Object.keys(errors).length) out.errors = errors;
  if (handoffs.length) { out.handoffs = handoffs; out.directive = "Finish the handoff flows above, then call setup_questions again for whatever remains."; return out; }
  out.next = wizQuestions(c, code);
  return out;
}

// elicitation-driven variant is wired in the MCP layer (needs ctx.elicit).
export { wizPendingSteps, wizSteps };
