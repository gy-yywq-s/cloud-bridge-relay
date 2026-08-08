// Web UI design system, distilled from ode.gaelisus.com: pure-white surface,
// non-serif type, warm layered shadows, spring motion. The ENTIRE palette is
// driven by CSS custom properties; recolor by swapping --accent (and, if you
// like, the neutrals) in one place — nothing else references a raw colour.
import type { Config } from "../config.js";

export function themeCss(cfg: Config): string {
  const accent = cfg.brand.accent || "#1c4f8f";
  return `
:root{
  --sans: ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif;
  --mono: ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  /* ── swap these to rebrand ──────────────────────────────── */
  --accent: ${accent};
  --paper: #ffffff;        /* main surface — pure white per spec */
  /* ───────────────────────────────────────────────────────── */
  --paper-2:#f6f5f3; --paper-3:#eceae6;
  --ink:#191714; --ink-2:#55514a; --ink-3:#8c877e;
  --rule:#e4e1db; --rule-2:#efedea;
  --accent-bg:color-mix(in srgb, var(--accent) 10%, #fff);
  --accent-ink:color-mix(in srgb, var(--accent) 78%, #000);
  --good:#216b45; --warn:#a8600f; --bad:#b02a37;
  --cast:0 1px 2px rgba(30,24,12,.05),0 5px 16px rgba(30,24,12,.08);
  --cast-2:0 2px 4px rgba(30,24,12,.07),0 12px 30px rgba(30,24,12,.12);
  --fast:130ms; --mid:240ms; --slow:420ms;
  --ease:cubic-bezier(.22,.61,.36,1); --spring:cubic-bezier(.2,.9,.3,1.06);
  --r:12px; --r-sm:8px; --r-chip:999px;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#15140f; --paper-2:#1e1d17; --paper-3:#272620;
  --ink:#eceae4; --ink-2:#aba69c; --ink-3:#7c776d; --rule:#33322a; --rule-2:#262620;
  --accent-bg:color-mix(in srgb, var(--accent) 22%, #15140f);
  --accent-ink:color-mix(in srgb, var(--accent) 60%, #fff);
  --cast:0 1px 2px rgba(0,0,0,.3),0 6px 18px rgba(0,0,0,.4);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans);
  -webkit-font-smoothing:antialiased;}
a{color:var(--accent-ink);text-decoration:none} a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 80px}
.brandbar{display:flex;align-items:center;gap:10px;padding:14px 0 22px;border-bottom:1px solid var(--rule);margin-bottom:26px}
/* centered single-column shell for auth screens (login / signup / consent) */
.authwrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px 20px}
.authbrand{display:inline-flex;align-items:center;gap:10px;text-decoration:none}
.authbrand:hover{text-decoration:none}
.authwrap .card{width:100%;max-width:400px;margin:0}
.authwrap .btn{width:100%;justify-content:center}
.authwrap h1{font-size:22px;margin:0 0 6px}
.altlink{font-size:13px;color:var(--ink-2);margin:16px 0 0;text-align:center}
.mark{width:26px;height:26px;display:inline-flex;flex:0 0 auto}
.mark svg{width:100%;height:100%;display:block;border-radius:7px}
.logo{font:700 20px/1 var(--mono);letter-spacing:-.02em}
.logo::after{content:"_";color:var(--accent)}
.muted{color:var(--ink-3)} .small{font-size:13px}
h1{font-size:24px;letter-spacing:-.01em;margin:0 0 4px} h2{font-size:16px;margin:26px 0 10px}
.card{background:var(--paper);border:1px solid var(--rule);border-radius:var(--r);
  box-shadow:var(--cast);padding:18px 20px;margin:14px 0;animation:rise var(--slow) var(--ease) both}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1}
label{display:block;font-size:13px;color:var(--ink-2);margin:12px 0 5px;font-weight:600}
input,select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--paper-2);
  border:1px solid var(--rule);border-radius:var(--r-sm);padding:10px 12px;transition:border-color var(--mid) var(--ease),box-shadow var(--mid) var(--ease)}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.btn{display:inline-flex;align-items:center;gap:8px;font:600 14px/1 var(--sans);cursor:pointer;
  background:var(--accent);color:#fff;border:0;border-radius:var(--r-sm);padding:11px 18px;
  transition:transform var(--fast) var(--spring),filter var(--mid) var(--ease)}
.btn:hover{filter:brightness(1.06)} .btn:active{transform:scale(.97)}
.btn.ghost{background:var(--paper-2);color:var(--ink);border:1px solid var(--rule)}
.btn.gh{background:#1f2328;color:#fff}
.chip{display:inline-block;font:600 11px/1 var(--mono);letter-spacing:.03em;padding:4px 9px;border-radius:var(--r-chip)}
.chip.on{background:var(--accent-bg);color:var(--accent-ink)}
.chip.good{background:color-mix(in srgb,var(--good) 14%,#fff);color:var(--good)}
.chip.warn{background:color-mix(in srgb,var(--warn) 16%,#fff);color:var(--warn)}
.chip.bad{background:color-mix(in srgb,var(--bad) 14%,#fff);color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:600 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);padding:8px 10px 8px 0;border-bottom:1.5px solid var(--ink)}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--rule-2);vertical-align:top}
tr{animation:rowIn var(--mid) var(--ease) both}
pre{font:12.5px/1.55 var(--mono);background:var(--paper-2);border:1px solid var(--rule);border-radius:var(--r-sm);padding:12px 14px;overflow-x:auto;white-space:pre-wrap}
.err{color:var(--bad);font-size:13px;margin:8px 0}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--ink);color:var(--paper);
  padding:11px 18px;border-radius:var(--r-sm);box-shadow:var(--cast-2);animation:toastIn var(--slow) var(--spring) both;font-size:14px}
.sep{height:1px;background:var(--rule);margin:16px 0}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes rowIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes toastIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
}

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The crew mark: a terminal prompt chevron + stacked message lines + cursor
// underscore. Built from the configured accent so it recolors with the theme
// (see assets/icon.svg for the master used by the GitHub app / app icon).
export function markSvg(accent: string, tile = true): string {
  const t = tile ? `<rect width="32" height="32" rx="7" fill="${accent}"/>` : "";
  const fg = tile ? "#fff" : accent;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${t}` +
    `<path fill="${fg}" d="m6.5 8.5 7.5 7.5-7.5 7.5L4 21l5-5-5-5z"/>` +
    `<rect x="15" y="10" width="12" height="3.5" rx="1.75" fill="${fg}"/>` +
    `<rect x="15" y="15" width="8.5" height="3.5" rx="1.75" fill="${fg}"/>` +
    `<rect x="21" y="21" width="6" height="3" rx="1.5" fill="${fg}"/></svg>`;
}

