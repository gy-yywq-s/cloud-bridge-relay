// Design system, distilled from ode.gaelisus.com but corrected for crew:
//  • COOL neutrals over pure white (no warm/beige cast).
//  • The accent (a friendly royal blue, swappable at runtime via the settings
//    table) is used ode-style — as a HAIRLINE and a LIGHT TINT, never a heavy
//    fill. Solid accent is reserved for the one primary action per view.
//  • A persistent sidebar shell for signed-in pages; a centered card shell for
//    auth. Line icons, soft cool shadows, spring motion, light+dark, and a
//    working theme toggle.
import { getBrand } from "./brand.js";
import { icon } from "./icons.js";

export function themeCss(): string {
  const accent = getBrand().accent;
  return `
:root{
  --sans: ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif;
  --mono: ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  /* ── swap --accent to rebrand (also settable in Settings) ── */
  --accent:${accent};
  --accent-strong:color-mix(in srgb,var(--accent) 82%,#000);
  --accent-bg:color-mix(in srgb,var(--accent) 8%,#fff);
  --accent-line:color-mix(in srgb,var(--accent) 24%,#fff);
  --ring:color-mix(in srgb,var(--accent) 32%,transparent);
  /* cool neutrals on pure white */
  --paper:#ffffff; --paper-2:#f6f8fb; --paper-3:#eef1f6;
  --ink:#0f172a; --ink-2:#48506a; --ink-3:#8a92a6;
  --rule:#e6e9f0; --rule-2:#eff2f7;
  --good:#0f9d6b; --good-bg:#e7f6ef; --warn:#b4740c; --warn-bg:#fdf1de; --bad:#dc2b3e; --bad-bg:#fdeaec;
  --cast:0 1px 2px rgba(15,23,42,.05),0 4px 12px rgba(15,23,42,.06);
  --cast-2:0 2px 6px rgba(15,23,42,.08),0 18px 44px rgba(15,23,42,.12);
  --fast:130ms; --mid:240ms; --slow:420ms;
  --ease:cubic-bezier(.22,.61,.36,1); --spring:cubic-bezier(.2,.9,.3,1.06);
  --r:14px; --r-sm:9px; --r-chip:999px; --side-w:15.5rem;
}
:root[data-theme="dark"], :root:not([data-theme="light"]){}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0e1118; --paper-2:#161b25; --paper-3:#1e2430;
  --ink:#e8ecf4; --ink-2:#a3abbd; --ink-3:#727a8c; --rule:#262d3a; --rule-2:#1c222d;
  --accent-bg:color-mix(in srgb,var(--accent) 22%,#0e1118);
  --accent-line:color-mix(in srgb,var(--accent) 45%,#0e1118);
  --good-bg:color-mix(in srgb,var(--good) 20%,#0e1118); --warn-bg:color-mix(in srgb,var(--warn) 20%,#0e1118); --bad-bg:color-mix(in srgb,var(--bad) 20%,#0e1118);
  --cast:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.5); --cast-2:0 2px 6px rgba(0,0,0,.5),0 20px 48px rgba(0,0,0,.6);
}}
:root[data-theme="dark"]{
  --paper:#0e1118; --paper-2:#161b25; --paper-3:#1e2430;
  --ink:#e8ecf4; --ink-2:#a3abbd; --ink-3:#727a8c; --rule:#262d3a; --rule-2:#1c222d;
  --accent-bg:color-mix(in srgb,var(--accent) 22%,#0e1118);
  --accent-line:color-mix(in srgb,var(--accent) 45%,#0e1118);
  --good-bg:color-mix(in srgb,var(--good) 20%,#0e1118); --warn-bg:color-mix(in srgb,var(--warn) 20%,#0e1118); --bad-bg:color-mix(in srgb,var(--bad) 20%,#0e1118);
  --cast:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.5); --cast-2:0 2px 6px rgba(0,0,0,.5),0 20px 48px rgba(0,0,0,.6);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent-strong);text-decoration:none} a:hover{text-decoration:underline}
.muted{color:var(--ink-3)} .small{font-size:13px}
h1{font-size:23px;letter-spacing:-.015em;margin:0 0 4px} h2{font-size:15px;margin:0 0 12px;letter-spacing:-.01em}
.ico{flex:0 0 auto;vertical-align:-.18em}

/* ── brand mark ── */
.mark{width:26px;height:26px;display:inline-flex;flex:0 0 auto}
.mark svg{width:100%;height:100%;display:block;border-radius:7px}
.logo{font:700 19px/1 var(--mono);letter-spacing:-.02em;color:var(--ink)}
.logo::after{content:"_";color:var(--accent)}

/* ── controls ── */
label{display:block;font-size:12.5px;color:var(--ink-2);margin:14px 0 5px;font-weight:600}
input,select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--paper);
  border:1px solid var(--rule);border-radius:var(--r-sm);padding:10px 12px;
  transition:border-color var(--mid) var(--ease),box-shadow var(--mid) var(--ease),background var(--mid)}
input:hover,select:hover,textarea:hover{border-color:color-mix(in srgb,var(--ink-3) 50%,var(--rule))}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
input::placeholder{color:var(--ink-3)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:600 14px/1 var(--sans);cursor:pointer;
  background:var(--accent);color:#fff;border:0;border-radius:var(--r-sm);padding:11px 16px;
  transition:transform var(--fast) var(--spring),filter var(--mid) var(--ease),box-shadow var(--mid)}
.btn:hover{filter:brightness(1.07);text-decoration:none} .btn:active{transform:scale(.975)}
.btn:focus-visible{outline:0;box-shadow:0 0 0 3px var(--ring)}
.btn.ghost{background:var(--paper-2);color:var(--ink);border:1px solid var(--rule)}
.btn.ghost:hover{background:var(--paper-3);filter:none}
.btn.gh{background:#1f2328;color:#fff}
.btn.danger{background:var(--bad)}
.btn.sm{padding:7px 11px;font-size:13px;border-radius:8px}
.btn.block{width:100%}

.chip{display:inline-flex;align-items:center;gap:5px;font:600 11px/1 var(--mono);letter-spacing:.02em;padding:4px 9px;border-radius:var(--r-chip)}
.chip.on{background:var(--accent-bg);color:var(--accent-strong)}
.chip.good{background:var(--good-bg);color:var(--good)} .chip.warn{background:var(--warn-bg);color:var(--warn)} .chip.bad{background:var(--bad-bg);color:var(--bad)}

.card{background:var(--paper);border:1px solid var(--rule);border-radius:var(--r);box-shadow:var(--cast);padding:20px 22px;margin:0 0 16px;animation:rise var(--slow) var(--ease) both}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap} .grow{flex:1}
.sep{height:1px;background:var(--rule);margin:16px 0}
.stat{flex:1;min-width:140px;text-align:center;padding:18px} .stat b{font:700 30px/1 var(--mono);letter-spacing:-.02em;display:block;margin-bottom:6px}

table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:600 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);padding:0 12px 10px 0;border-bottom:1px solid var(--rule)}
td{padding:12px 12px 12px 0;border-bottom:1px solid var(--rule-2);vertical-align:middle}
tbody tr{transition:background var(--fast)} tbody tr:hover{background:var(--paper-2)}
pre{font:12.5px/1.55 var(--mono);background:var(--paper-2);border:1px solid var(--rule);border-radius:var(--r-sm);padding:12px 14px;overflow-x:auto;white-space:pre-wrap}
.err{color:var(--bad);font-size:13px;margin:8px 0}
.hint{color:var(--ink-3);font-size:13px;margin:6px 0 0}

/* ── auth shell (centered) ── */
.authwrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px 20px}
.authbrand{display:inline-flex;align-items:center;gap:10px;text-decoration:none}.authbrand:hover{text-decoration:none}
.authwrap .card{width:100%;max-width:400px}
.authwrap .btn{width:100%}
.authwrap h1{font-size:22px}
.altlink{font-size:13px;color:var(--ink-2);margin:16px 0 0;text-align:center}

/* ── app shell (sidebar) ── */
.app{display:grid;grid-template-columns:var(--side-w) 1fr;min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:18px 12px;
  background:var(--paper-2);border-right:1px solid var(--rule)}
.side .brandrow{display:flex;align-items:center;gap:10px;padding:6px 8px 16px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:var(--r-sm);color:var(--ink-2);font-weight:500;
  position:relative;transition:background var(--fast),color var(--fast)}
.nav a .ico{color:var(--ink-3);transition:color var(--fast)}
.nav a:hover{background:var(--paper-3);color:var(--ink);text-decoration:none}
.nav a:hover .ico{color:var(--ink-2)}
.nav a.on{background:var(--accent-bg);color:var(--accent-strong)} .nav a.on .ico{color:var(--accent)}
.nav a.on::before{content:"";position:absolute;left:-12px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.side .foot{margin-top:auto;display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--rule)}
.who{font-size:12.5px;color:var(--ink-2);padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.iconbtn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink-2);cursor:pointer;transition:background var(--fast),color var(--fast),transform var(--fast) var(--spring)}
.iconbtn:hover{background:var(--paper-3);color:var(--ink)} .iconbtn:active{transform:scale(.94)}
.main{min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:12px;padding:20px 30px;border-bottom:1px solid var(--rule);position:sticky;top:0;background:color-mix(in srgb,var(--paper) 86%,transparent);backdrop-filter:saturate(1.4) blur(8px);z-index:5}
.topbar h1{margin:0} .content{padding:26px 30px 70px;max-width:1000px;width:100%}
.crumb{color:var(--ink-3);font-size:13px;margin:0 0 14px;display:inline-flex;align-items:center;gap:4px}
.empty{color:var(--ink-3);padding:14px 0}

.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--ink);color:var(--paper);padding:11px 18px;border-radius:var(--r-sm);box-shadow:var(--cast-2);animation:toastIn var(--slow) var(--spring) both;font-size:14px;z-index:20}
.danger-zone{border-color:color-mix(in srgb,var(--bad) 35%,var(--rule))}

@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes toastIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:760px){
  .app{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;border-right:0;border-bottom:1px solid var(--rule);padding:10px 14px}
  .side .brandrow{padding:6px 6px;flex:1}
  .nav{flex-direction:row;flex-wrap:wrap} .nav a{padding:8px 10px} .nav a.on::before{display:none}
  .side .foot{margin:0;border:0;padding:0;flex-direction:row;width:100%;justify-content:flex-end}
  .who{flex:1} .topbar{padding:16px 18px} .content{padding:20px 18px 60px}
}
`;
}

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The crew mark, drawn from the current accent so it recolors with the theme.
export function markSvg(tile = true): string {
  const accent = getBrand().accent;
  const t = tile ? `<rect width="32" height="32" rx="7" fill="${accent}"/>` : "";
  const fg = tile ? "#fff" : accent;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${t}` +
    `<path fill="${fg}" d="m6.5 8.5 7.5 7.5-7.5 7.5L4 21l5-5-5-5z"/>` +
    `<rect x="15" y="10" width="12" height="3.5" rx="1.75" fill="${fg}"/>` +
    `<rect x="15" y="15" width="8.5" height="3.5" rx="1.75" fill="${fg}"/>` +
    `<rect x="21" y="21" width="6" height="3" rx="1.5" fill="${fg}"/></svg>`;
}

function faviconLink(): string {
  const uri = "data:image/svg+xml," + encodeURIComponent(markSvg(true));
  return `<link rel="icon" type="image/svg+xml" href="${uri}"><link rel="apple-touch-icon" href="${uri}">`;
}

// Applies the saved theme before paint (no flash) + wires the toggle.
const themeScript = `<script>(function(){try{var t=localStorage.getItem('crew-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}
window.__toggleTheme=function(){var d=document.documentElement;var cur=d.getAttribute('data-theme');var sysDark=matchMedia('(prefers-color-scheme:dark)').matches;var next=(cur? (cur==='dark'?'light':'dark') : (sysDark?'light':'dark'));d.setAttribute('data-theme',next);try{localStorage.setItem('crew-theme',next);}catch(e){}};})();</script>`;

function head(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(getBrand().name)}</title>
${faviconLink()}
<style>${themeCss()}</style>${themeScript}</head>`;
}

// Centered single-card shell (login / signup / consent / errors).
export function authPage(title: string, cardHtml: string, opts: { toast?: string } = {}): string {
  const toast = opts.toast ? `<div class="toast">${esc(opts.toast)}</div>` : "";
  return `${head(title)}
<body><div class="authwrap">
<a class="authbrand" href="/"><span class="mark" aria-hidden="true">${markSvg()}</span><span class="logo">${esc(getBrand().name)}</span></a>
${cardHtml}
</div>${toast}</body></html>`;
}

export interface Nav { href: string; label: string; icon: string; active?: boolean }

// Sidebar shell for signed-in pages.
export function appShell(opts: {
  title: string; nav: Nav[]; body: string; account?: string; actions?: string; toast?: string;
}): string {
  const nav = opts.nav.map((n) =>
    `<a class="${n.active ? "on" : ""}" href="${esc(n.href)}">${icon(n.icon, 18)}<span>${esc(n.label)}</span></a>`).join("");
  const toast = opts.toast ? `<div class="toast">${esc(opts.toast)}</div>` : "";
  const themeBtn = `<button class="iconbtn" type="button" onclick="__toggleTheme()" title="Toggle theme" aria-label="Toggle theme">${icon("sun", 17)}</button>`;
  const foot = `<div class="foot">${opts.account ? `<div class="who" title="${esc(opts.account)}">${esc(opts.account)}</div>` : ""}
    <div class="row" style="gap:8px">${themeBtn}<a class="iconbtn grow" href="/logout" title="Sign out" aria-label="Sign out" style="text-decoration:none">${icon("logout", 17)}</a></div></div>`;
  return `${head(opts.title)}
<body><div class="app">
<aside class="side">
  <a class="brandrow" href="/app" style="text-decoration:none"><span class="mark">${markSvg()}</span><span class="logo">${esc(getBrand().name)}</span></a>
  <nav class="nav">${nav}</nav>
  ${foot}
</aside>
<main class="main">
  <header class="topbar"><h1 class="grow">${esc(opts.title)}</h1>${opts.actions || ""}</header>
  <div class="content">${opts.body}</div>
</main>
</div>${toast}</body></html>`;
}

export { esc };
