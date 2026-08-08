// Honest liveness: tells a dead watcher apart from a pull-only member that is
// simply between turns (normal, never flagged).
import { type Ctx, type BoxRow, boxRow, displayName, systemMail, teamManagerBox } from "./context.js";
import { taskStallSweep } from "./tasks.js";

export function pollProfile(c: Ctx, b: BoxRow): ["never_polled" | "watcher_live" | "watcher_down" | "pull_only", number | null] {
  if (!b.last_poll) return ["never_polled", null];
  let idle: number;
  try { idle = Math.floor((Date.now() - new Date(b.last_poll).getTime()) / 1000); } catch { return ["never_polled", null]; }
  let gap: number | null = null;
  if (b.prev_poll) { try { gap = (new Date(b.last_poll).getTime() - new Date(b.prev_poll).getTime()) / 1000; } catch { gap = null; } }
  const watcher = gap != null && gap < c.cfg.timers.watcher_gap_s;
  if (watcher) return [idle <= c.cfg.timers.stale_after_s ? "watcher_live" : "watcher_down", idle];
  return ["pull_only", idle];
}

export function staleSweep(c: Ctx): void {
  for (const b of c.db.prepare("SELECT * FROM boxes WHERE team_code IS NOT NULL AND is_human=0").all() as BoxRow[]) {
    const [mode, idle] = pollProfile(c, b);
    const mgr = teamManagerBox(c, b.team_code!);
    const held = (c.db.prepare("SELECT id,title FROM tasks WHERE owner=? AND status='claimed'").all(b.box) as { id: number; title: string }[]).map((t) => `#${t.id} ${t.title}`);
    const unread = (c.db.prepare("SELECT count(*) n FROM deliveries WHERE recipient=? AND taken_ts IS NULL").get(b.box) as { n: number }).n;
    let problem = false, why = "";
    if (mode === "watcher_down") { problem = true; why = `WATCHER DOWN: ${displayName(c, b)} (box ${b.box}, #${b.member_no}) was receiving mail through a watcher and has not polled for ${Math.floor(idle! / 60)} min — delivery to them has most likely stopped.`; }
    else if (mode === "pull_only" && idle != null && idle > c.cfg.timers.quiet_after_s && (held.length || unread)) { problem = true; why = `MEMBER QUIET: ${displayName(c, b)} (box ${b.box}, #${b.member_no}) is a pull-only session — normal for it to be silent between turns — but it has not checked in for ${Math.floor(idle / 3600)}h while holding work.`; }
    if (problem && !b.stale) {
      c.db.prepare("UPDATE boxes SET stale=1 WHERE box=?").run(b.box);
      if (mgr && mgr !== b.box) { let extra = held.length ? " Claimed tasks: " + held.join("; ") + " — consider reassigning." : ""; if (unread) extra += ` ${unread} message(s) unread.`; systemMail(c, mgr, why + extra); }
    } else if (!problem && b.stale) {
      c.db.prepare("UPDATE boxes SET stale=0 WHERE box=?").run(b.box);
      if (mgr && mgr !== b.box) systemMail(c, mgr, `MEMBER BACK: ${displayName(c, b)} (box ${b.box}) is active again.`);
    }
  }
}

export function startSweeps(c: Ctx): void {
  setInterval(() => { try { staleSweep(c); } catch { /* noop */ } try { taskStallSweep(c); } catch { /* noop */ } }, c.cfg.timers.sweep_interval_s * 1000).unref();
}
