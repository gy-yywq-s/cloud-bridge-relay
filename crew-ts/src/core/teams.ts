// Registration, pools, team initialization, join/add-member, roles, view keys.
import { now } from "../db.js";
import {
  type Ctx, type BoxRow, OWNER_BOX, BOX_RE, PLATFORMS, ROLES, codeRe, boxRow, displayName,
  touchBox, bumpRv, broadcastTeam, systemMail, teamCard, rosterText, teamViewKey, randHex,
} from "./context.js";

export function nameConflict(c: Ctx, name: string, ownBox: string): string | null {
  if (!name) return null;
  const low = name.trim().toLowerCase();
  for (const r of c.db.prepare("SELECT * FROM boxes").all() as { box: string }[]) {
    if (r.box === ownBox) continue;
    const b = boxRow(c, r.box);
    if (b && displayName(c, b).trim().toLowerCase() === low) return r.box;
  }
  return null;
}

export function doRegister(c: Ctx, box: string, sessionName: string, platform: string, environment: string, poolCode: string, role = "", overrideName = false, accountId: number | null = null) {
  if (box) {
    if (box === OWNER_BOX || !BOX_RE.test(box)) return { error: "bad_box", detail: "'owner' reserved; " + BOX_RE.source };
    if (!boxRow(c, box)) return { error: "unknown_box", detail: "box ids are assigned by the server. Omit box_id on first registration and SAVE the id you get back; pass it only to re-register." };
  }
  if (!PLATFORMS.includes(platform as never)) return { error: "bad_platform", detail: `declare your platform: one of ${JSON.stringify(PLATFORMS)}. This is mandatory so teammates know what they are talking to.` };
  if (role && !ROLES.includes(role as never)) return { error: "bad_role", detail: `role is optional; one of ${JSON.stringify(ROLES)}` };
  if (!codeRe(c.cfg).test(String(poolCode || ""))) return { error: "bad_pool_code", detail: `pool_code is the ${c.cfg.team.pool_code_digits}-digit code the owner gave you; you cannot enter the waiting pool without it` };
  const prevB = box ? boxRow(c, box) : undefined;
  const sameName = prevB != null && String(sessionName || "").trim().toLowerCase() === (prevB.session_name || "").trim().toLowerCase();
  const clash = sameName ? null : nameConflict(c, String(sessionName || ""), box);
  if (clash && !overrideName)
    return { error: "name_taken", conflict_with: clash, directive: `NAME COLLISION: another member already displays as this name (box ${clash}). TELL THE OWNER and ask how to proceed. If the owner explicitly approves the duplicate, call register_box again with override_name=true; otherwise pick a different session_name.` };
  if (!box) { do { box = "bx-" + randHex(3); } while (boxRow(c, box)); }
  const b = boxRow(c, box);
  const status = !(b && b.team_code) ? "waiting" : b.status;
  touchBox(c, box, { session_name: String(sessionName || "").slice(0, 200), platform, env: String(environment || "").slice(0, 500), status, role });
  c.db.prepare("UPDATE boxes SET pool_code=?, account_id=? WHERE box=?").run(String(poolCode), accountId, box);
  return {
    ok: true, box, status, pool_code: String(poolCode), role: role || "(none)",
    say_to_owner: `Joined ${c.cfg.brand.name} pool ${poolCode} as ${box} (${platform}). I am now listening for team mail — interrupt me anytime. When everyone has joined, tell any one session to run the crew setup.`,
    directive: `YOUR BOX ID IS ${box} — SAVE IT, it is your permanent address (re-register with box_id=${box} after restarts). THEN ENTER THE LISTENING LOOP IMMEDIATELY AND STAY IN IT: call check_mail(${box}, wait_seconds=50) again and again for as long as this turn lasts — an idle crew member that ends its turn is deaf, and a team of deaf members is dead. Only leave the loop to act on mail, then return to it. REGISTERED INTO WAITING POOL ${poolCode}. When the owner initializes the team you will receive a SYSTEM NOTICE with your member number and team id.`,
  };
}

