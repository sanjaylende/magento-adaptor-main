// Express application assembly + boot sequence (migrations -> EAV definitions -> sweep -> jobs -> HTTP listener).
const path = require("path");
const express = require("express");
const config = require("./config");
const logger = require("./utils/logger");
const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");
const { runMigrations, syncEntityTypes } = require("./db/migrate");
const VideoSlot = require("./models/VideoSlot");
const VideoVersion = require("./models/VideoVersion");
const StoreSetting = require("./models/StoreSetting");
const videoVersions = require("./repositories/VideoVersionRepository");
const scheduler = require("./services/scheduler");
const adminUsers = require("./services/adminUserService");

function createApp() {
  const app = express();
  app.set("trust proxy", config.isProduction ? 1 : false);
  // rawBody is kept for request signatures and idempotency hashes.
  app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use("/static", express.static(path.join(__dirname, "..", "public")));
  app.use(require("./admin/routes"));
  app.use(routes);
  app.use(errorHandler);
  return app;
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

  await runMigrations();
  await syncEntityTypes([VideoSlot, VideoVersion, StoreSetting]);
  await adminUsers.ensureBootstrapAdmin();
  await videoVersions.sweepAfterRestart();
  scheduler.start();
  createApp().listen(config.port, () => {
    logger.info(`Magento adapter running at ${config.publicBaseUrl} (payment gateway: ${config.payment.gateway})`);
  });
}

module.exports = { createApp, start };
