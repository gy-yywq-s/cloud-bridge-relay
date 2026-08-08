#!/usr/bin/env node
// Operator bootstrap: create (or promote) an admin account directly, without any
// web trust. Admin status is granted here because running this requires access
// to the server's files and config — the authoritative operator boundary. Use it
// to seed the first admin in cloud mode (who then mints invite codes for others).
//
//   node scripts/bootstrap-admin.mjs <email> <password>
//
// Reads the same config as the server (CREW_CONFIG / crew.toml, CREW_DATA_DIR).
// Requires a build first (npm run build) — it imports the compiled modules.
import { loadConfig } from "../dist/config.js";
import { openDb, now } from "../dist/db.js";
import { hash } from "@node-rs/argon2";

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error("usage: node scripts/bootstrap-admin.mjs <email> <password>");
  process.exit(2);
}
if (!email.includes("@")) { console.error("error: a real email is required"); process.exit(2); }
if (password.length < 8) { console.error("error: password must be at least 8 characters"); process.exit(2); }

const cfg = loadConfig();
const db = openDb(cfg);
const e = email.trim().toLowerCase();
const pw = await hash(password);
const existing = db.prepare("SELECT id FROM accounts WHERE email=?").get(e);
if (existing) {
  db.prepare("UPDATE accounts SET pw_hash=?, is_admin=1 WHERE id=?").run(pw, existing.id);
  console.log(`promoted existing account ${e} (#${existing.id}) to admin and reset its password.`);
} else {
  const info = db.prepare("INSERT INTO accounts(email,pw_hash,is_admin,display,created_ts) VALUES(?,?,1,?,?)")
    .run(e, pw, e.split("@")[0], now());
  console.log(`created admin account ${e} (#${info.lastInsertRowid}).`);
}
console.log("sign in at /login with this email + password, then generate invite codes at /admin.");
