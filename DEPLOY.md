# Deploying

The earlier runbook in this file described a single-store setup run as `ec2-user` and has been removed. Use these instead:

| What | Where |
|---|---|
| Server, database, TLS, `.env`, go-live and the ICICI production switch | the go-live guide: `Magento-adapter-deplyment-doc/README.md` (one folder above this repository) |
| Hardened service unit | `deploy/systemd/flipick-adapter.service` |
| nginx in front, Cloudflare-only access, admin and callback allow-lists | `deploy/nginx/` and `docs/security/CLOUDFLARE-SETUP.md` |
| Database TLS, roles, `pg_hba.conf` | `docs/security/DATABASE.md` |
| Backups and the monthly restore test | `scripts/backup/` and `docs/security/OPERATIONS.md` |
| Alerts and monitoring | `docs/security/ALERT-RULES.md` |
| Host protection (file-change monitoring, antivirus, brute-force blocking) | `docs/security/HOST-PROTECTION.md` |
| Reporting a vulnerability | `docs/security/REPORTING.md` and `/.well-known/security.txt` |