export function doPool(c: Ctx, poolCode: string) {
  if (!codeRe(c.cfg).test(String(poolCode))) return { error: "bad_pool_code" };
  const rows = c.db.prepare("SELECT * FROM boxes WHERE status='waiting' AND pool_code=? ORDER BY created_ts").all(String(poolCode)) as { box: string; session_name: string; platform: string; role: string; env: string; created_ts: string; last_seen: string }[];
  return { pool_code: String(poolCode), waiting_count: rows.length, waiting: rows.map((r) => ({ box: r.box, session_name: r.session_name, platform: r.platform || "unknown", role: r.role || "(none)", environment: r.env, registered: r.created_ts, last_seen: r.last_seen })) };
}

export interface Member {
  member_no: number; box: string; display_name: string; alias_explicit: boolean;
  session_name: string; role: string; is_human: boolean; platform: string;
  environment: string; last_seen: string; pending_mail: number; stale: boolean;
}

export function fullMembers(c: Ctx, code: string): Member[] {
  const rows = c.db.prepare("SELECT * FROM boxes WHERE team_code=? ORDER BY member_no").all(code) as BoxRow[];
  const pending = (box: string) => (c.db.prepare("SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL").get(box) as { n: number }).n;
  return rows.map((r) => ({
    member_no: r.member_no ?? 0, box: r.box, display_name: displayName(c, r),
    alias_explicit: !!r.alias, session_name: r.session_name,
    role: r.role || (r.box === OWNER_BOX ? "owner" : ""), is_human: !!r.is_human,
    platform: r.platform || "unknown", environment: r.env, last_seen: r.last_seen,
    pending_mail: pending(r.box), stale: !!r.stale,
  }));
}

export function teamRoster(c: Ctx, code: string, view = "full") {
  const t = c.db.prepare("SELECT * FROM teams WHERE code=?").get(code) as { name: string; rv: number; coordinator: string } | undefined;
  const members = fullMembers(c, code);
  if (view === "brief") {
    return {
      team_code: code, team_name: t?.name || "", roster_v: t?.rv ?? 1,
      members: members.map((m) => `#${m.member_no} ${m.display_name} · box:${m.box} · ${m.role || "-"} · ${m.is_human ? "human" : m.platform}`),
      pending_total: members.reduce((s, m) => s + m.pending_mail, 0),
      say_to_owner: rosterText(c, code), relay_rule: "",
      // full members included too, so callers that need detail don't re-query
      _members: members,
    } as const;
  }
  return {
    team_code: code, team_name: t?.name || "", coordinator: t?.coordinator || "",
    members, team_card: teamCard(c, code), say_to_owner: rosterText(c, code), relay_rule: "",
  };
}

