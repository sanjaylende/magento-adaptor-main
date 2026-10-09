// Express application assembly + boot sequence (migrations -> EAV definitions -> sweep -> jobs -> HTTP listener).
const http = require("http");
const path = require("path");
const express = require("express");
const config = require("./config");
const logger = require("./utils/logger");
const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");
const requestLog = require("./middleware/requestLog");
const { runMigrations, syncEntityTypes } = require("./db/migrate");
const VideoSlot = require("./models/VideoSlot");
const VideoVersion = require("./models/VideoVersion");
const StoreSetting = require("./models/StoreSetting");
const videoVersions = require("./repositories/VideoVersionRepository");
const scheduler = require("./services/scheduler");
const adminUsers = require("./services/adminUserService");
const { assertSafeConfig } = require("./config/safety");

function createApp() {
  const app = express();
  app.set("trust proxy", config.isProduction ? 1 : false);
  app.disable("x-powered-by");
  app.use(requestLog);
  app.use(require("./middleware/securityHeaders"));
  // rawBody is kept for request signatures and idempotency hashes.
  app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use("/static", express.static(path.join(__dirname, "..", "public")));
  app.use(require("./admin/routes"));
  app.use(routes);
  // Anything that matched no route: a plain 404 that carries our security headers (Express's own page has a bare CSP and names the path).
  app.use((req, res) => res.status(404).type("text/plain").send("Not found"));
  app.use(errorHandler);
  return app;
}

// The HTTP server with its connection limits (M4): a client has 15 s to send its headers and 30 s to send a whole request, headers
// are capped at 16 KB, and idle keep-alive connections are closed after 5 s (shorter than nginx's, so nginx never reuses a dead one).
function createServer(app = createApp()) {
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, app);
  server.headersTimeout = 15 * 1000;
  server.requestTimeout = 30 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  server.maxRequestsPerSocket = 1000;
  return server;
}

async function start() {
  // Last-resort safety nets: a synchronous throw that escaped every try/catch means Node's state can't be trusted --
  // log and exit so a supervisor restarts us; a stray rejection is only logged.
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception -- exiting:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection:", reason);
  });

  assertSafeConfig(); // production only: refuses the mock gateway, plain-HTTP address, development passwords
  await runMigrations();
  await syncEntityTypes([VideoSlot, VideoVersion, StoreSetting]);
  await adminUsers.ensureBootstrapAdmin();
  await videoVersions.sweepAfterRestart();
  scheduler.start();
  createServer().listen(config.port, () => {
    logger.info(`Magento adapter running at ${config.publicBaseUrl} (payment gateway: ${config.payment.gateway})`);
  });
}

module.exports = { createApp, createServer, start };
