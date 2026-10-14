/* global document, window, cancelModal, closeModal, openPlanModal -- these run inside the browser page (page.evaluate / waitForFunction) */
// T11 UI consistency: every adapter-served screen (merchant app and staff console) in Chrome and Firefox, desktop (1400 px) and phone (390 px) width.
// For each screen: the screen is reached, nothing overflows sideways on the phone, the browser console shows no errors or CSP violations, and no
// request fails. Screenshots go to <reports>/ui/<browser>-<viewport>-<step>.png for the manual comparison (docs/testing/TEST-CASES.md, T11).
// Needs Playwright (npm i -D playwright-core, or PLAYWRIGHT_DIR=<folder that holds node_modules/playwright-core>), Chrome and Playwright's Firefox.
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [() => require('playwright-core'), () => require(path.join(process.env.PLAYWRIGHT_DIR || '', 'node_modules', 'playwright-core')), () => require('D:/Magento-Vanilla/docker/uitest/node_modules/playwright-core')];
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  return null;
}

module.exports = async function ui({ stack, run, connectStore, waitStatus, reportDir }) {
  run.section('T11', 'UI consistency: merchant app and staff console, desktop and phone, Chrome and Firefox');
  const pw = loadPlaywright();
  if (!pw) { run.blocked('browser tests', 'Playwright is not installed (see docs/testing/HOW-TO-RUN.md)'); return; }
  const BASE = stack.base;
  const out = path.join(reportDir, 'ui'); fs.mkdirSync(out, { recursive: true });
  const c = await connectStore(stack, { name: 'UI Store' });
  const products = (await c.get('/api/products')).body.products;
  const tag = products[0].uniqueTag;
  await c.post('/api/generate', { uniqueTag: tag, videoType: 'hero_product', aspectRatio: '16:9' });
  await waitStatus(c, tag, 'hero_product', ['ready', 'error']);
  const browsers = [['chrome', () => pw.chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })], ['firefox', () => pw.firefox.launch({ headless: true })]];
  for (const [bname, launchBrowser] of browsers) {
    let b;
    try { b = await launchBrowser(); } catch (e) { run.blocked(`${bname}: launch`, e.message.split('\n')[0].slice(0, 120)); continue; }
    for (const [vp, size] of [['desktop', { width: 1400, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      const tagName = `${bname}-${vp}`;
      const ctx = await b.newContext({ viewport: size, deviceScaleFactor: 1 });
      await ctx.route(/icici/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>bank stub</h1>' }));
      const page = await ctx.newPage();
      const consoleProblems = [], failed = [];
      page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) consoleProblems.push(m.text().slice(0, 160)); });
      page.on('pageerror', (e) => consoleProblems.push('pageerror: ' + e.message.slice(0, 160)));
      page.on('requestfailed', (r) => failed.push(`${r.failure() && r.failure().errorText} ${r.url().slice(0, 100)}`));
      page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      page.on('dialog', (d) => d.dismiss());
      const step = async (name, fn, { expectStatus = [] } = {}) => {
        const problemsBefore = consoleProblems.length, failedBefore = failed.length;
        let reached = true, why = '';
        try { await fn(); } catch (e) { reached = false; why = e.message.split('\n')[0].slice(0, 120); }
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(out, `${tagName}-${name}.png`) }).catch(() => {});
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
        const newFailed = failed.slice(failedBefore).filter((f) => !expectStatus.some((s) => f.startsWith(String(s))) && !/favicon/.test(f));
        const newConsole = consoleProblems.slice(problemsBefore).filter((m) => !expectStatus.some((s) => m.includes(String(s))));
        run.check(`${tagName} ${name}: screen reached`, reached, why);
        if (vp === 'phone') run.known(`${tagName} ${name}: nothing sticks out sideways`, overflow <= 1, `${overflow}px wider than the screen`, 'FND-UI-1: the product list is wider than a 390 px phone screen (present before the performance work)');
        run.check(`${tagName} ${name}: no console errors, no failed requests`, newFailed.length === 0 && newConsole.length === 0, [...newFailed, ...newConsole].slice(0, 2).join(' | '));
      };
      const appUrl = () => `${BASE}/?embed=1&launch=${encodeURIComponent(c.launch())}`; // a launch link works once
      await step('0-no-launch-token', async () => { await page.goto(`${BASE}/?embed=1`, { waitUntil: 'networkidle' }); }, { expectStatus: [400, 401, 403] });
      await step('1-list', async () => { await page.goto(appUrl(), { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#rows tr', { timeout: 60000 }); await page.waitForFunction(() => document.querySelector('#usageBadge')?.innerText.trim().length > 0, null, { timeout: 60000 }); });
      await step('2-search-no-results', async () => { await page.fill('input[placeholder="Search products"]', 'zzzz-nothing-matches-this'); });
      await step('3-search-long-text', async () => { await page.fill('input[placeholder="Search products"]', 'x'.repeat(300)); });
      await page.fill('input[placeholder="Search products"]', '').catch(() => {});
      await step('4-detail-ready-video', async () => { await page.locator('#rows tr', { hasText: products[0].name }).first().locator('button').first().click(); await page.waitForSelector('#detailMain video, #detailMain .detail-actions', { timeout: 30000 }); });
      await step('5-generate-dialog', async () => { await page.locator('#detailMain button', { hasText: /Regenerate video/ }).first().click(); await page.waitForSelector('.modal', { timeout: 30000 }); });
      await step('6-dialog-settings', async () => { await page.waitForSelector('#submitBtn', { timeout: 30000 }); await page.waitForTimeout(1000); });
      await step('7-long-prompt', async () => { const ta = page.locator('.modal textarea').first(); if (await ta.count()) await ta.fill('A very long prompt. '.repeat(60)); });
      await step('8-stills-picker', async () => { await page.locator('#submitBtn').click(); await page.waitForSelector('#productImagesRoot, .modal .preview-grid', { timeout: 30000 }); await page.waitForTimeout(2000); });
      await page.evaluate(() => { if (typeof cancelModal === 'function') cancelModal(); else if (typeof closeModal === 'function') closeModal(); }).catch(() => {});
      await step('9-plan-dialog', async () => { await page.goto(appUrl(), { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => typeof openPlanModal === 'function' && document.querySelector('#usageBadge')?.innerText.trim().length > 0, null, { timeout: 60000 }); await page.evaluate(() => openPlanModal('manual')); await page.waitForSelector('.plan-modal', { timeout: 20000 }); });
      await step('10-payment-history', async () => { await page.locator('.plan-footer .btn-text', { hasText: 'Payments' }).click(); await page.waitForTimeout(1200); });
      // staff console
      await step('11-admin-login', async () => { await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle' }); });
      await step('12-admin-dashboard', async () => { await page.fill('input[name="email"]', stack.staff.email); await page.fill('input[name="password"]', stack.staff.password); await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('form button')]); });
      for (const [n, p] of [['13-admin-merchants', '/admin/merchants'], ['14-admin-payments', '/admin/payments'], ['15-admin-plans', '/admin/plans'], ['16-admin-audit', '/admin/audit'], ['17-admin-security', '/admin/security']]) {
        await step(n, async () => { await page.goto(BASE + p, { waitUntil: 'networkidle' }); });
      }
      await ctx.close();
    }
    await b.close();
  }
};