export function doInitializeTeam(c: Ctx, poolCode: string, coordinatorBox: string) {
  if (!codeRe(c.cfg).test(String(poolCode))) return { error: "bad_pool_code", detail: `pool code is exactly ${c.cfg.team.pool_code_digits} digits` };
  poolCode = String(poolCode);
  const coord = boxRow(c, coordinatorBox);
  if (!coord || coord.status !== "waiting" || coord.pool_code !== poolCode) return { error: "not_in_pool", detail: "coordinator must be registered in this waiting pool" };
  let code: string; do { code = "tm-" + randHex(3); } while (c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code));
  const waiting = c.db.prepare("SELECT * FROM boxes WHERE status='waiting' AND pool_code=? ORDER BY created_ts").all(poolCode) as { box: string }[];
  c.db.prepare("INSERT INTO teams(code,name,pool_code,coordinator,created_ts,view_key) VALUES(?,?,?,?,?,?)").run(code, "", poolCode, coordinatorBox, now(), randHex(3));
  const ordered = [...waiting.filter((b) => b.box === coordinatorBox), ...waiting.filter((b) => b.box !== coordinatorBox)];
  ordered.forEach((b, i) => c.db.prepare("UPDATE boxes SET status='teamed', team_code=?, member_no=? WHERE box=?").run(code, i + 1, b.box));
  ordered.forEach((b, i) => { if (b.box !== coordinatorBox) systemMail(c, b.box, `TEAM FORMED from pool ${poolCode}. You are member #${i + 1} of team ${code} (${ordered.length} members; coordinator: ${coordinatorBox}). KEEP POLLING your box; setup notices will follow. Use list_team('${code}') for the roster. BOARD DISCIPLINE from now on: shared work lives on the team task board (task_add / task_claim / task_progress / task_done), handoff mail auto-files tasks, discovered work gets filed not chased, and when you hold no task you claim a ready one before going idle. Private todo tools are only for micro-steps inside your claimed task. WORKING MODE for plain MCP sessions: while your turn lasts, stay in the check_mail(wait_seconds=50) loop — leave it only to act, then return. A member that ends its turn goes deaf until the human prompts it again.`); });
  // wizard is initialized fresh
  c.db.prepare("INSERT INTO setup_state(team_code,step_id,answers,done,started_ts) VALUES(?,?,?,0,?) ON CONFLICT(team_code) DO UPDATE SET step_id='',answers='{}',done=0").run(code, "", "{}", now());
  return { ok: true, ...teamRoster(c, code), directive: `TEAM CREATED AND YOU ARE THE COORDINATOR (member #1). NOW CALL setup_next("${code}") / setup_questions and RUN THE INTERVIEW. Configuration setters are REFUSED until the interview is finished.` };
}

export function doJoinTeam(c: Ctx, code: string, box: string) {
  code = String(code);
  const t = c.db.prepare("SELECT * FROM teams WHERE code=?").get(code);
  if (!t) return { error: "no_such_team" };
  const b = boxRow(c, box);
  if (!b) return { error: "not_registered", detail: "register_box first" };
  if (b.team_code === code) return { ok: true, already_member: true, ...teamRoster(c, code) };
  const nxt = ((c.db.prepare("SELECT MAX(member_no) m FROM boxes WHERE team_code=?").get(code) as { m: number | null }).m || 0) + 1;
  c.db.prepare("UPDATE boxes SET status='teamed', team_code=?, member_no=? WHERE box=?").run(code, nxt, box);
  bumpRv(c, code);
  broadcastTeam(c, code, `TEAM UPDATE: box '${box}' joined as member #${nxt}.\n\n${teamCard(c, code)}`);
  return { ok: true, member_no: nxt, ...teamRoster(c, code) };
}

// Add a member to a team that already exists (post-setup). A fresh session
// calls this with the TEAM ID directly — no pool round trip. Server mints the
// box, attaches it, and the coordinator can then set its alias/role (setters
// are unlocked once setup is done).
export function doAddMember(c: Ctx, code: string, sessionName: string, platform: string, environment: string, role = "", overrideName = false) {
  code = String(code);
  if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return { error: "no_such_team" };
  if (!PLATFORMS.includes(platform as never)) return { error: "bad_platform", detail: `one of ${JSON.stringify(PLATFORMS)}` };
  if (role && !ROLES.includes(role as never)) return { error: "bad_role", detail: `one of ${JSON.stringify(ROLES)}` };
  const clash = nameConflict(c, String(sessionName || ""), "");
  if (clash && !overrideName)
    return { error: "name_taken", conflict_with: clash, directive: `NAME COLLISION with box ${clash}. Tell the owner; retry with override_name=true only on their approval, or pick another name.` };
  let box: string; do { box = "bx-" + randHex(3); } while (boxRow(c, box));
  const nxt = ((c.db.prepare("SELECT MAX(member_no) m FROM boxes WHERE team_code=?").get(code) as { m: number | null }).m || 0) + 1;
  touchBox(c, box, { session_name: String(sessionName || "").slice(0, 200), platform, env: String(environment || "").slice(0, 500), status: "teamed", role });
  c.db.prepare("UPDATE boxes SET team_code=?, member_no=? WHERE box=?").run(code, nxt, box);
  bumpRv(c, code);
  broadcastTeam(c, code, `TEAM UPDATE: ${displayName(c, boxRow(c, box))} (box ${box}) joined as member #${nxt}, ${platform}.\n\n${teamCard(c, code)}`);
  return {
    ok: true, box, member_no: nxt,
    say_to_owner: `Joined team ${code} as member #${nxt} (${box}). I am listening now.`,
    directive: `YOUR BOX ID IS ${box} — SAVE IT. ENTER THE LISTENING LOOP: check_mail(${box}, wait_seconds=50) repeatedly. The coordinator can name you (set_member_alias) and set your role. Board discipline applies.`,
  };
}

