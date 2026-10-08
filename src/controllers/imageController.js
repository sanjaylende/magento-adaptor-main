// Product photos for the browser. The page may be served over https (a Cloudflare address) while Magento's media URL is
// plain http or only reachable from this server, which browsers block or cannot load. So the UI is given short-lived signed
// links to this route, and the adapter fetches the photo itself. The signed token holds the Magento URL, so only photo URLs
// that came from a store's own catalogue can be fetched; nothing is taken from the request.
const { Readable } = require("stream");
const logger = require("../utils/logger");
const { signToken, verifyToken } = require("../utils/crypto");

const TTL_SECONDS = 12 * 3600;
const MAX_BYTES = 15 * 1024 * 1024;

// Link the browser can load for a catalogue photo URL (null stays null).
const proxiedImageUrl = (url) => (url ? `/img/${signToken({ typ: "img", u: url }, TTL_SECONDS)}` : null);

async function show(req, res) {
  const claims = verifyToken(req.params.token);
  if (!claims || claims.typ !== "img") return res.status(404).end();
  try {
    const upstream = await fetch(claims.u, { signal: AbortSignal.timeout(20000) });
    const type = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !upstream.body || !type.startsWith("image/")) return res.status(404).end();
    if (Number(upstream.headers.get("content-length") || 0) > MAX_BYTES) return res.status(413).end();
    res.set("Content-Type", type);
    res.set("Cache-Control", "private, max-age=3600");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    logger.error("Product image fetch failed:", err.message);
    res.status(502).end();
  }
}

module.exports = { show, proxiedImageUrl };
