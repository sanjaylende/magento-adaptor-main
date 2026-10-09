# Cloudflare and nginx setup (free plan)

Goal: every request to `https://magento.flipickvideogenerator.com` passes through Cloudflare's filter first, and the server
refuses anything that did not. This part **needs you**: it requires a Cloudflare account, control of the domain's DNS, and
server access. Everything on the server side is already prepared in `deploy/nginx/` and was syntax-tested with nginx 1.30.

## 1. Cloudflare dashboard

1. Create a free account at cloudflare.com and **Add a site**: `flipickvideogenerator.com`. Choose the **Free** plan.
2. Change the domain's name servers at the registrar to the two Cloudflare gives you. Wait until the site shows **Active**.
3. **DNS**: add `A` record `magento` pointing at the server's public IP, with the **orange cloud (Proxied)** on.
4. **SSL/TLS, Overview**: set the mode to **Full (strict)**.
5. **SSL/TLS, Origin Server**: create an **Origin Certificate** for `magento.flipickvideogenerator.com` (15 years). Save the
   certificate as `/etc/ssl/flipick/fullchain.pem` and the key as `/etc/ssl/flipick/privkey.pem` on the server (key mode 600).
6. **SSL/TLS, Edge Certificates**: turn on **Always Use HTTPS**, set **Minimum TLS Version 1.2**, turn on **TLS 1.3**.
   (HSTS is sent by the application itself, so leave Cloudflare's HSTS off to avoid two different values.)
7. **Security, WAF, Managed rules**: turn on the **Cloudflare Managed Ruleset** (free tier) and **OWASP Core Ruleset** if offered.
8. **Security, Bots**: turn on **Bot Fight Mode**.
9. **Security, WAF, Rate limiting rules** (free plan allows one or two): `URI Path starts with /api/session` or
   `/api/v1/register`: more than 30 requests per 10 seconds from one IP, action **Block** for 10 minutes.
10. **Rules, Page Rules or Configuration Rules**: bypass cache for `/api/*`, `/admin*`, `/billing/*`, `/dl/*`, `/invoice/*`.
11. **Zero Trust, Access** (free for up to 50 users): create a self-hosted application for
    `magento.flipickvideogenerator.com/admin` and allow only your staff e-mail addresses. This puts a login in front of the
    staff console, in addition to the console's own password and two-factor code.
12. Optional: **SSL/TLS, Origin Server, Authenticated Origin Pulls** on, and add `ssl_client_certificate` /
    `ssl_verify_client on` in nginx using Cloudflare's published origin-pull CA. This proves to nginx that a request really
    came from your Cloudflare zone, not just from any Cloudflare customer.

## 2. Server

1. Install nginx. Copy the files:

   ```
   sudo mkdir -p /etc/nginx/flipick
   sudo cp deploy/nginx/{cloudflare-ips,proxy,admin-allow,icici-allow}.conf /etc/nginx/flipick/
   sudo cp deploy/nginx/flipick-adapter.conf /etc/nginx/conf.d/
   ```
2. Edit `/etc/nginx/flipick/admin-allow.conf` and add your office or VPN addresses. **Until you do, `/admin` is closed to everyone.**
3. Ask ICICI for the addresses their Payment Advice webhook comes from, put them in `/etc/nginx/flipick/icici-allow.conf`,
   and replace `allow all;` with `deny all;`.
4. `sudo nginx -t && sudo systemctl reload nginx`.
5. Firewall: only Cloudflare may reach 80 and 443 (nginx already refuses others with 444, this adds a second lock).
   Example with ufw (generate the list from the same published ranges):

   ```
   sudo ufw default deny incoming
   sudo ufw allow from <your admin address> to any port 22 proto tcp
   for r in $(curl -s https://www.cloudflare.com/ips-v4; curl -s https://www.cloudflare.com/ips-v6); do
     sudo ufw allow from $r to any port 443 proto tcp
   done
   sudo ufw enable
   ```
   The database port (5432) must not be open to the internet.
6. Refresh the Cloudflare ranges monthly: `sh deploy/nginx/update-cloudflare-ips.sh`, copy the file, reload nginx.

## 3. Check it works

- `curl -I https://magento.flipickvideogenerator.com/` returns 200 or 302 and a `CF-RAY` header.
- `curl -k -I https://<server-ip>/ -H "Host: magento.flipickvideogenerator.com"` (straight to the server) returns nothing: the
  connection is closed. That proves the lock.
- `https://magento.flipickvideogenerator.com/admin` from an address that is not on the list returns 403.
- The adapter log shows the visitor's real address (not Cloudflare's) in the `ip` field.
