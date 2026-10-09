# Database security (PostgreSQL 17)

## What the application already does
- Two roles: `adapter_owner` (runs migrations at start-up) and `adapter_app` (everything else). `adapter_app` is **not** a
  superuser and has **no** BYPASSRLS, CREATEDB or CREATEROLE. It cannot create or drop tables. Test: `test/security.e2e.test.js`,
  "M5 database roles".
- Row-level security on every tenant table: a request only ever sees the rows of its own store. Without a tenant context the
  service sees **no** tenant rows (tested).
- All SQL is parameterised. The one dynamic fragment is the EAV value-table name, which must be one of five fixed names (tested).
- Merchant tokens and installation secrets are encrypted in the database (AES-256-GCM, key in `ADAPTER_SECRET_KEY`, never in the database).
- Production start-up refuses development passwords (`*_local`), `DB_SSL=no-verify`, and a remote database without `DB_SSL=require`.

## TLS to the database
| Setting | Meaning |
|---|---|
| `DB_SSL=disable` | No TLS (local development only) |
| `DB_SSL=require` | TLS **and** the server certificate is verified (host name and chain) |
| `DB_SSL_CA=/path/ca.pem` | The CA that signed the database certificate. Needed for managed databases that use their own CA (RDS, Cloud SQL, Azure publish theirs) and for self-signed setups |
| `DB_SSL=no-verify` | TLS without verification. Refused in production |

Verified against a PostgreSQL 17 server with a private CA:

| Setting | Result |
|---|---|
| `require`, no CA | refused: "unable to verify the first certificate" |
| `require` + correct `DB_SSL_CA` | connected, `pg_stat_ssl.ssl = true` |
| `no-verify` | connected over TLS, with a warning in the log |
| `disable` | connected, no TLS |

## Server side: `postgresql.conf`
```
listen_addresses = '10.0.0.5'            # the private address only, never 0.0.0.0 on a public interface
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file  = 'server.key'              # mode 600, owned by postgres
ssl_min_protocol_version = 'TLSv1.2'
password_encryption = scram-sha-256
log_connections = on
log_disconnections = on
log_min_duration_statement = 1000         # statements slower than 1 s
```

## `pg_hba.conf` (least privilege: first match wins)
```
# TYPE    DATABASE         USER            ADDRESS            METHOD
local     all              postgres                           peer
hostssl   magento_adapter  adapter_app     10.0.0.10/32       scram-sha-256   # the application host only
hostssl   magento_adapter  adapter_owner   10.0.0.10/32       scram-sha-256   # migrations run from the same host
hostssl   all              backup_user     10.0.0.20/32       scram-sha-256   # the backup host, read-only role
host      all              all             0.0.0.0/0          reject          # everything else, including non-TLS
host      all              all             ::/0               reject
```
Create the backup role with read access only: `CREATE ROLE backup_user LOGIN PASSWORD '...'; GRANT pg_read_all_data TO backup_user;`
(`scripts/backup/backup-db.sh` can use it through `DATABASE_ADMIN_URL`).

## Other
- Strong, different passwords for every role, from your secret manager. Rotate when anyone with access leaves.
- Encrypt the disk (cloud volume encryption) and the backups (done by `scripts/backup/backup-db.sh`).
- Optional audit trail of who changed what: the `pgaudit` extension with `pgaudit.log = 'ddl, role'`.
- Keep PostgreSQL patched to the latest minor release of 17.
