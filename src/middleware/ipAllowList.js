// Restricts a route to a list of source addresses or CIDR ranges (ICICI's Payment Advice servers). The list comes from the
// environment variable named in `getList()`. Unset or empty = no restriction (the message signature is still checked), which
// is the safe default until ICICI has supplied its addresses. req.ip is the real client address: the application trusts
// exactly one proxy hop (nginx, which takes it from Cloudflare).
const net = require("net");
const logger = require("../utils/logger");

function buildList(entries) {
  const list = new net.BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const [address, prefix] = entry.split("/");
    const family = net.isIP(address);
    if (!family) throw new Error(`Not an address or range: "${entry}"`);
    if (prefix === undefined) list.addAddress(address, family === 6 ? "ipv6" : "ipv4");
    else list.addSubnet(address, Number(prefix), family === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

// getList() -> array of strings, read on every request so a change of configuration (and tests) takes effect at once.
function ipAllowList(getList, label) {
  return (req, res, next) => {
    const entries = getList();
    if (!entries || !entries.length) return next();
    const ip = String(req.ip || "").replace(/^::ffff:/, "");
    let allowed = false;
    try { allowed = net.isIP(ip) && buildList(entries).check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4"); } catch (err) { logger.error(`${label}: invalid allow-list`, { error: err.message }); }
    if (!allowed) {
      logger.warn(`${label}: request from an address that is not allowed`, { ip: req.ip, path: req.path, requestId: req.id });
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

module.exports = { ipAllowList, buildList };
