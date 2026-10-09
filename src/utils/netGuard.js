// Which network addresses may the adapter connect to? In production: public internet addresses only. Everything that reaches a
// private network, the machine itself, a cloud metadata service (169.254.169.254) or a reserved range is refused, for IPv4,
// IPv6 and IPv4-in-IPv6 forms (::ffff:127.0.0.1). Used by safeFetch for every outbound request.
const net = require("net");
const dns = require("dns");

const blocked = new net.BlockList();
const v4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
for (const [address, prefix] of v4) blocked.addSubnet(address, prefix, "ipv4");
const v6 = [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]];
for (const [address, prefix] of v6) blocked.addSubnet(address, prefix, "ipv6");

// IPv4 hidden inside an IPv6 address (::ffff:7f00:1 or ::ffff:127.0.0.1) is judged by the IPv4 address it carries.
function embeddedIPv4(ip) {
  const m = /^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (m) return m[1];
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

function isPrivateAddress(ip) {
  const address = String(ip).replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(address);
  if (!family) return true; // not an address at all: refuse
  const inner = family === 6 ? embeddedIPv4(address) : null;
  if (inner) return isPrivateAddress(inner);
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Replaceable for tests (a fake DNS that returns chosen addresses, or different ones on each call to imitate DNS rebinding).
let resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });
const setResolver = (fn) => { resolver = fn || ((hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true })); };
const resolveAll = (hostname) => resolver(hostname);

class BlockedAddressError extends Error {
  constructor(message) { super(message); this.name = "BlockedAddressError"; this.status = 400; }
}

// Throws unless every address the name resolves to is public (a name with even one private address is refused).
async function assertPublicHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedAddressError("Address is not allowed (private or reserved network)");
    return [{ address: host, family: net.isIP(host) }];
  }
  let addresses;
  try { addresses = await resolveAll(host); } catch (err) { throw new BlockedAddressError(`Host name could not be resolved: ${host}`); }
  if (!addresses || !addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BlockedAddressError("Address is not allowed (private or reserved network)");
  }
  return addresses;
}

module.exports = { isPrivateAddress, assertPublicHost, setResolver, resolveAll, BlockedAddressError };
