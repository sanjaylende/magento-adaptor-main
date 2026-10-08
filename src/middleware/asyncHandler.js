// Express 5 forwards rejected promises already, but this keeps the intent explicit and works on any version.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
