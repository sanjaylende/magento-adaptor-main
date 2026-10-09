// Security headers for every response (H1).
//
//   Everywhere:  HSTS (production only), X-Content-Type-Options: nosniff, Referrer-Policy: no-referrer, a Permissions-Policy that
//                switches off camera/microphone/location/payment, no X-Powered-By, COOP/CORP, X-DNS-Prefetch-Control.
//   /api/*       JSON only: a CSP that allows nothing, never framed, never cached.
//   /admin/*     Staff console: strict CSP (own styles, no scripts), never framed (X-Frame-Options DENY + frame-ancestors 'none'),
//                never cached.
//   Plain pages rendered by the service (payment result, invoice, mock gateway): minimal CSP, never framed.
//   The UI shell ("/") sets its own CSP in pageController because it MUST be framed, but only by registered Magento admins.
//   /static/*    Public assets: nosniff only.
const helmet = require("helmet");
const config = require("../config");

const baseHeaders = helmet({
  contentSecurityPolicy: false,   // set per area below
  frameguard: false,              // framing is decided per area below (the UI shell is meant to be framed)
  hsts: false,                    // set below, per request, only when running in production (a plain-http development server must not send it)
  referrerPolicy: { policy: "no-referrer" },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }, // the payment page opens in a new tab
  crossOriginResourcePolicy: { policy: "same-origin" },
  xPoweredBy: false,
});

const POLICIES = {
  api: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  admin: "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  page: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function area(path) {
  if (path.startsWith("/static/")) return "static";
  if (path === "/") return "shell";
  if (path.startsWith("/api/") && !path.startsWith("/api/payments/callback")) return "api";
  if (path.startsWith("/api/payments/callback")) return "api";
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/dl/") || path.startsWith("/img/")) return "binary";
  return "page"; // /billing/return, /invoice/*, /mockpay/*
}

function securityHeaders(req, res, next) {
  baseHeaders(req, res, (err) => {
    if (err) return next(err);
    if (config.isProduction) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    const kind = area(req.path);
    if (kind === "api" || kind === "admin") {
      res.set("Content-Security-Policy", POLICIES[kind]);
      res.set("Cache-Control", "no-store");
      res.set("X-Frame-Options", "DENY");
    } else if (kind === "page") {
      res.set("Content-Security-Policy", POLICIES.page);
      res.set("Cache-Control", "no-store");
      res.set("X-Frame-Options", "DENY");
    } else if (kind === "binary") {
      res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
    next();
  });
}

module.exports = securityHeaders;
module.exports.area = area;
