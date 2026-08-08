// The board and the roster rendered as DATA, not as the CLI text blob sessions
// read. The relay's text renderings exist for agents; a human looking at a screen
// gets columns, states and relative times.
import type { Ctx } from "../core/context.js";
import { esc } from "./theme.js";
import { icon } from "./icons.js";
import { fullMembers } from "../core/teams.js";

interface TaskRow {
  id: number; title: string; detail: string; deps: string; owner: string | null;
  status: string; priority: number; result: string; last_note: string;
  stalled: number; updated_ts: string;
}

export const ago = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATUS: Record<string, string> = { open: "chip", claimed: "chip on", done: "chip good", blocked: "chip warn" };

export function renderBoard(c: Ctx, code: string, opts: { readOnly?: boolean } = {}): string {
  const rows = c.db.prepare("SELECT * FROM tasks WHERE team=? ORDER BY (status='done'), priority, id").all(code) as TaskRow[];
  if (!rows.length) {
    return `<p class="empty">No tasks yet.${opts.readOnly ? "" : " Sessions file them as they work — a handoff message opens one automatically."}</p>`;
  }
  const who = new Map(fullMembers(c, code).map((m) => [m.box, m.display_name]));
  const body = rows.map((t) => {
    const deps = (() => { try { return JSON.parse(t.deps) as number[]; } catch { return []; } })();
    const blocked = deps.filter((d) => {
      const r = c.db.prepare("SELECT status FROM tasks WHERE id=?").get(d) as { status: string } | undefined;
      return r && r.status !== "done";
    });
    const state = t.stalled ? `<span class="chip bad">stalled</span>` : `<span class="${STATUS[t.status] || "chip"}">${esc(t.status)}</span>`;
    const note = t.status === "done" ? t.result : t.last_note;
    return `<tr>
      <td class="num">#${t.id}</td>
      <td><div class="ttitle">${esc(t.title)}</div>
        ${note ? `<div class="small muted">${esc(note.slice(0, 160))}</div>` : ""}
        ${blocked.length ? `<div class="small muted">waiting on ${blocked.map((d) => `#${d}`).join(", ")}</div>` : ""}</td>
      <td>${t.owner ? esc(who.get(t.owner) || t.owner) : `<span class="muted">unclaimed</span>`}</td>
      <td>${state}</td>
      <td class="small muted">${esc(ago(t.updated_ts))}</td></tr>`;
  }).join("");
  return `<table class="board-t"><thead><tr><th></th><th>Task</th><th>Owner</th><th>State</th><th>Updated</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function renderRoster(c: Ctx, code: string): string {
  const members = fullMembers(c, code);
  if (!members.length) return `<p class="empty">No members yet.</p>`;
  const body = members.map((m) => {
    const kind = m.is_human ? "human" : m.platform || "—";
    const tail = [
      m.pending_mail ? `<span class="chip">${m.pending_mail} unread</span>` : "",
      m.stale ? `<span class="chip bad">needs attention</span>` : "",
    ].filter(Boolean).join(" ");
    return `<tr>
      <td class="num">#${m.member_no ?? "—"}</td>
      <td><div class="ttitle">${esc(m.display_name)}</div><div class="small muted">${esc(m.box)}</div></td>
      <td>${esc(kind)}</td>
      <td>${m.role ? esc(m.role) : `<span class="muted">unassigned</span>`}</td>
      <td>${tail}</td></tr>`;
  }).join("");
  return `<table class="board-t"><thead><tr><th></th><th>Member</th><th>Platform</th><th>Role</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}

export { icon };
