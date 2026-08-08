// Runtime-tunable relay settings, editable from the web UI and persisted in the
// settings table. These are the values that used to be reachable only by editing
// crew.toml and restarting — the rate limits, liveness timers and team defaults
// every session is judged by. Overrides are applied onto the live Config object
// at boot and on save, so a change takes effect immediately everywhere.
import type { Ctx } from "../core/context.js";
import type { Config } from "../config.js";

export interface Tunable {
  key: string;            // settings key, e.g. "limits.rate_n"
  label: string;
  group: "limits" | "timers" | "team";
  hint: string;
  min: number; max: number;
  unit?: string;
  get: (c: Config) => number;
  set: (c: Config, v: number) => void;
}

export const TUNABLES: Tunable[] = [
  { key: "limits.rate_n", group: "limits", label: "Messages per window", hint: "Sends allowed per sender before the relay refuses (loudly).", min: 1, max: 1000,
    get: (c) => c.limits.rate_n, set: (c, v) => { c.limits.rate_n = v; } },
  { key: "limits.rate_window_s", group: "limits", label: "Rate window", unit: "s", hint: "Length of that window.", min: 10, max: 86400,
    get: (c) => c.limits.rate_window_s, set: (c, v) => { c.limits.rate_window_s = v; } },
  { key: "limits.max_queue", group: "limits", label: "Max queued messages", hint: "Cap on undelivered mail per mailbox.", min: 10, max: 100000,
    get: (c) => c.limits.max_queue, set: (c, v) => { c.limits.max_queue = v; } },
  { key: "limits.max_wait_s", group: "limits", label: "Max long-poll wait", unit: "s", hint: "Longest a session may hold a check_mail call open.", min: 5, max: 300,
    get: (c) => c.limits.max_wait_s, set: (c, v) => { c.limits.max_wait_s = v; } },
  { key: "limits.prune_days", group: "limits", label: "Keep history", unit: "days", hint: "How long delivered mail is retained.", min: 1, max: 3650,
    get: (c) => c.limits.prune_days, set: (c, v) => { c.limits.prune_days = v; } },

  { key: "timers.stale_after_s", group: "timers", label: "Watcher stale after", unit: "s", hint: "A watching session silent this long is reported as down.", min: 60, max: 86400,
    get: (c) => c.timers.stale_after_s, set: (c, v) => { c.timers.stale_after_s = v; } },
  { key: "timers.quiet_after_s", group: "timers", label: "Quiet member after", unit: "s", hint: "A pull-only member holding work but silent this long is flagged.", min: 300, max: 604800,
    get: (c) => c.timers.quiet_after_s, set: (c, v) => { c.timers.quiet_after_s = v; } },
  { key: "timers.task_stall_after_s", group: "timers", label: "Task stalled after", unit: "s", hint: "A claimed task with no progress this long is flagged to the manager.", min: 300, max: 604800,
    get: (c) => c.timers.task_stall_after_s, set: (c, v) => { c.timers.task_stall_after_s = v; } },
  { key: "timers.watcher_gap_s", group: "timers", label: "Watcher poll gap", unit: "s", hint: "Polls closer than this mark a session as a live watcher.", min: 10, max: 3600,
    get: (c) => c.timers.watcher_gap_s, set: (c, v) => { c.timers.watcher_gap_s = v; } },

  { key: "team.pool_code_digits", group: "team", label: "Pool code digits", hint: "Length of the join code sessions use to find each other.", min: 3, max: 8,
    get: (c) => c.team.pool_code_digits, set: (c, v) => { c.team.pool_code_digits = v; } },
  { key: "team.board_refresh_s", group: "team", label: "Board refresh", unit: "s", hint: "How often the web board reloads.", min: 3, max: 600,
    get: (c) => c.team.board_refresh_s, set: (c, v) => { c.team.board_refresh_s = v; } },
];

export const GROUP_LABEL: Record<string, string> = { limits: "Limits", timers: "Liveness timers", team: "Team defaults" };

export function applyConfigOverrides(ctrl: Ctx): void {
  try {
    const rows = ctrl.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    for (const t of TUNABLES) {
      const raw = map.get(t.key);
      if (raw == null) continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v >= t.min && v <= t.max) t.set(ctrl.cfg, Math.round(v));
    }
    const om = map.get("team.default_owner_mode");
    if (om && ["a", "b", "c", "d"].includes(om)) ctrl.cfg.team.default_owner_mode = om as Config["team"]["default_owner_mode"];
  } catch { /* settings table may not exist yet */ }
}

// Persist + apply. Returns the number of values changed.
export function saveTunables(ctrl: Ctx, form: Record<string, unknown>): number {
  const up = ctrl.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  let n = 0;
  for (const t of TUNABLES) {
    const raw = form[t.key];
    if (raw == null || String(raw).trim() === "") continue;
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v) || v < t.min || v > t.max) continue;
    if (t.get(ctrl.cfg) !== v) n++;
    t.set(ctrl.cfg, v);
    up.run(t.key, String(v));
  }
  const om = String(form["team.default_owner_mode"] || "");
  if (["a", "b", "c", "d"].includes(om)) {
    if (ctrl.cfg.team.default_owner_mode !== om) n++;
    ctrl.cfg.team.default_owner_mode = om as Config["team"]["default_owner_mode"];
    up.run("team.default_owner_mode", om);
  }
  return n;
}
