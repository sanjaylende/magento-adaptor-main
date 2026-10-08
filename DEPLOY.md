# Deploying to a RHEL 9 server

Runbook for running this adapter on a RHEL 9 box behind nginx + TLS, as a
systemd service. Run all `sudo` steps on the RHEL server itself (SSH in
first) — nothing here runs against your Magento/Flipick accounts remotely,
it's all local server setup.

## 1. Install Node.js 22.9+

`--use-system-ca` (see `package.json`'s `start` script) requires Node
**22.9 or newer**. RHEL 9's own `dnf module` stream may lag behind that, so
use the NodeSource repo instead:

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node --version   # confirm >= 22.9.0
```

## 2. Create a dedicated service user

```bash
sudo useradd -r -m -d /opt/magento-flipick-adapter -s /sbin/nologin flipick
```

## 3. Ship the code to the server

From your machine (adjust user@host):

```bash
rsync -avz --exclude node_modules --exclude .env --exclude data \
  d:/Projects/magento-adapter-main/ user@your-rhel-host:/tmp/magento-flipick-adapter/
```

On the server:

```bash
sudo mkdir -p /opt/magento-flipick-adapter
sudo rsync -a /tmp/magento-flipick-adapter/ /opt/magento-flipick-adapter/
sudo chown -R flipick:flipick /opt/magento-flipick-adapter
cd /opt/magento-flipick-adapter
sudo -u flipick npm install --omit=dev
```

## 4. Create `.env` directly on the server

Don't ship your local `.env` over rsync/scp as a habit — create it fresh on
the box (`sudo -u flipick vi /opt/magento-flipick-adapter/.env`), same keys
as `.env.example`, plus:

```
PORT=4100
PUBLIC_BASE_URL=https://your.domain.com
```

`PUBLIC_BASE_URL` must be the real public HTTPS address (set up in step 6)
— it's what gets registered as the Flipick Video Engine's webhook callback
URL for Hero Product/Image Transitions jobs.

## 5. Smoke-test manually before wiring up systemd

```bash
cd /opt/magento-flipick-adapter
sudo -u flipick npm start
# in another shell:
curl -X POST http://127.0.0.1:4100/api/refresh
```

Confirm you get back `{"ok":true,"count":N}`, then Ctrl+C the manual run.

## 6. systemd service

```bash
sudo cp deploy/magento-flipick-adapter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now magento-flipick-adapter
sudo systemctl status magento-flipick-adapter
journalctl -u magento-flipick-adapter -f
```

## 7. nginx reverse proxy + TLS

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx
sudo cp deploy/nginx-magento-flipick-adapter.conf /etc/nginx/conf.d/magento-flipick-adapter.conf
sudo sed -i 's/your.domain.com/YOUR_REAL_DOMAIN/' /etc/nginx/conf.d/magento-flipick-adapter.conf
sudo nginx -t && sudo systemctl reload nginx

sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_REAL_DOMAIN
```

Certbot rewrites the nginx config in place to add the HTTPS server block and
an HTTP→HTTPS redirect.

## 8. Firewall + SELinux (RHEL 9 defaults: firewalld + SELinux enforcing)

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
# Don't open 4100 externally -- only nginx (via 80/443) should be reachable.

# Lets nginx's SELinux context (httpd_t) make outbound connections to the
# adapter's local port -- without this, nginx's proxy_pass to 127.0.0.1:4100
# fails with a 502 even though the service itself is healthy.
sudo setsebool -P httpd_can_network_connect 1
```

## 9. Verify end to end

```bash
curl -X POST https://YOUR_REAL_DOMAIN/api/refresh
```

Same `{"ok":true,"count":N}` response as the local test, now over the real
public URL — this is also the URL Flipick's Video Engine will call back to.

## Updating a deployed instance

```bash
rsync -avz --exclude node_modules --exclude .env --exclude data \
  d:/Projects/magento-adapter-main/ user@your-rhel-host:/tmp/magento-flipick-adapter/
ssh user@your-rhel-host 'sudo rsync -a --exclude .env --exclude data /tmp/magento-flipick-adapter/ /opt/magento-flipick-adapter/ && cd /opt/magento-flipick-adapter && sudo -u flipick npm install --omit=dev && sudo systemctl restart magento-flipick-adapter'
```
