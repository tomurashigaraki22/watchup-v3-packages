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

process.once("SIGTERM", () => watchup.shutdown());
process.once("SIGINT", () => watchup.shutdown());

module.exports = { watchup };
`;
}

async function installNode({ cwd, apiKey }) {
  const filePath = path.join(cwd, "watchup.js");
  const created = [];
  if (writeFileIfMissing(filePath, source())) created.push(path.relative(cwd, filePath));
  if (appendEnv(cwd, { WATCHUP_API_KEY: apiKey || "wup_live_xxx" })) created.push(".env.local");

  return {
    packages: ["@watchupltd/node"],
    created,
    notes: ["Import { watchup } from ./watchup and call watchup.captureError(), watchup.captureLog(), or watchup.startTrace()."],
  };
}

module.exports = { installNode };
