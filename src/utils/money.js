// Currency formatting for prices shown in the adapter UI and baked into overlay text. Magento prices are denominated in the
// store's base currency (MAGENTO_CURRENCY_CODE, default USD). An unmapped code falls back to prefixing the ISO code
// (e.g. "SEK 199.00") rather than guessing a symbol.
//
// Shared between server.js (Node side) and the browser (server.js injects this map into the page).
const CURRENCY_SYMBOLS = {
  USD: "$", CAD: "C$", AUD: "A$", NZD: "NZ$", SGD: "S$", HKD: "HK$",
  INR: "₹", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥",
  CHF: "CHF ", SEK: "kr", NOK: "kr", DKK: "kr",
  AED: "AED ", SAR: "SAR ", ZAR: "R", BRL: "R$", MXN: "MX$",
};

function formatMoney(amount, currencyCode) {
  if (amount == null) return "";
  const code = (currencyCode || "USD").toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const value = Number(amount).toFixed(2);
  return symbol ? `${symbol}${value}` : `${code} ${value}`;
}

module.exports = { formatMoney, CURRENCY_SYMBOLS };
