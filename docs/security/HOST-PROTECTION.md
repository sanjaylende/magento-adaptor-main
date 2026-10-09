# Host protection: malware, intrusion and brute-force detection

**Needs you:** these are server-level tools. They cannot be installed from this repository; the configuration below is ready to
copy onto the production server (Ubuntu or Debian shown; RHEL equivalents are `dnf`). Nothing here has been run on a production
server. Each snippet is plain configuration.

## 1. Automatic security updates
```
sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```
Node.js: keep to an active LTS line (22 or newer) and update it with the same care as the operating system.

## 2. SSH and brute-force blocking (fail2ban)
```
sudo apt install fail2ban
```
`/etc/fail2ban/jail.d/sshd.local`
```
[sshd]
enabled  = true
maxretry = 4
findtime = 600
bantime  = 3600
```
Also in `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers deploy`. For the adapter's own log
see `ALERT-RULES.md` (fail2ban filter `flipick-adapter`). CrowdSec is an alternative that shares block lists.

## 3. File-change and intrusion detection (Wazuh agent)
Install the agent from Wazuh's repository and point it at your Wazuh manager (the manager can run on a separate small server;
it is free software). In the agent's `/var/ossec/etc/ossec.conf`:
```xml
<syscheck>
  <frequency>3600</frequency>
  <!-- the application code must never change except during a deployment -->
  <directories check_all="yes" realtime="yes" report_changes="yes">/opt/flipick-adapter/app/src,/opt/flipick-adapter/app/server.js,/opt/flipick-adapter/app/package.json,/opt/flipick-adapter/app/package-lock.json,/opt/flipick-adapter/app/public,/opt/flipick-adapter/app/views,/opt/flipick-adapter/app/migrations</directories>
  <directories check_all="yes" realtime="yes">/etc/flipick-adapter.env,/etc/systemd/system/flipick-adapter.service,/etc/nginx,/etc/ssh/sshd_config</directories>
  <directories check_all="yes">/etc/cron.d,/etc/cron.daily,/var/spool/cron,/etc/sudoers,/etc/sudoers.d</directories>
  <ignore>/opt/flipick-adapter/app/node_modules/.cache</ignore>
</syscheck>
<localfile><log_format>json</log_format><location>/var/log/flipick-adapter/app.log</location></localfile>
```
Rules for the adapter's JSON log are in `ALERT-RULES.md`. Tell the team to expect alerts during deployments, or switch syscheck to
"scheduled" for the code folder during a release and run `syscheck` again afterwards.

## 4. Antivirus (ClamAV)
The adapters accept **no file uploads** from merchants, so there is nothing to scan on the way in. ClamAV is still useful as a
scheduled sweep of the server for dropped web shells and malware:
```
sudo apt install clamav clamav-daemon
sudo systemctl enable --now clamav-freshclam
```
`/etc/cron.d/clamav-sweep`
```
30 3 * * *  root  clamscan -r -i --exclude-dir=^/sys --exclude-dir=^/proc --exclude-dir=^/dev /opt/flipick-adapter /etc /tmp /var/tmp /home >> /var/log/clamav/sweep.log 2>&1
```
Alert on any line containing `FOUND` (Wazuh or the log shipper). **If uploads are ever added**, scan every upload with `clamdscan`
before storing it, and limit type and size.

## 5. Audit trail of privileged actions (auditd)
`/etc/audit/rules.d/flipick.rules`
```
-w /opt/flipick-adapter/app -p wa -k flipick_code
-w /etc/flipick-adapter.env -p rwa -k flipick_secrets
-w /etc/passwd -p wa -k identity
-w /etc/sudoers -p wa -k identity
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -k root_commands
```

## 6. Network
Only 80 and 443 (from Cloudflare) and your admin SSH address are open. See `CLOUDFLARE-SETUP.md`. The database port is closed to
the internet (`DATABASE.md`).

## 7. Checklist for the server
- [ ] Unattended upgrades on, kernel reboot window agreed
- [ ] SSH keys only, root login off, fail2ban running
- [ ] Wazuh agent reporting; a test change to `src/` raised an alert
- [ ] ClamAV signatures updating; a test file (EICAR) was detected by the nightly sweep
- [ ] auditd rules loaded (`auditctl -l`)
- [ ] `/etc/flipick-adapter.env` is `root:root`, mode 600
- [ ] `systemd-analyze security flipick-adapter.service` shows an exposure below 2.0
