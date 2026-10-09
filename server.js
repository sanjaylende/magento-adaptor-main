// Entry point. Magento -> Flipick video generator adapter; see README.md for the architecture.
require("./src/app").start().catch((err) => {
  // A failed start (unsafe production configuration, database unreachable, migration error) must stop the process with a
  // non-zero exit code so the service manager reports it and does not leave a half-started server behind.
  const logger = require("./src/utils/logger");
  logger.error(err.message, err.configProblems ? undefined : err);
  setTimeout(() => process.exit(1), 100);
});
