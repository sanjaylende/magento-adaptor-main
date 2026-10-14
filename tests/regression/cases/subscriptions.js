// T2 monthly, T3 annual, T4 plan changes and edge cases, T9 Free-plan limits. API level, payments settled by the pretend ICICI bank.
// Expected values come from the plan tables of the database under test (never typed in), so a price change in the catalogue does not break the case.
const { connectStore, waitStatus } = require('../lib/client');

const usd = (m) => '$' + (m / 100).toFixed(2);
const day = (d) => new Date(d).toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };

module.exports = async function subscriptions({ stack, run }) {
  const A = await connectStore(stack, { name: 'Subscriptions A' });
  const B = await connectStore(stack, { name: 'Subscriptions B', siteSuffix: 'other' });
  const idOf = async (c) => (await stack.db('select s.id from stores s join installations i on i.id = s.installation_id where i.install_key = $1 order by s.id limit 1', [c.creds.installKey]))[0].id;
  const storeA = await idOf(A), storeB = await idOf(B);
  const prices = {};
  (await stack.db('select plan_code, billing_interval, currency, amount_minor, budget_usd_cents from plan_prices')).forEach((r) => { prices[`${r.plan_code}/${r.billing_interval}/${r.currency}`] = { amount: Number(r.amount_minor), budget: Number(r.budget_usd_cents) }; });
  const free = (await stack.db("select free_videos from plans where code = 'trial'"))[0].free_videos;
  const subRow = async (store) => (await stack.db('select * from store_subscriptions where store_id = $1', [store]))[0];
  const orders = async (store) => stack.db('select * from payment_orders where store_id = $1 order by created_at', [store]);
  const credit = async (store) => Number((await stack.db('select coalesce(sum(amount_usd_cents),0) as c from credit_ledger where store_id = $1', [store]))[0].c);
  const buy = async (client, { tier, cycle, currency = 'USD', result = 'paid', kind = 'plan', packUsdCents }) => {
    const body = kind === 'plan' ? { kind: 'plan', tier, cycle, currency } : { kind: 'topup', packUsdCents, currency };
    const co = await client.post('/api/billing/checkout', body);
    if (co.status !== 201) return { co, orderId: null, returned: `checkout answered ${co.status} ${JSON.stringify(co.body).slice(0, 100)}` };
    const txn = (await stack.db('select merchant_txn_no from payment_orders where id = $1', [co.body.orderId]))[0].merchant_txn_no;
    const returned = await stack.pay(txn, result);
    return { co, orderId: co.body.orderId, txn, returned };
  };
  const status = async (c) => (await c.get('/api/billing/status')).body;

  // ---------------------------------------------------------------- T2 monthly
  run.section('T2', 'Subscription: monthly purchase, cancel');
  let st = await status(A); let sub;
  run.check('starts on Free with the full free allowance', st.currentPlan === 'trial' && st.freeVideosUsed === 0 && st.freeTrialVideos === free && (await credit(storeA)) === 0, `${st.currentPlan}, ${st.freeVideosUsed}/${st.freeTrialVideos}`);
  const m = prices['starter/monthly/USD'];
  let b = await buy(A, { tier: 'starter', cycle: 'monthly' });
  run.check('the bank page after a paid monthly purchase says Payment received', /Payment received/.test(b.returned), b.returned.slice(0, 80));
  st = await status(A); sub = await subRow(storeA);
  let ord = (await orders(storeA)).pop();
  run.check('database: starter / monthly / USD / active', sub.plan_code === 'starter' && sub.billing_interval === 'monthly' && sub.currency.trim() === 'USD' && sub.status === 'active', `${sub.plan_code}/${sub.billing_interval}/${sub.status}`);
  run.check(`order total is ${usd(m.amount)} with no tax in USD`, Number(ord.total_minor) === m.amount && Number(ord.tax_minor) === 0 && ord.status === 'paid', `${usd(ord.total_minor)} tax ${usd(ord.tax_minor)}`);
  run.check('renewal date is purchase + 1 month', day(sub.period_end) === day(addMonths(sub.period_start, 1)), `${day(sub.period_start)} -> ${day(sub.period_end)}`);
  run.check('API status agrees with the database (plan, interval, period end, budget)', st.currentPlan === 'starter' && st.billingInterval === 'monthly' && day(st.periodEnd) === day(sub.period_end) && st.includedValueCents === m.budget, `${st.currentPlan}/${st.billingInterval} ends ${day(st.periodEnd)} budget ${st.includedValueCents}`);
  run.check('a plan adds no prepaid credit', (await credit(storeA)) === 0 && st.creditCents === 0);
  run.check('one invoice exists for the paid order', (await stack.db('select count(*)::int as n from invoices where order_id = $1', [ord.id]))[0].n === 1);
  const cancelled = await A.post('/api/billing/cancel');
  st = await status(A); sub = await subRow(storeA);
  run.check('cancel drops to Free at once, keeps the used free videos and credit', cancelled.status === 200 && st.currentPlan === 'trial' && sub.plan_code === 'trial' && Number(sub.free_videos_used) === 0, `${st.currentPlan}`);
  run.check('cancel creates no new charge', (await orders(storeA)).length === 1);
  const again = await A.post('/api/billing/cancel');
  run.check('cancelling again is refused cleanly (no second change)', again.status >= 400 && again.status < 500, `HTTP ${again.status}`);

  // ---------------------------------------------------------------- T3 annual
  run.section('T3', 'Subscription: annual purchase, cancel');
  const y = prices['starter/annual/USD'];
  await buy(A, { tier: 'starter', cycle: 'annual' });
  st = await status(A); sub = await subRow(storeA); ord = (await orders(storeA)).pop();
  run.check('database: starter / annual / USD / active', sub.plan_code === 'starter' && sub.billing_interval === 'annual' && sub.status === 'active');
  run.check(`annual price is ${usd(y.amount)} = 10 x the monthly price (two months free)`, Number(ord.total_minor) === y.amount && y.amount === m.amount * 10, usd(ord.total_minor));
  run.check('annual budget is 12 x the monthly budget', st.includedValueCents === y.budget && y.budget === m.budget * 12, `${st.includedValueCents}`);
  run.check('renewal date is purchase + 1 year', day(sub.period_end) === day(addMonths(sub.period_start, 12)), day(sub.period_end));
  await A.post('/api/billing/cancel');
  st = await status(A);
  run.check('cancelling the annual plan also drops to Free', st.currentPlan === 'trial');

  // ---------------------------------------------------------------- T4 plan changes and edge cases
  run.section('T4', 'Plan changes, failed payment, replay, isolation');
  const before = await subRow(storeA);
  b = await buy(A, { tier: 'starter', cycle: 'monthly', result: 'failed' });
  let o = (await orders(storeA)).pop(); sub = await subRow(storeA);
  run.check('failed payment: the customer sees an understandable message', /not completed|did not go through/i.test(b.returned), b.returned.slice(0, 90));
  run.check('failed payment: the plan does not change', sub.plan_code === before.plan_code && o.status === 'failed', `${sub.plan_code}, order ${o.status}`);
  b = await buy(A, { tier: 'starter', cycle: 'monthly' });
  const subPaid = await subRow(storeA); const invBefore = (await stack.db('select count(*)::int as n from invoices'))[0].n;
  await stack.pay(b.txn, 'paid'); await stack.pay(b.txn, 'paid');
  const subAfter = await subRow(storeA);
  run.check('a repeated payment confirmation changes nothing (period, invoices, credit)', day(subAfter.period_end) === day(subPaid.period_end) && (await stack.db('select count(*)::int as n from invoices'))[0].n === invBefore && (await credit(storeA)) === 0);
  await buy(A, { tier: 'starter', cycle: 'annual' });
  sub = await subRow(storeA);
  run.check('monthly -> annual: Starter annual is bought and shown', sub.plan_code === 'starter' && sub.billing_interval === 'annual', `${sub.billing_interval}`);
  await buy(A, { tier: 'starter', cycle: 'monthly' });
  const sub2 = await subRow(storeA);
  run.check('annual -> monthly: Starter monthly is bought and shown', sub2.billing_interval === 'monthly');
  run.check('OBSERVATION: the new period starts at the end of the remaining paid time (periods stack, no proration)', new Date(sub2.period_end) > addMonths(new Date(), 12), `period ends ${day(sub2.period_end)}`);
  await buy(A, { tier: 'pro', cycle: 'monthly' });
  sub = await subRow(storeA); st = await status(A);
  run.check('Starter -> Pro: Pro plan with the Pro budget', sub.plan_code === 'pro' && st.includedValueCents === prices['pro/monthly/USD'].budget, `${sub.plan_code} budget ${st.includedValueCents}`);
  await A.post('/api/billing/cancel');
  await buy(A, { tier: 'starter', cycle: 'monthly' });
  sub = await subRow(storeA);
  run.check('purchase, cancel, purchase again: one subscription row, fresh usage, no credit', sub.plan_code === 'starter' && Number(sub.cycle_videos_used) === 0 && (await credit(storeA)) === 0 && (await stack.db('select count(*)::int as n from store_subscriptions where store_id = $1', [storeA]))[0].n === 1);
  await A.post('/api/billing/cancel');
  await buy(A, { tier: 'starter', cycle: 'monthly', currency: 'INR' });
  const inr = (await orders(storeA)).pop(); const pi = prices['starter/monthly/INR'];
  run.check('INR: price and 18% GST for an Indian merchant', Number(inr.subtotal_minor) === pi.amount && Number(inr.tax_minor) === Math.round(pi.amount * 0.18) && Number(inr.total_minor) === Number(inr.subtotal_minor) + Number(inr.tax_minor), `${inr.subtotal_minor} + ${inr.tax_minor}`);
  await A.post('/api/billing/cancel');
  const packs = (await status(A)).topupPacksUsd || [];
  const pack = packs[0] || 1000;
  const credBefore = await credit(storeA);
  b = await buy(A, { kind: 'topup', packUsdCents: pack });
  await stack.pay(b.txn, 'paid'); await stack.pay(b.txn, 'paid');
  run.check('credit top-up adds the pack once even when the confirmation repeats three times', (await credit(storeA)) === credBefore + pack, `${credBefore} -> ${await credit(storeA)} (+${pack})`);
  // isolation
  run.check('another store (second installation) is untouched: Free, no orders', (await subRow(storeB)).plan_code === 'trial' && (await orders(storeB)).length === 0 && (await credit(storeB)) === 0);
  const peek = await B.get(`/api/billing/orders/${ord.id}`);
  run.check("another store cannot read this store's order (404)", peek.status === 404, `HTTP ${peek.status}`);
  const hist = await B.get('/api/billing/history');
  run.check("another store's history lists none of this store's orders", ((hist.body || {}).orders || []).length === 0);

  // ---------------------------------------------------------------- T9 Free limits (a fresh store, so the allowance is untouched)
  run.section('T9', 'Free plan limits after cancel');
  const C = await connectStore(stack, { name: 'Free limits', siteSuffix: 'limits' });
  const prods = (await C.get('/api/products')).body.products;
  const tag = prods[0].uniqueTag;
  let allowed = 0, refused = null;
  for (let i = 0; i < free + 1; i++) {
    const g = await C.post('/api/generate', { uniqueTag: tag, videoType: 'hero_product', aspectRatio: '16:9' });
    if (g.status === 200) {
      allowed++; await waitStatus(C, tag, 'hero_product', ['ready', 'error']);
      // the adapter shows "ready" first and counts the video a moment later (finding F-USAGE-RACE): wait for the count so that this case tests the limit, not that timing
      const storeC = await idOf(C);
      for (let w = 0; w < 50 && Number((await stack.db('select count(*)::int as n from usage_events where store_id = $1', [storeC]))[0].n) < allowed; w++) await new Promise((r) => setTimeout(r, 100));
    } else { refused = g; break; }
  }
  run.check(`exactly ${free} videos are allowed on Free`, allowed === free, `${allowed} allowed`);
  run.check('the next one is refused with 402 trial_exhausted', refused && refused.status === 402 && refused.body.error === 'trial_exhausted', refused ? `HTTP ${refused.status} ${refused.body && refused.body.error}` : 'not refused');
  const stFree = await status(C);
  run.check('the status shows the allowance used up', stFree.freeVideosUsed === free && (await credit(await idOf(C))) === 0);
  // a plan, cancelled again, brings the Free limit back (used videos are kept, so it is still exhausted)
  await buy(C, { tier: 'starter', cycle: 'monthly' }); await C.post('/api/billing/cancel');
  const g2 = await C.post('/api/generate', { uniqueTag: tag, videoType: 'hero_product', aspectRatio: '16:9' });
  run.check('after buying and cancelling a plan the Free limit still applies (used videos are kept)', g2.status === 402, `HTTP ${g2.status}`);
  return { storeA, storeB };
};
