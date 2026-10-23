-- Staff sign in with their LTX account (src/services/adminUserService.js), so the adapter no longer keeps staff accounts, password
-- hashes, two-factor secrets or lock-out counters. The table is removed (its owned id sequence goes with it). Idempotent.
DROP TABLE IF EXISTS admin_users;
