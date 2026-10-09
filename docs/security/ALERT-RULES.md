# Alert rules

The adapter writes one JSON object per line in production (`LOG_FORMAT=json` is the default when `NODE_ENV=production`), to
the console (systemd journal) and to `logs/app.log` / `logs/error.log`. Fields: `time`, `level`, `message`, `context`
(including `requestId`, `ip`, `installationId`, `storeId`). Secrets, tokens, signatures, e-mail addresses and phone numbers are
masked before anything is written. Use the rules below with free tools: Grafana Loki + Alertmanager, Wazuh, fail2ban, Uptime Kuma.

## Messages worth alerting on

| Event | `message` contains | Level | Meaning |
|---|---|---|---|
| Failed staff sign-ins | `Staff account locked after repeated failed sign-ins` | warn | Someone guessed passwords or codes until the account locked |
| Bad requests from one address | `Auth refused:` | warn | Invalid signature, unknown key, stale or replayed request: probing |
| Rate limit hit | `Rate limit reached` | warn | A client is over its budget |
| Callback from an address not allowed | `payment callback: request from an address that is not allowed` | warn | Someone other than ICICI called the bank callback |
| Forged bank message | `Invalid gateway signature` / `Gateway callback rejected` | error | A bank message failed signature check |
| Refused outbound address | `refused` with `Store address is not allowed` | warn | A merchant URL pointed at a private address (SSRF attempt) |
| Video-engine webhook refused | `Video-engine webhook refused` | warn | Wrong or missing shared secret |
| Server error | level `error` | error | Any 5xx; message has the `requestId` the client also received |
| Payment problems | `Reconcile failed`, `Payment failed`, `Amount mismatch` | error | Payments that need a person |
| Process restarted | `Magento adapter running at` | info | A start; more than 3 in 10 minutes means a crash loop |

## Grafana Loki (LogQL) rules

```yaml
groups:
  - name: flipick-adapter
    rules:
      - alert: StaffAccountLocked
        expr: count_over_time({job="flipick-adapter"} |= "Staff account locked" [10m]) > 0
        labels: { severity: warning }
      - alert: AuthRefusedBurst            # 20+ refused requests in 5 minutes from the log
        expr: sum(count_over_time({job="flipick-adapter"} |= "Auth refused" [5m])) > 20
        labels: { severity: warning }
      - alert: ServerErrors                # 5xx burst
        expr: sum(count_over_time({job="flipick-adapter"} | json | level="error" [5m])) > 10
        labels: { severity: critical }
      - alert: BankCallbackForged
        expr: count_over_time({job="flipick-adapter"} |= "Gateway callback rejected" [15m]) > 3
        labels: { severity: critical }
      - alert: CrashLoop
        expr: count_over_time({job="flipick-adapter"} |= "Magento adapter running at" [10m]) > 3
        labels: { severity: critical }
```

## Payments stuck pending, refunds stuck processing

These never produce an HTTP error, so they need a check against the database. `scripts/check-health.js` does it and exits
non-zero with a message:

```
node scripts/check-health.js        # exit 0 = healthy, 1 = a problem is listed, 2 = the check itself failed
```

Run it every 5 minutes from cron, or as an Uptime Kuma **Push** monitor (`*/5 * * * * node scripts/check-health.js && curl -fsS https://kuma.example/api/push/TOKEN`).
Limits are `HEALTH_PENDING_MINUTES` (default 30) and `HEALTH_REFUND_DAYS` (default 3).

## fail2ban: block addresses that keep failing

`/etc/fail2ban/filter.d/flipick-adapter.conf`

```
[Definition]
failregex = "message":"Auth refused:.*"ip":"<HOST>"
            "message":"Invalid request on .*"ip":"<HOST>"
            "message":"Rate limit reached.*"
datepattern = "time":"%%Y-%%m-%%dT%%H:%%M:%%S
```

`/etc/fail2ban/jail.d/flipick-adapter.local`

```
[flipick-adapter]
enabled  = true
filter   = flipick-adapter
logpath  = /opt/flipick-adapter/app/logs/app.log
maxretry = 20
findtime = 300
bantime  = 3600
action   = cloudflare[cfuser="you@company.com", cftoken="<token>"]   ; ban at Cloudflare, not just on the server
```

## Wazuh rules (`/var/ossec/etc/rules/flipick_rules.xml`)

```xml
<group name="flipick,">
  <rule id="100100" level="8"><decoded_as>json</decoded_as><field name="message">Staff account locked</field><description>Flipick: staff account locked</description></rule>
  <rule id="100101" level="10"><decoded_as>json</decoded_as><field name="message">Gateway callback rejected</field><description>Flipick: forged bank callback</description></rule>
  <rule id="100102" level="6" frequency="20" timeframe="300"><decoded_as>json</decoded_as><field name="message">Auth refused</field><description>Flipick: repeated refused requests</description></rule>
</group>
```

## Uptime Kuma monitors

1. HTTPS keyword monitor on `https://magento.flipickvideogenerator.com/` (expects the page title), every minute.
2. Push monitor fed by `scripts/check-health.js` (above).
3. TLS certificate expiry notification at 14 days.