export function doSetTeamName(c: Ctx, code: string, name: string) {
  code = String(code);
  if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(code)) return { error: "no_such_team" };
  c.db.prepare("UPDATE teams SET name=? WHERE code=?").run(String(name).slice(0, 100), code);
  bumpRv(c, code);
  broadcastTeam(c, code, `SETUP CHANGE: team ${code} is now named '${name}'. Unaliased members display as '<name>-<no>'.\n\n${teamCard(c, code)}`);
  return { ok: true, ...teamRoster(c, code) };
}

export function doSetMemberAlias(c: Ctx, code: string, memberNo: number, alias: string, overrideName = false) {
  code = String(code);
  const r = c.db.prepare("SELECT * FROM boxes WHERE team_code=? AND member_no=?").get(code, Number(memberNo)) as { box: string } | undefined;
  if (!r) return { error: "no_such_member" };
  const clash = nameConflict(c, String(alias || ""), r.box);
  if (clash && !overrideName)
    return { error: "name_taken", conflict_with: clash, directive: `NAME COLLISION: another member already displays as this name (box ${clash}). READ THIS TO THE OWNER; only if the owner explicitly approves the duplicate, call again with override_name=true.` };
  c.db.prepare("UPDATE boxes SET alias=? WHERE box=?").run(String(alias).slice(0, 200), r.box);
  bumpRv(c, code);
  broadcastTeam(c, code, `SETUP CHANGE: member #${memberNo} (${r.box}) is now named '${alias}'.\n\n${teamCard(c, code)}`);
  return { ok: true, ...teamRoster(c, code) };
}

export function doSetBoxRole(c: Ctx, code: string, memberNo: number, role: string) {
  code = String(code);
  if (!ROLES.includes(role as never)) return { error: "bad_role", detail: `one of ${JSON.stringify(ROLES)}` };
  const r = c.db.prepare("SELECT * FROM boxes WHERE team_code=? AND member_no=?").get(code, Number(memberNo)) as { box: string } | undefined;
  if (!r) return { error: "no_such_member" };
  c.db.prepare("UPDATE boxes SET role=? WHERE box=?").run(role, r.box);
  bumpRv(c, code);
  const extra = role === "worker" ? "HARD RULE now active for this member: workers never contact the owner; they report to the manager." : "This member now handles owner contact for the team.";
  broadcastTeam(c, code, `SETUP CHANGE: member #${memberNo} (${r.box}) role = ${role.toUpperCase()}. ${extra}\n\n${teamCard(c, code)}`);
  return { ok: true, ...teamRoster(c, code) };
}

export function doBoxes(c: Ctx) {
  const result: Record<string, unknown> = {};
  for (const b of c.db.prepare("SELECT * FROM boxes ORDER BY box").all() as never[]) {
    const bb = b as { box: string; is_human: number; platform: string; role: string; status: string; team_code: string | null; member_no: number | null; last_seen: string };
    const pending = (c.db.prepare("SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL").get(bb.box) as { n: number }).n;
    result[bb.box] = { display_name: displayName(c, boxRow(c, bb.box)) || null, platform: bb.is_human ? "human" : bb.platform || "unknown", role: bb.role || null, status: bb.status, team: bb.team_code, member_no: bb.member_no, pending, last_seen: bb.last_seen };
  }
  return result;
}
