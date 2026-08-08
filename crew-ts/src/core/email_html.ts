// Minimal, clean HTML email: badge + body + meta table + team card.
import type { Ctx } from "./context.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function emailHtml(
  c: Ctx, badge: string, badgeColor: string, body: string,
  metaRows: [string, string][], card: string,
): string {
  const rows = metaRows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#8a8f98;white-space:nowrap">${esc(k)}</td>` +
    `<td style="padding:2px 0;color:#3c4149">${esc(v)}</td></tr>`).join("");
  const cardHtml = card
    ? `<div style="margin-top:16px;padding:10px 14px;background:#f6f7f8;border-radius:8px;font-size:12px;color:#5e646e;font-family:ui-monospace,Menlo,monospace">${
        card.split("\n").map((l) => `<div style="padding:1px 0">${esc(l)}</div>`).join("")}</div>`
    : "";
  const bodyHtml = body.split("\n\n").map((p) => `<p style="margin:0 0 10px">${esc(p)}</p>`).join("");
  return `<div style="max-width:560px;margin:0 auto;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#1c1e21">
<div style="margin-bottom:14px">
  <span style="display:inline-block;padding:3px 10px;border-radius:99px;background:${badgeColor};color:#fff;font-size:11px;font-weight:600;letter-spacing:.4px">${esc(badge)}</span>
  <span style="margin-left:8px;color:#8a8f98;font-size:12px">${esc(c.cfg.brand.name)}</span>
</div>
<div style="font-size:14px;line-height:1.55">${bodyHtml}</div>
<table style="margin-top:14px;font-size:12px;border-collapse:collapse">${rows}</table>
${cardHtml}
</div>`;
}
