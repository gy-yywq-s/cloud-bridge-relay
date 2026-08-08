// Per-account tenant resolution. In cloud mode each account owns a physically
// separate SQLite database; in local/private the whole deployment is one trust
// domain and every request shares the control database. tenantCtx() is the ONE
// place that decides which database a request's core operations run against — so
// data isolation is structural, not a filter that a query could forget.
import type { DB } from "../db.js";
import { openTenantDb } from "../db.js";
import type { Ctx } from "./context.js";

// Bounded LRU of open tenant handles: a hot working set stays open, cold ones are
// closed on eviction so file descriptors/memory don't grow without limit as the
// number of registered accounts climbs. Correctness is unaffected — a reopened
// handle points at the same file.
const MAX_OPEN = Math.max(8, Number(process.env.CREW_MAX_OPEN_DB) || 256);
const cache = new Map<number, DB>(); // insertion order == LRU order

export function tenantDb(ctrl: Ctx, accountId: number): DB {
  const hit = cache.get(accountId);
  if (hit) { cache.delete(accountId); cache.set(accountId, hit); return hit; } // refresh recency
  const db = openTenantDb(ctrl.cfg, accountId);
  cache.set(accountId, db);
  if (cache.size > MAX_OPEN) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest !== undefined) { const old = cache.get(oldest); cache.delete(oldest); try { old?.close(); } catch { /* noop */ } }
  }
  return db;
}

// Resolve the Ctx a request's business logic should use. Cloud → the caller's
// own tenant database; otherwise → the shared control database unchanged.
//
// `db` is a GETTER, not a captured handle: it re-resolves from the LRU on every
// access. Two consequences matter. (1) An actively-polling tenant touches c.db
// many times per second, so it stays at MRU and is never the eviction victim
// while its long-poll sleeps. (2) Even if a handle were evicted+closed between
// two synchronous statements' worth of work, the next c.db access transparently
// reopens the same file — so eviction can never hand a closed connection to an
// in-flight request. (No caller retains `c.db` across an await; verified.)
export function tenantCtx(ctrl: Ctx, accountId: number | null | undefined): Ctx {
  if (ctrl.cfg.mode !== "cloud" || accountId == null || accountId < 1) return ctrl;
  const id = accountId;
  return { cfg: ctrl.cfg, email: ctrl.email, get db() { return tenantDb(ctrl, id); } };
}

// Every account that could hold tenant data (for sweeps + admin metrics).
export function listTenantIds(ctrl: Ctx): number[] {
  return (ctrl.db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: number }[]).map((r) => r.id);
}
