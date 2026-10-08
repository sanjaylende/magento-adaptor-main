// Last-resort handler for errors a controller did not catch itself.
const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.userMessage || err.message || "Internal server error" });
}

module.exports = errorHandler;
