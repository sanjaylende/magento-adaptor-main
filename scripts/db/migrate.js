#!/usr/bin/env node
// Applies the pending migrations to the configured database/schema and exits (the service does the same at start-up).
//   node scripts/db/migrate.js
require("dotenv").config();
const { runMigrations } = require("../../src/db/migrate");
const { close } = require("../../src/db/connection");
const config = require("../../src/config");

runMigrations()
  .then(() => console.log(`Migrations are up to date in schema "${config.database.schema}".`))
  .then(close)
  .then(() => process.exit(0), (err) => { console.error("Migration failed:", err.message); process.exit(1); });
