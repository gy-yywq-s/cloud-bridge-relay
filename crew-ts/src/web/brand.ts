// Instance branding (name + accent colour) resolved from the settings table so
// the admin can recolour/rename the whole UI at runtime — no restart, no config
// edit. A tiny in-memory cache keeps render hot; settings changes update both.
// This is the single source the theme reads, keeping the palette swappable.
import type { Ctx } from "../core/context.js";

export interface Brand { name: string; accent: string }

let cache: Brand = { name: "crew", accent: "#2563eb" };

const HEX = /^#[0-9a-fA-F]{6}$/;

export function loadBrand(ctrl: Ctx): void {
  cache = { name: ctrl.cfg.brand.name || "crew", accent: normalizeAccent(ctrl.cfg.brand.accent) };
  try {
    const rows = ctrl.db.prepare("SELECT key, value FROM settings WHERE key IN ('brand_name','accent')").all() as { key: string; value: string }[];
    for (const r of rows) {
      if (r.key === "brand_name" && r.value.trim()) cache.name = r.value.trim().slice(0, 40);
      if (r.key === "accent" && HEX.test(r.value)) cache.accent = r.value;
    }
  } catch { /* settings table may not exist yet on first boot */ }
}

export function getBrand(): Brand { return cache; }

export function setBrand(ctrl: Ctx, next: Partial<Brand>): Brand {
  const up = ctrl.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  if (typeof next.name === "string" && next.name.trim()) { cache.name = next.name.trim().slice(0, 40); up.run("brand_name", cache.name); }
  if (typeof next.accent === "string" && HEX.test(next.accent)) { cache.accent = next.accent; up.run("accent", cache.accent); }
  return cache;
}

// Accept "#2563eb" default; fall back to a friendly royal blue (never dark navy).
function normalizeAccent(a: string | undefined): string {
  if (a && HEX.test(a) && a.toLowerCase() !== "#1c4f8f") return a; // the old navy default → replace
  return "#2563eb";
}
