// Instance branding (name, accent, font set) resolved from the settings table so
// the admin can recolour / rename / re-typeset the whole UI at runtime — no
// restart, no config edit. A tiny in-memory cache keeps render hot.
import type { Ctx } from "../core/context.js";

export interface Brand { name: string; accent: string; font: string }

export const REPO_URL = "https://github.com/gy-yywq-s/cloud-bridge-relay";

// Font sets pair a UI face with a mono face (and optionally a display face for
// headings). Only faces that ship with macOS/Windows/Linux are used — nothing is
// fetched, so the UI stays self-contained and instant.
export interface FontSet { key: string; label: string; note: string; sans: string; mono: string; display?: string }

export const FONT_SETS: FontSet[] = [
  { key: "system", label: "System", note: "SF Pro / Segoe — native and invisible",
    sans: `ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif`,
    mono: `ui-monospace,"SF Mono",Menlo,Consolas,monospace` },
  { key: "grotesk", label: "Grotesk", note: "Helvetica Neue — neutral, tighter",
    sans: `"Helvetica Neue",Helvetica,Arial,ui-sans-serif,system-ui,sans-serif`,
    mono: `ui-monospace,"SF Mono",Menlo,Consolas,monospace` },
  { key: "humanist", label: "Humanist", note: "Avenir Next — round, friendly",
    sans: `"Avenir Next","Avenir","Segoe UI",ui-sans-serif,system-ui,sans-serif`,
    mono: `ui-monospace,"SF Mono",Menlo,Consolas,monospace` },
  { key: "editorial", label: "Editorial", note: "serif headings over a sans body",
    sans: `ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif`,
    mono: `ui-monospace,"SF Mono",Menlo,Consolas,monospace`,
    display: `ui-serif,"New York","Iowan Old Style",Charter,Palatino,Georgia,serif` },
  { key: "terminal", label: "Terminal", note: "mono headings — developer-tool voice",
    sans: `ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif`,
    mono: `ui-monospace,"SF Mono",Menlo,Consolas,monospace`,
    display: `ui-monospace,"SF Mono",Menlo,Consolas,monospace` },
];

export const fontSet = (key: string): FontSet => FONT_SETS.find((f) => f.key === key) || FONT_SETS[0];

let cache: Brand = { name: "crew", accent: "#2563eb", font: "system" };

const HEX = /^#[0-9a-fA-F]{6}$/;

export function loadBrand(ctrl: Ctx): void {
  cache = { name: ctrl.cfg.brand.name || "crew", accent: normalizeAccent(ctrl.cfg.brand.accent), font: "system" };
  try {
    const rows = ctrl.db.prepare("SELECT key, value FROM settings WHERE key IN ('brand_name','accent','font')").all() as { key: string; value: string }[];
    for (const r of rows) {
      if (r.key === "brand_name" && r.value.trim()) cache.name = r.value.trim().slice(0, 40);
      if (r.key === "accent" && HEX.test(r.value)) cache.accent = r.value;
      if (r.key === "font" && FONT_SETS.some((f) => f.key === r.value)) cache.font = r.value;
    }
  } catch { /* settings table may not exist yet on first boot */ }
}

export function getBrand(): Brand { return cache; }

export function setBrand(ctrl: Ctx, next: Partial<Brand>): Brand {
  const up = ctrl.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  if (typeof next.name === "string" && next.name.trim()) { cache.name = next.name.trim().slice(0, 40); up.run("brand_name", cache.name); }
  if (typeof next.accent === "string" && HEX.test(next.accent)) { cache.accent = next.accent; up.run("accent", cache.accent); }
  if (typeof next.font === "string" && FONT_SETS.some((f) => f.key === next.font)) { cache.font = next.font; up.run("font", cache.font); }
  return cache;
}

// Never default to the old dark navy — it is unusable as a large fill.
function normalizeAccent(a: string | undefined): string {
  if (a && HEX.test(a) && a.toLowerCase() !== "#1c4f8f") return a;
  return "#2563eb";
}
