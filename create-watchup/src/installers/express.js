const path = require("path");
const { appendEnv, writeFileIfMissing } = require("./utils");

function source() {
  return `const { Watchup } = require("@watchupltd/node");

const watchup = new Watchup({
  apiKey: process.env.WATCHUP_API_KEY,
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
  flushInterval: 2000,
  maxBatchSize: 25,
  logging: { enabled: true, minLevel: "info" },
});

function installWatchup(app) {
  app.use(watchup.requestMiddleware());
  return watchup;
}

function installWatchupErrorHandler(app) {
  app.use(watchup.errorMiddleware());
}

process.once("SIGTERM", () => watchup.shutdown());
process.once("SIGINT", () => watchup.shutdown());

module.exports = { installWatchup, installWatchupErrorHandler, watchup };
`;
}

async function installExpress({ cwd, apiKey }) {
  const filePath = path.join(cwd, "watchup.js");
  const created = [];
  if (writeFileIfMissing(filePath, source())) created.push(path.relative(cwd, filePath));
  if (appendEnv(cwd, { WATCHUP_API_KEY: apiKey || "wup_live_xxx" })) created.push(".env.local");

  return {
    packages: ["@watchupltd/node"],
    created,
    notes: [
      "Call installWatchup(app) before your routes.",
      "Call installWatchupErrorHandler(app) after your routes.",
    ],
  };
}

module.exports = { installExpress };
