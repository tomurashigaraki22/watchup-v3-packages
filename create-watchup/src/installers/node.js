const path = require("node:path");
const { appendEnv, keyKind, writeFileIfMissing, PLACEHOLDER_SECRET } = require("./utils");

function source() {
  return `const { Watchup } = require("@watchupltd/node");

// Flushes automatically on SIGTERM/SIGINT; your own signal handlers still decide when to exit.
const watchup = new Watchup({
  apiKey: process.env.WATCHUP_API_KEY,
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
  logging: { enabled: true, minLevel: "info" },
});

module.exports = { watchup };
`;
}

async function installNode({ cwd, apiKey }) {
  const filePath = path.join(cwd, "watchup.js");
  const created = [];
  const notes = [];
  if (writeFileIfMissing(filePath, source())) {
    created.push(path.relative(cwd, filePath));
    notes.push("Import { watchup } from ./watchup and call watchup.captureError(), watchup.captureLog(), or watchup.startTrace().");
  } else {
    notes.push("watchup.js already exists, so it was left unchanged.");
  }
  if (appendEnv(cwd, { WATCHUP_API_KEY: apiKey || PLACEHOLDER_SECRET }, ".env")) created.push(".env");
  if (keyKind(apiKey) === "public") notes.push("For servers, prefer your secret wup_live_ key in WATCHUP_API_KEY.");

  return { packages: ["@watchupltd/node"], created, notes };
}

module.exports = { installNode };
