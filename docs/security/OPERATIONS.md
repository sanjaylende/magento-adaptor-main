# Backups, recovery and incident response

## Backups (`scripts/backup/`)
| Script | What it does |
|---|---|
| `backup-db.sh` | `pg_dump` (custom format, compressed) streamed straight into `openssl` AES-256 (PBKDF2, 200,000 iterations). No unencrypted file ever touches the disk. Writes a `.sha256` next to it, optionally uploads (`BACKUP_UPLOAD_CMD`), and deletes backups older than `BACKUP_RETENTION_DAYS` (default **14**) |
| `restore-test.sh` | Checks the checksum, decrypts, restores into a **scratch** database (`restore_test_<time>`), compares row counts of the key tables with the live database, prints the restore time, and drops the scratch database. It never touches the live database |

Settings: `BACKUP_KEY_FILE` (the passphrase; **required**), `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_UPLOAD_CMD`.
Cron (daily 02:15): `15 2 * * * /opt/flipick-adapter/app/scripts/backup/backup-db.sh >> /var/log/flipick-adapter/backup.log 2>&1`

Rules that keep backups useful:
1. Copy every backup **off the server and into another account** (`BACKUP_UPLOAD_CMD="aws s3 cp"` to a bucket the server cannot delete from).
2. Keep a copy of the passphrase and of `ADAPTER_SECRET_KEY` in your password manager. Without `ADAPTER_SECRET_KEY` a restored database
   cannot read merchants' stored tokens (they would have to reconnect); without the passphrase the backup cannot be opened.
3. Run `restore-test.sh` **monthly** and write the printed time down.
4. Use a database role that only reads for backups (`DATABASE.md`).

Measured on this development machine (test data, 112 KB backup): backup 1 s, restore into a scratch database 1 s, all seven key
tables matched. A wrong passphrase and a damaged file are both refused (`pg_restore` reports an invalid archive; the checksum
check catches a changed file). **The time on production depends on the data size; the first monthly test gives your real figure.**

## Recovery plan
| Situation | Steps |
|---|---|
| Bad migration or data deleted by mistake | Stop the service. Restore the latest backup into a scratch database (`restore-test.sh`), copy the missing rows across, or restore it as the live database (rename old to `_broken`). Start the service |
| Database server lost | New PostgreSQL 17, create the roles (`docker/db-init/01-app-role.sql`), `pg_restore` the newest backup into `magento_adapter`, set `DATABASE_*`, start the service (migrations bring the schema up to date) |
| Whole server lost | New server from the go-live guide, deploy the tagged release, restore the database, put `/etc/flipick-adapter.env` back from your secret manager, repoint DNS/Cloudflare |
| Payments between the last backup and the failure | Ask ICICI for the transaction list for those hours (dashboard export) and compare with `payment_orders`; re-run the status check for anything missing |

## If a compromise is suspected
1. **Contain.** Put the Cloudflare route into "Under attack" or maintenance mode; block the attacker's addresses; stop the service if data is leaving.
2. **Preserve.** Snapshot the server disk and take a database backup before cleaning anything. Keep the logs.
3. **Protect.** Rotate, in this order: the ICICI production key (Merchant Dashboard, Key Management), database passwords, staff passwords
   (and reset staff two-factor if devices were exposed), the video-engine API keys, then `ADAPTER_SECRET_KEY` last: changing it
   invalidates stored merchant tokens and sessions, so every merchant must reconnect from Magento.
   Suspend an individual installation from the staff console (Merchants, installation, Suspend) to cut off one merchant.
4. **Investigate.** Wazuh alerts, `app.log` / `error.log` (search by `requestId`, `ip`), nginx logs, `last`, `auditd`. Find the way in and what was read.
5. **Recover.** Rebuild from a tagged release on a clean server; restore data from a backup taken before the compromise; re-enable traffic.
6. **Tell.** Affected merchants; ICICI if payments or the key were involved; the authorities and users as the law requires and in the
   time limits it sets (for example GDPR 72 hours for EU personal data; India's DPDP Act requires notifying the Data Protection Board and affected people).
7. **Learn.** Write up cause, timeline and fix. Add a test or an alert so it cannot repeat.

## Staff accounts
- Two-factor is mandatory in production (`ADMIN_REQUIRE_2FA` defaults on). Lost phone: `node scripts/reset-2fa.js person@company.com` (needs server access).
- An account locks for `ADMIN_LOCK_MINUTES` (15) after `ADMIN_MAX_FAILED_LOGINS` (5) failures; the unlock is automatic.
- Sessions end after `ADMIN_IDLE_MINUTES` (30) of inactivity and after `ADMIN_SESSION_HOURS` (8) in any case.