function faviconLink(cfg: Config): string {
  const uri = "data:image/svg+xml," + encodeURIComponent(markSvg(cfg.brand.accent || "#1c4f8f"));
  return `<link rel="icon" type="image/svg+xml" href="${uri}"><link rel="apple-touch-icon" href="${uri}">`;
}

export function page(cfg: Config, title: string, bodyHtml: string, opts: { toast?: string } = {}): string {
  const toast = opts.toast ? `<div class="toast">${esc(opts.toast)}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(cfg.brand.name)}</title>
${faviconLink(cfg)}
<style>${themeCss(cfg)}</style></head>
<body><div class="wrap">
<div class="brandbar"><span class="mark" aria-hidden="true">${markSvg(cfg.brand.accent || "#1c4f8f")}</span><span class="logo">${esc(cfg.brand.name)}</span><span class="muted small">${esc(title)}</span></div>
${bodyHtml}
</div>${toast}</body></html>`;
}

// Centered single-card shell for the auth screens (login / signup / consent /
// auth errors). Brand mark sits above the card; nothing is left-aligned.
export function authPage(cfg: Config, title: string, cardHtml: string, opts: { toast?: string } = {}): string {
  const toast = opts.toast ? `<div class="toast">${esc(opts.toast)}</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(cfg.brand.name)}</title>
${faviconLink(cfg)}
<style>${themeCss(cfg)}</style></head>
<body><div class="authwrap">
<a class="authbrand" href="/"><span class="mark" aria-hidden="true">${markSvg(cfg.brand.accent || "#1c4f8f")}</span><span class="logo">${esc(cfg.brand.name)}</span></a>
${cardHtml}
</div>${toast}</body></html>`;
}

export { esc };
