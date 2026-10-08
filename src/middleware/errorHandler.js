// Last-resort handler for errors a controller did not catch itself.
// The full error (with the request id) goes to the log; the client only gets the message the code marked as safe
// (userMessage), the message of a 4xx, or a generic line for a 5xx -- internals never leak to the browser.
const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
  const context = { requestId: req.id, installationId: req.installation && req.installation.id, storeId: req.store && req.store.id, error: err };
  if (status >= 500) logger.error(`Unhandled error on ${req.method} ${req.path}`, context);
  else logger.warn(`Request rejected on ${req.method} ${req.path}: ${err.message}`, { ...context, error: undefined });
  if (res.headersSent) return next(err);
  const message = err.userMessage || (status < 500 ? err.message : "Internal server error");
  res.status(status).json({ error: message, requestId: req.id });
}

module.exports = errorHandler;
