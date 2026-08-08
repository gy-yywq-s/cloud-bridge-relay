// SQLite storage (better-sqlite3, synchronous).
//
// Two schemas:
//   • CONTROL plane (global): accounts, OAuth authorization-server state, invite
//     codes. One database, shared by every tenant.
//   • TENANT plane (per account in cloud mode): boxes, teams, mail, tasks, …
//
// local/private are a SINGLE trust domain: control + tenant tables live together
// in one file and every request sees the same data. cloud mode gives EACH
// account its own physically separate tenant database file — the strongest
// isolation SQLite offers, so a query can never read another tenant's rows.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";

export type DB = Database.Database;

export function dataDir(cfg: Config): string {
  const dir = cfg.data_dir || process.env.CREW_DATA_DIR || join(homedir(), ".crew");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Control database (+ tenant tables too, when the deployment is single-domain).
export function openDb(cfg: Config): DB {
  const db = new Database(join(dataDir(cfg), "crew.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrateControl(db);
  if (cfg.mode !== "cloud") migrateTenant(db); // single trust domain: one file
  return db;
}

// A tenant's private business database (cloud mode). Created on first use.
export function openTenantDb(cfg: Config, accountId: number): DB {
  const dir = join(dataDir(cfg), "tenants", String(accountId));
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "crew.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrateTenant(db);
  return db;
}

// Add a column to an existing table if it is missing (SQLite has no
// "ADD COLUMN IF NOT EXISTS"). Lets databases created by earlier versions pick
// up new columns on restart — real migrations, not just CREATE IF NOT EXISTS.
function addColumn(db: DB, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrateControl(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL, pw_hash TEXT,
      github_id INTEGER, is_admin INTEGER NOT NULL DEFAULT 0,
      display TEXT NOT NULL DEFAULT '', created_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_clients(
      client_id TEXT PRIMARY KEY, client_secret TEXT,
      redirect_uris TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      created_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes(
      code TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id INTEGER,
      redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '', expires_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_tokens(
      token TEXT PRIMARY KEY, client_id TEXT NOT NULL, account_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'access',
      scope TEXT NOT NULL DEFAULT '', expires_ts TEXT, created_ts TEXT NOT NULL);
    -- pending (pre-login) authorizations live SEPARATELY from real codes so the
    -- token endpoint can never consume one (security review finding 1).
    CREATE TABLE IF NOT EXISTS oauth_pending(
      pid TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', expires_ts TEXT NOT NULL);
    -- invite codes gate open registration (cloud mode).
    CREATE TABLE IF NOT EXISTS invite_codes(
      code TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '',
      max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
      expires_ts TEXT, created_ts TEXT NOT NULL);
  `);
  // Upgrades: an accounts table created before these columns existed.
  addColumn(db, "accounts", "github_id", "INTEGER");
  addColumn(db, "accounts", "is_admin", "INTEGER NOT NULL DEFAULT 0");
}

function migrateTenant(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, sender TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'mail', client_key TEXT, reply_to INTEGER,
      to_json TEXT NOT NULL, cc_json TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(
      msg_id INTEGER NOT NULL, recipient TEXT NOT NULL, delivered_as TEXT NOT NULL,
      taken_ts TEXT, email_status TEXT, PRIMARY KEY (msg_id, recipient));
    CREATE INDEX IF NOT EXISTS idx_deliv_pending
      ON deliveries(recipient) WHERE taken_ts IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_key
      ON messages(sender, client_key) WHERE client_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS boxes(
      box TEXT PRIMARY KEY, alias TEXT NOT NULL DEFAULT '',
      session_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
      env TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      pool_code TEXT, team_code TEXT, member_no INTEGER,
      role TEXT NOT NULL DEFAULT '', is_human INTEGER NOT NULL DEFAULT 0,
      stale INTEGER NOT NULL DEFAULT 0,
      last_poll TEXT, prev_poll TEXT,
      account_id INTEGER,
      created_ts TEXT NOT NULL, last_seen TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS teams(
      code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      pool_code TEXT NOT NULL DEFAULT '', coordinator TEXT NOT NULL,
      rv INTEGER NOT NULL DEFAULT 1, view_key TEXT,
      account_id INTEGER, created_ts TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS roster_seen(
      box TEXT NOT NULL, team TEXT NOT NULL, rv INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (box, team));
    CREATE TABLE IF NOT EXISTS setup_state(
      team_code TEXT PRIMARY KEY, step_id TEXT NOT NULL DEFAULT '',
      answers TEXT NOT NULL DEFAULT '{}', done INTEGER NOT NULL DEFAULT 0,
      started_ts TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS owner_mailbox(
      id INTEGER PRIMARY KEY, account_id INTEGER,
      full_name TEXT NOT NULL, alias TEXT NOT NULL, email TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'a',
      allow_senders TEXT NOT NULL DEFAULT 'manager_only',
      allow_direct TEXT NOT NULL DEFAULT 'justified_only',
      custom_rules TEXT NOT NULL DEFAULT '', persistent INTEGER NOT NULL DEFAULT 1,
      confirmed INTEGER NOT NULL DEFAULT 0, last_send_error TEXT NOT NULL DEFAULT '',
      created_ts TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      deps TEXT NOT NULL DEFAULT '[]', owner TEXT, status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 2, result TEXT NOT NULL DEFAULT '',
      last_note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
      discovered_from INTEGER, stalled INTEGER NOT NULL DEFAULT 0,
      created_ts TEXT NOT NULL, updated_ts TEXT NOT NULL);
  `);
}

export const now = (): string => new Date().toISOString();
