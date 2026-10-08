// Minimal console logger (info/error/warn) with timestamps -- stands in for the Shopify adapter's winston logger so this
// adapter needs no extra dependencies.
function stamp() {
  return new Date().toISOString();
}

function format(args) {
  return args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
}

module.exports = {
  info: (...args) => console.log(`${stamp()} info: ${format(args)}`),
  warn: (...args) => console.warn(`${stamp()} warn: ${format(args)}`),
  error: (...args) => console.error(`${stamp()} error: ${format(args)}`),
};
