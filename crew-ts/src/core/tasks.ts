// Shared task board: atomic claim, dependency unblocking, stall detection.
import { now } from "../db.js";
import { type Ctx, OWNER_BOX, boxRow, displayName, systemMail, teamManagerBox } from "./context.js";

export interface TaskRow {
  id: number; team: string; title: string; detail: string; deps: string;
  owner: string | null; status: string; priority: number; result: string;
  last_note: string; created_by: string; discovered_from: number | null;
  stalled: number; created_ts: string; updated_ts: string;
}

export const taskRow = (c: Ctx, id: number): TaskRow | undefined =>
  c.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;

export function taskDepsDone(c: Ctx, t: { deps: string }): boolean {
  const deps: number[] = JSON.parse(t.deps);
  if (!deps.length) return true;
  const r = c.db.prepare(`SELECT count(*) n FROM tasks WHERE id IN (${deps.map(() => "?").join(",")}) AND status='done'`).get(...deps) as { n: number };
  return r.n === deps.length;
}

export function doTaskAdd(c: Ctx, team: string, title: string, detail: string, createdBy: string, deps: number[] | null = null, assignTo = "", priority = 2, discoveredFrom: number | null = null) {
  team = String(team);
  if (!c.db.prepare("SELECT 1 FROM teams WHERE code=?").get(team)) return { error: "no_such_team" };
  if (!String(title).trim()) return { error: "empty_title" };
  let d = deps || [];
  if (!Array.isArray(d)) return { error: "bad_deps", detail: "deps is a list of task ids" };
  if (d.length > 64) return { error: "bad_deps", detail: "at most 64 dependencies per task" };
  d = d.map(Number);
  if (d.some((x) => !Number.isInteger(x))) return { error: "bad_deps" };
  for (const dep of d) { const r = taskRow(c, dep); if (!r || r.team !== team) return { error: "bad_deps", detail: `no task #${dep} in this team` }; }
  if (assignTo) {
    const a = boxRow(c, assignTo);
    if (!a || a.team_code !== team) return { error: "bad_assignee", detail: "assign_to must be a member box of this team" };
    const cb = boxRow(c, createdBy);
    if (cb && cb.role === "worker" && assignTo !== createdBy)
      return { error: "chain_of_command", directive: "HARD RULE: workers do not assign work to others. Add the task unassigned (anyone claims), reserve it for yourself, or send a `question` to your MANAGER proposing the assignment." };
  }
  priority = Number(priority);
  if (![1, 2, 3].includes(priority)) return { error: "bad_priority", detail: "1=high 2=normal 3=low" };
  if (discoveredFrom != null && !taskRow(c, discoveredFrom)) return { error: "bad_discovered_from" };
  const info = c.db.prepare(
    "INSERT INTO tasks(team,title,detail,deps,owner,status,priority,created_by,discovered_from,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(team, String(title).slice(0, 200), String(detail).slice(0, 2000), JSON.stringify(d), assignTo || null, "open", priority, createdBy, discoveredFrom, now(), now());
  const tid = Number(info.lastInsertRowid);
  const t = taskRow(c, tid)!;
  if (assignTo && taskDepsDone(c, t))
    systemMail(c, assignTo, `TASK ASSIGNED: #${tid} "${title}" is reserved for you and ready now. Claim it with task_claim(${tid}, your_box) when you start.`);
  return { ok: true, task_id: tid, ready: taskDepsDone(c, t) && !assignTo, reserved_for: assignTo || null };
}

export function doTaskClaim(c: Ctx, tid: number, box: string) {
  const t = taskRow(c, tid);
  if (!t) return { error: "no_such_task" };
  const b = boxRow(c, box);
  if (!b || b.team_code !== t.team) return { error: "not_a_member" };
  if (t.status === "done") return { error: "already_done" };
  if (t.status === "claimed") return { error: "already_claimed", by: t.owner, directive: "Someone beat you to it. Call task_list to pick another ready task — do NOT start this one." };
  if (t.owner && t.owner !== box) return { error: "reserved", for: t.owner };
  if (!taskDepsDone(c, t)) return { error: "blocked", deps: JSON.parse(t.deps).filter((d: number) => (taskRow(c, d)?.status ?? "") !== "done") };
  const info = c.db.prepare("UPDATE tasks SET owner=?, status='claimed', stalled=0, updated_ts=? WHERE id=? AND status='open' AND (owner IS NULL OR owner=?)").run(box, now(), tid, box);
  if (info.changes === 0) { const t2 = taskRow(c, tid)!; return { error: "already_claimed", by: t2.owner, directive: "Someone beat you to it; pick another ready task." }; }
  return { ok: true, task_id: tid, title: t.title, detail: t.detail, directive: "Task claimed. Break it into micro-steps with your session's own todo tools if you like — but the board holds only THIS shared unit. task_progress a one-line note at least hourly so it never shows stalled, and task_done(result=...) the moment it is finished — a forgotten close is the #1 way agent teams jam." };
}

export function doTaskProgress(c: Ctx, tid: number, box: string, note: string) {
  const t = taskRow(c, tid);
  if (!t) return { error: "no_such_task" };
  if (t.owner !== box || t.status !== "claimed") return { error: "not_yours" };
  c.db.prepare("UPDATE tasks SET last_note=?, stalled=0, updated_ts=? WHERE id=?").run(String(note).slice(0, 300), now(), tid);
  return { ok: true };
}

export function doTaskDone(c: Ctx, tid: number, box: string, result: string) {
  const t = taskRow(c, tid);
  if (!t) return { error: "no_such_task" };
  const b = boxRow(c, box);
  const isMgr = b && b.team_code === t.team && b.role === "manager";
  if (t.owner !== box && !isMgr) return { error: "not_yours", detail: "only the claimer or the manager may close a task" };
  if (t.status === "done") return { ok: true, already: true };
  c.db.prepare("UPDATE tasks SET status='done', result=?, stalled=0, updated_ts=? WHERE id=?").run(String(result).slice(0, 1000), now(), tid);
  const unlocked: TaskRow[] = [];
  for (const r of c.db.prepare("SELECT * FROM tasks WHERE team=? AND status='open'").all(t.team) as TaskRow[])
    if (JSON.parse(r.deps).includes(tid) && taskDepsDone(c, r)) unlocked.push(r);
  for (const r of unlocked) {
    if (r.owner) systemMail(c, r.owner, `TASK UNBLOCKED: #${r.id} "${r.title}" was waiting on #${tid} and is now ready. It is reserved for you — claim it when you start.`);
    else { const mgr = teamManagerBox(c, t.team); if (mgr) systemMail(c, mgr, `TASK UNBLOCKED: #${r.id} "${r.title}" is now ready and unassigned. Assign it or let someone self-claim.`); }
  }
  const nxt = (c.db.prepare("SELECT * FROM tasks WHERE team=? AND status='open' ORDER BY priority, id").all(t.team) as TaskRow[])
    .filter((r) => taskDepsDone(c, r) && (!r.owner || r.owner === box)).slice(0, 5).map((r) => ({ id: r.id, title: r.title }));
  return { ok: true, task_id: tid, unblocked: unlocked.map((r) => r.id), next_ready: nxt, directive: "Task closed. SELF-CLAIM RULE: if next_ready lists anything, claim one and keep working; only go idle when it is empty. Check mail first in case priorities changed." };
}

export function boardText(c: Ctx, team: string): string {
  const rows = c.db.prepare("SELECT * FROM tasks WHERE team=? ORDER BY priority, id").all(team) as TaskRow[];
  if (!rows.length) return `task board · ${team}\n  (no tasks yet — task_add to create one)`;
  const ready: string[] = [], working: string[] = [], blocked: string[] = [], done: string[] = [];
  for (const t of rows) {
    const pr = t.priority === 1 ? " !high" : t.priority === 3 ? " ~low" : "";
    if (t.status === "done") done.push(`  ✓ #${t.id} ${t.title}${t.result ? ` — ${t.result.slice(0, 60)}` : ""}`);
    else if (t.status === "claimed") {
      let age = "";
      try { const mins = Math.floor((Date.now() - new Date(t.updated_ts).getTime()) / 60000); age = `, ${mins}m since update`; } catch { /* noop */ }
      const o = boxRow(c, t.owner!); const who = o ? displayName(c, o) : t.owner;
      working.push(`  ▶ #${t.id}${pr} ${t.title} (${who}${age})${t.stalled ? " ⚠STALLED" : ""}${t.last_note ? ` — ${t.last_note}` : ""}`);
    } else if (taskDepsDone(c, t)) ready.push(`  ○ #${t.id}${pr} ${t.title}${t.owner ? ` [reserved: ${t.owner}]` : ""}`);
    else { const pend = JSON.parse(t.deps).filter((d: number) => (taskRow(c, d)?.status ?? "") !== "done"); blocked.push(`  ⊘ #${t.id}${pr} ${t.title} (waiting on #${pend.join(", #")})`); }
  }
  const out = [`task board · ${team}`];
  if (ready.length) { out.push("READY TO CLAIM:"); out.push(...ready); }
  if (working.length) { out.push("IN PROGRESS:"); out.push(...working); }
  if (blocked.length) { out.push("BLOCKED:"); out.push(...blocked); }
  if (done.length) { out.push(`DONE (${done.length}):`); out.push(...done.slice(-5)); }
  return out.join("\n");
}

export function taskStallSweep(c: Ctx): void {
  for (const t of c.db.prepare("SELECT * FROM tasks WHERE status='claimed' AND stalled=0").all() as TaskRow[]) {
    let idle: number;
    try { idle = (Date.now() - new Date(t.updated_ts).getTime()) / 1000; } catch { continue; }
    if (idle > c.cfg.timers.task_stall_after_s) {
      c.db.prepare("UPDATE tasks SET stalled=1 WHERE id=?").run(t.id);
      const mgr = teamManagerBox(c, t.team); const o = boxRow(c, t.owner!);
      for (const target of new Set([mgr, t.owner].filter(Boolean) as string[]))
        systemMail(c, target, `TASK STALLED: #${t.id} "${t.title}" (claimed by ${o ? displayName(c, o) : t.owner}) has had no progress note for ${Math.floor(idle / 3600)}h+. If it is actually done, close it with task_done; if abandoned, the manager should reassign it.`);
    }
  }
}
