// A signed-in client for one store of the test stack: registers an installation with the fake store, exchanges the launch token for a
// browser session, and gives get/post helpers that behave like the adapter's own UI (Bearer session token, Idempotency-Key on writes).
let counter = 0;
async function connectStore(stack, { name = 'Regression Store', country = 'IN', websiteId = 1, siteSuffix = '' } = {}) {
  const { helpers, platform, base } = stack;
  // a different address (a path prefix the fake store ignores) for the same fake store gives another, separate installation
  const baseUrl = siteSuffix ? `${stack.store.url}/site-${siteSuffix}` : stack.store.url;
  const body = platform === 'magento'
    ? { baseUrl, magentoToken: 'good-token', merchantName: name, contactEmail: `regression${++counter}@test.local`, countryCode: country }
    : { baseUrl, consumerKey: 'good-key', consumerSecret: 'good-secret', merchantName: name, contactEmail: `regression${++counter}@test.local`, countryCode: country };
  const reg = await fetch(base + '/api/v1/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register answered ${reg.status}: ${(await reg.text()).slice(0, 200)}`);
  const creds = await reg.json();
  const launch = () => helpers.launchToken({ installKey: creds.installKey, secret: creds.secret, websiteId });
  const sess = await (await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ launch: launch() }) })).json();
  if (!sess.token) throw new Error('no session token: ' + JSON.stringify(sess).slice(0, 120));
  const auth = { Authorization: 'Bearer ' + sess.token };
  const call = async (method, p, payload, extra = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'Idempotency-Key': `rg-${Date.now()}-${++counter}` } : {}), ...auth, ...extra }, body: payload !== undefined ? JSON.stringify(payload) : undefined });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { creds, token: sess.token, auth, call, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), del: (p) => call('DELETE', p), signed: helpers.signedClient({ installKey: creds.installKey, secret: creds.secret, websiteId, baseUrl: base }), launch, websiteId };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitStatus(client, tag, type, wanted = ['ready', 'error'], ms = 90000) {
  const end = Date.now() + ms; let last = null;
  while (Date.now() < end) { last = await client.get(`/api/status/${encodeURIComponent(tag)}/${type}`); if (last.body && wanted.includes(last.body.status)) return last.body; await sleep(400); }
  throw new Error(`status of ${tag}/${type} did not become ${wanted.join('/')} in ${ms / 1000} s (last: ${last && JSON.stringify(last.body).slice(0, 120)})`);
}
module.exports = { connectStore, waitStatus, sleep };
