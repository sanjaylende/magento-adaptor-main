#!/usr/bin/env node
// db:status - which migrations are applied / pending / changed in the adapter's schema. Read-only; prints no passwords or URLs.
//   npm run db:status                 information only (exit 0)
//   npm run db:status -- --exit-code  exit 1 when something is pending or changed (for a deploy script or CI)
require("dotenv").config();
const config = require("../../src/config");
const { migrationStatus } = require("../../src/db/migrate");
const { close } = require("../../src/db/connection");

migrationStatus()
  .then(async (s) => {
    console.log(`schema "${s.schema}" (history table ${s.historyTable ? "present" : "not created yet"})`);
    for (const a of s.applied) console.log(`  applied  ${a.id}  ${new Date(a.appliedAt).toISOString()}`);
    for (const p of s.pending) console.log(`  PENDING  ${p}`);
    for (const c of s.changed) console.log(`  CHANGED  ${c}  (the file was edited after it was applied: write a new migration instead)`);
    for (const u of s.unknown) console.log(`  UNKNOWN  ${u}  (applied by a newer version of the code)`);
    console.log(`${s.applied.length} applied, ${s.pending.length} pending, ${s.changed.length} changed of ${s.files.length} migration files`);
    await close();
    process.exit(process.argv.includes("--exit-code") && (s.pending.length || s.changed.length) ? 1 : 0);
  })
  .catch((err) => { console.error("db:status failed:", err.message, "(schema", config.database.schema + ")"); process.exit(2); });
